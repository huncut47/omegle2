/**
 * main.js — App entry point (matchmaking edition).
 *
 * Responsibilities:
 *   • Initialize Auth and render auth-gated UI.
 *   • Check / prompt for a complete user profile after sign-in.
 *   • Manage a single persistent Socket.IO connection (connected on auth,
 *     disconnected on sign-out — NOT per room-join as before).
 *   • Drive a clear 4-state UI machine: camera-off → idle → searching → connected.
 *   • Wire "Find Stranger", "Next / Skip", and "Stop" buttons to the correct
 *     socket events and WebRTC teardown calls.
 *   • Bridge all Socket.IO signaling events to the WebRTC module.
 *
 * State machine:
 *   camera-off ──[Start camera]──► idle
 *   idle        ──[Find Stranger]─► searching
 *   searching   ──[matched]───────► connected
 *   searching   ──[Stop]──────────► idle
 *   connected   ──[Next / Skip]───► searching
 *   connected   ──[Stop]──────────► idle
 *   connected   ──[peer-left]─────► idle
 *
 * Depends on (loaded before this file):
 *   • /vendor/supabase.js      → global `supabase`
 *   • /socket.io/socket.io.js  → global `io`
 *   • /js/auth.js              → global `Auth`
 *   • /js/webrtc.js            → global `WebRTC`
 *   • /js/profile.js           → global `Profile`
 *   • /js/profile-ui.js        → global `ProfileUI`
 */

// ── Shorthand helper ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Module-level state ────────────────────────────────────────────────────
let socket = null;   // Persistent Socket.IO connection (lives for the auth session)
let localStream = null;   // MediaStream from getUserMedia

// ── State machine ─────────────────────────────────────────────────────────

/**
 * The UI states the app can be in.
 * @typedef {'camera-off'|'lobby'|'idle'|'searching'|'connected'|'stopped'} AppState
 */

/** @type {AppState} */
let appState = 'camera-off';

/**
 * Transition to a new UI state.
 * Centralises all button show/hide/enable logic so no handler has to
 * manually manage each button's state individually.
 *
 * @param {AppState} state
 * @param {string}        [statusText]  - Optional status pill label
 * @param {string|null}   [statusCls]   - 'on' | 'warn' | 'err' | null
 */
function setState(state, statusText, statusCls) {
  appState = state;

  // ── Status pill ──────────────────────────────────────────────────────
  if (statusText !== undefined) setStatus(statusText, statusCls ?? null);

  // ── Camera & Find buttons ────────────────────────────────────────────
  if ($('start')) $('start').style.display = 'none'; // Obsolete, camera auto-starts
  if ($('find')) {
    $('find').style.display = (state === 'idle' || state === 'stopped') ? '' : 'none';
    // Ensure button is fully interactive
    $('find').disabled = false;
    $('find').classList.remove('disabled');
    $('find').style.opacity = '1';
    $('find').style.pointerEvents = 'auto';
  }

  // ── Next / Skip button ───────────────────────────────────────────────
  // Visible only when in an active call.
  $('next').style.display = (state === 'connected') ? '' : 'none';

  // ── Stop button ──────────────────────────────────────────────────────
  // Visible while searching (cancel) or connected (hang up).
  $('stop').style.display = (state === 'searching' || state === 'connected') ? '' : 'none';

  // ── Remote placeholder overlay ───────────────────────────────────────
  const placeholder = $('remote-placeholder');
  if (state === 'searching') {
    placeholder.style.display = 'flex';
    $('placeholder-text').textContent = 'Searching for a stranger…';
  } else if (state === 'idle' || state === 'camera-off') {
    placeholder.style.display = 'flex';
    $('placeholder-text').textContent = 'Waiting for stranger…';
  } else {
    // connected — hide overlay so the remote video shows through
    placeholder.style.display = 'none';
  }

  // ── Partner Profile Overlay ──────────────────────────────────────────
  const videoGrid = $('video-grid');
  const partnerContainer = $('partner-profile-container');
  if (state === 'connected') {
    videoGrid?.classList.remove('with-sidebar');
    if (partnerContainer) partnerContainer.style.display = 'block';
  } else {
    videoGrid?.classList.remove('with-sidebar');
    if (partnerContainer) partnerContainer.style.display = 'none';
    if (typeof resetPartnerProfile === 'function') resetPartnerProfile();
  }

  // ── Chat Container Visibility ────────────────────────────────────────────
  const chatContainer = $('chat-container');
  if (chatContainer) {
    if (state === 'connected') {
      chatContainer.style.display = 'flex';
    } else {
      chatContainer.style.display = 'none';
      const chatMessages = $('chat-messages');
      if (chatMessages) chatMessages.innerHTML = ''; // Clear chat on disconnect
    }
  }
}

// ── Status indicator ──────────────────────────────────────────────────────

/**
 * Update the status pill label and dot color.
 * @param {string}      text
 * @param {string|null} cls   - 'on' | 'warn' | 'err' | null (grey)
 */
function setStatus(text, cls) {
  const statusEl = $('status');
  if (statusEl) statusEl.textContent = text;

  const dotEl = $('dot');
  const dotClass = 'dot' + (cls ? ' ' + cls : '');
  if (dotEl) dotEl.className = dotClass;
}

// ── Auth-gated UI rendering ───────────────────────────────────────────────

/**
 * Show or hide the auth gate / main app based on the current session.
 * Also manages the Socket.IO connection lifecycle: one socket per auth session.
 *
 * @param {object|null} session - Supabase session, or null if signed out
 */
function renderAuth(session) {
  const authed = !!session;

  $('gate').style.display = authed ? 'none' : 'block';
  $('app').style.display = authed ? 'flex' : 'none';
  $('account').style.display = authed ? 'flex' : 'none';

  if (authed) {
    $('who').textContent = session.user.email;
    connectSocket(session);

    // Only enter the lobby on initial login, not on every auth state refresh
    if (appState === 'camera-off') {
      enterLobby(session);
    }
  } else {
    disconnectSocket();
    setState('camera-off', 'Not started');
  }
}

/**
 * Initialize the Green Room Lobby.
 * Fetches the user profile, requests camera, and populates device dropdowns.
 */
async function enterLobby(session) {
  setState('lobby'); // Prevents re-entry and hides dashboard buttons

  try {
    Profile.init(Auth.getClient());
    const profile = await Profile.load(session.user.id);
    ProfileUI.open(session, profile, _onLobbySubmit);
  } catch (err) {
    console.error('[main] enterLobby profile load threw:', err);
    ProfileUI.open(session, null, _onLobbySubmit);
  }

  // Auto-start camera in the lobby
  console.log("[WebRTC] Step 1: Requesting temporary stream for permissions...");
  let tempStream = null;
  try {
    tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    console.log("[WebRTC] Step 1 Success: Temporary stream acquired. Permissions granted.");
  } catch (err) {
    console.warn("[WebRTC] Step 1 Failed (permission blocked or no gesture). Will enumerate without labels.", err);
  }

  try {
    console.log("[WebRTC] Step 2: Enumerating devices...");
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log(`[WebRTC] Step 2 Success: Found ${devices.length} devices.`, devices);

    console.log("[WebRTC] Step 3: Fetching DOM Select elements...");
    const camSelect = document.getElementById('camera-select');
    const micSelect = document.getElementById('mic-select');

    if (!camSelect || !micSelect) {
      console.error("CRITICAL: Dropdown elements 'camera-select' or 'mic-select' not found in DOM!");
    } else {
      console.log("[WebRTC] DOM elements found. Populating dropdowns...");
      camSelect.innerHTML = '';
      micSelect.innerHTML = '';

      let camCount = 0;
      let micCount = 0;

      devices.forEach(d => {
        if (d.kind === 'videoinput') {
          camCount++;
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.text = d.label || `Camera ${camCount}`;
          camSelect.appendChild(opt);
        } else if (d.kind === 'audioinput') {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.text = d.label || `Microphone ${micSelect.length + 1}`;
          micSelect.appendChild(opt);
        }
      });

      // Switch device listener
      const switchDevice = async () => {
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        localStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: camSelect.value } },
          audio: { deviceId: { exact: micSelect.value } }
        });
        _applyLocalStream();
      };
      camSelect.onchange = switchDevice;
      micSelect.onchange = switchDevice;
    }

    console.log("[WebRTC] Step 4: Stopping temporary stream tracks to disable camera light...");
    tempStream.getTracks().forEach(t => t.stop());
    console.log("[WebRTC] Temporary stream stopped successfully.");

  } catch (err) {
    console.error('[WebRTC] FATAL ERROR during initialization block:', err);
    setStatus('Camera blocked: ' + err.name, 'err');
  }
}

/**
 * Apply the current localStream to all relevant video elements.
 */
function _applyLocalStream() {
  const bg = $('green-room-bg');
  const preview = $('green-room-preview');
  const localVideo = $('local');
  if (bg) bg.srcObject = localStream;
  if (preview) preview.srcObject = localStream;
  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.onloadedmetadata = () => {
      if (localVideo.videoWidth && localVideo.videoHeight) {
        const ratio = localVideo.videoWidth / localVideo.videoHeight;
        const card = $('local-card');
        if (card) card.style.aspectRatio = ratio.toString();
      }
    };
  }
  const overlay = $('local-overlay');
  if (overlay) overlay.style.display = 'none';
}

/**
 * Queue up for a new stranger. Shared by the Green Room Lobby and the bottom control bar.
 * @param {object} [profileDataOverride] - Optional profile data to use instead of the cached one
 * @param {string} [statusText='Entering queue…'] - Optional status text to show
 */
function queueForStranger(profileDataOverride, statusText = 'Entering queue…') {
  if (!socket || !socket.connected) return;

  // Ensure any previous peer connection is completely wiped before re-queuing
  WebRTC.closePeer();
  socket.emit('leave-room');
  if ($('remote')) $('remote').srcObject = null;

  const profileData = profileDataOverride || Profile.get() || {};
  socket.emit('find-stranger', profileData);

  setStatus(statusText, 'warn');
  setState('searching');
}

/**
 * Called by ProfileUI when "Find a Stranger" is clicked and profile is saved.
 */
function _onLobbySubmit(savedProfile) {
  queueForStranger(savedProfile);
}

// ── Socket lifecycle ──────────────────────────────────────────────────────

/**
 * Open a single persistent, JWT-authenticated Socket.IO connection.
 * Idempotent — does nothing if a socket is already connected.
 *
 * Key design change vs. the previous version: the socket is opened ONCE
 * when the user authenticates and stays open for the entire session.
 * Room changes use `leave-room` / `find-stranger` events rather than
 * socket reconnects.
 *
 * @param {object} session - Supabase session containing the access token
 */
function connectSocket(session) {
  if (socket && socket.connected) return;  // Already connected

  socket = io({ auth: { token: session.access_token } });
  bindSocketEvents();
}

/**
 * Close the socket and reset module state.
 * Called on sign-out or if we need to fully tear down.
 */
function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  WebRTC.closePeer();
}

/**
 * Register all socket event handlers.
 * Called once after the socket is created. Handlers are stable for the
 * lifetime of the socket connection.
 */
function bindSocketEvents() {

  // ── Auth / connection errors ─────────────────────────────────────────
  socket.on('connect_error', () => {
    setStatus('Connection error — please sign in again', 'err');
    setState('idle');
  });

  // ── Matchmaking ──────────────────────────────────────────────────────

  /** Server confirmed this socket is now in the waiting queue. */
  socket.on('searching', () => {
    setState('searching', 'Searching for a stranger…', 'warn');
  });

  /**
   * Server matched us with a partner.
   * `initiator` determines which peer creates the WebRTC offer.
   */
  socket.on('start', async ({ initiator, partnerProfile }) => {
    setState('connected', 'Connecting…', 'warn');
    if (typeof renderPartnerProfile === 'function') renderPartnerProfile(partnerProfile);
    await WebRTC.createPeer(localStream, socket, initiator, onRtcStateChange);
  });

  // ── Peer lifecycle ───────────────────────────────────────────────────

  socket.on('peer-left', () => {
    WebRTC.closePeer();
    if ($('remote')) $('remote').srcObject = null;
    setState('idle', 'Stranger disconnected — click Find Stranger to try again', 'warn');
  });

  // ── WebRTC signaling relay ───────────────────────────────────────────

  socket.on('offer', async offer => WebRTC.handleOffer(offer, socket));
  socket.on('answer', async answer => WebRTC.handleAnswer(answer));
  socket.on('candidate', async candidate => WebRTC.handleCandidate(candidate));

  // ── Chat relay ───────────────────────────────────────────────────────
  socket.on('chat-message', text => {
    if (typeof appendChatMessage === 'function') {
      appendChatMessage(text, false);
    }
  });
}

// ── WebRTC state → UI ─────────────────────────────────────────────────────

/**
 * Map RTCPeerConnection connection states to status pill updates.
 * Passed as a callback to WebRTC.createPeer().
 * @param {string} rtcState
 */
function onRtcStateChange(rtcState) {
  if (rtcState === 'connected') setState('connected', 'Connected!', 'on');
  else if (rtcState === 'connecting') setStatus('Connecting…', 'warn');
  else if (rtcState === 'failed') setState('idle', 'Connection failed — try again', 'err');
  else if (rtcState === 'disconnected') setState('idle', 'Connection lost — find a new stranger?', 'err');
}

// ── Button handlers ───────────────────────────────────────────────────────

/**
 * Find Stranger — enter the matchmaking queue directly from the dashboard.
 */
if ($('find')) {
  $('find').onclick = () => queueForStranger();
}

/**
 * Next / Skip — tear down the current call and immediately re-queue.
 * Leaves the current room server-side, then asks for a new stranger.
 */
$('next').onclick = () => queueForStranger(null, 'Finding next stranger…');

/**
 * Stop — tear down any active call or cancel a pending search.
 * Returns to the stopped state without re-queuing.
 */
$('stop').onclick = () => {
  if (!socket || !socket.connected) return;
  WebRTC.closePeer();
  socket.emit('leave-room');
  if ($('remote')) $('remote').srcObject = null;
  setState('stopped', 'Stopped — click Find Stranger to try again', null);
};

// ── Auth buttons ──────────────────────────────────────────────────────────

$('login').onclick = () => Auth.signIn();

$('logout').onclick = async () => {
  // Stop any active call and leave the room before signing out
  if (socket && socket.connected) {
    WebRTC.closePeer();
    socket.emit('leave-room');
  }
  disconnectSocket();
  await Auth.signOut();
};

// Edit Profile button (in header) — opens lobby again
const editProfileBtn = $('edit-profile-btn');
if (editProfileBtn) {
  editProfileBtn.addEventListener('click', () => {
    const session = Auth.getSession();
    if (session) ProfileUI.open(session, Profile.get(), _onLobbySubmit);
  });
}

// ── Partner Profile UI ────────────────────────────────────────────────────

function renderPartnerProfile(p) {
  if (!p) p = {};

  // Basic info
  const nameEl = $('partner-name');
  if (nameEl) nameEl.textContent = p.nickname || 'Stranger';

  const remoteVidLabel = $('remote-vid-label');
  if (remoteVidLabel) remoteVidLabel.textContent = p.nickname || 'Stranger';

  const demoParts = [];
  if (p.age) demoParts.push(p.age);
  if (p.gender) demoParts.push(p.gender.charAt(0).toUpperCase() + p.gender.slice(1));
  const demoEl = $('partner-demographics');
  if (demoEl) demoEl.textContent = demoParts.length > 0 ? demoParts.join(' • ') : 'Unknown';

  // Avatar
  const avatarImg = $('partner-avatar');
  const avatarFallback = $('partner-avatar-fallback');
  if (avatarImg && avatarFallback) {
    if (p.profile_picture) {
      avatarImg.src = p.profile_picture;
      avatarImg.style.display = 'block';
      avatarFallback.style.display = 'none';
    } else {
      avatarImg.src = '';
      avatarImg.style.display = 'none';
      avatarFallback.style.display = 'flex';
    }
  }

  // Interests
  const grid = $('partner-activities');
  if (grid) {
    grid.innerHTML = '';

    // Get local user's selected interests for matching
    const localProfile = typeof Profile !== 'undefined' ? (Profile.get() || {}) : {};
    const localInterests = Array.isArray(localProfile.activities) ? localProfile.activities : [];

    if (Array.isArray(p.activities) && p.activities.length > 0) {
      p.activities.forEach(interestName => {
        if (!interestName) return;
        const isShared = localInterests.includes(interestName);

        const pill = document.createElement('div');
        pill.className = 'stranger-interest-pill';
        if (isShared) pill.classList.add('shared-interest');
        pill.textContent = interestName;

        grid.appendChild(pill);
      });
    } else {
      // Empty state
      const emptyText = document.createElement('div');
      emptyText.style.fontSize = '12px';
      emptyText.style.color = 'var(--text-4)';
      emptyText.textContent = 'No interests specified';
      grid.appendChild(emptyText);
    }
  }

  // Songs
  const songList = $('partner-songs');
  if (songList) {
    songList.innerHTML = '';
    if (Array.isArray(p.top_songs)) {
      const songs = p.top_songs
        .slice(0, 5)
        .filter(Boolean)
        .map(item => (typeof item === 'object' ? item : { title: String(item), artist: '', cover: '' }));

      songs.forEach((song, idx) => {
        const row = document.createElement('div');
        row.className = 'song-row-card';
        row.style.animationDelay = `${idx * 35}ms`;

        const num = document.createElement('span');
        num.className = 'song-row-num';
        num.textContent = idx + 1;

        const img = document.createElement('img');
        img.className = 'song-row-art';
        img.src = song.cover || '';
        img.alt = song.title || '';
        img.width = 42;
        img.height = 42;

        const info = document.createElement('div');
        info.className = 'song-row-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'song-row-title';
        titleEl.textContent = song.title || '';

        const artistEl = document.createElement('div');
        artistEl.className = 'song-row-artist';
        artistEl.textContent = song.artist || '';

        info.appendChild(titleEl);
        info.appendChild(artistEl);
        row.appendChild(num);
        row.appendChild(img);
        row.appendChild(info);
        songList.appendChild(row);
      });
    }
  }
}

function resetPartnerProfile() {
  const nameEl = $('partner-name');
  if (nameEl) nameEl.textContent = 'Finding a new match...';

  const remoteVidLabel = $('remote-vid-label');
  if (remoteVidLabel) remoteVidLabel.textContent = 'Stranger';
  const demoEl = $('partner-demographics');
  if (demoEl) demoEl.textContent = '';
  const avatarImg = $('partner-avatar');
  if (avatarImg) avatarImg.style.display = 'none';
  const avatarFallback = $('partner-avatar-fallback');
  if (avatarFallback) avatarFallback.style.display = 'flex';
  const grid = $('partner-activities');
  if (grid) grid.innerHTML = '';
  const songList = $('partner-songs');
  if (songList) songList.innerHTML = '';
}

// ── Partner Profile Hover Logic ───────────────────────────────────────────
const videoGridNode = $('video-grid');
const profileTriggerBtn = $('partner-profile-btn');
const profilePanelNode = $('partner-profile-panel');

let profileHoverTimeout;
let profileUnlockTimeout;
function setProfileHover(active) {
  clearTimeout(profileHoverTimeout);
  const container = $('partner-profile-container');
  if (active) {
    clearTimeout(profileUnlockTimeout);
    if (container && !videoGridNode?.classList.contains('is-active')) {
      const rect = container.getBoundingClientRect();
      container.style.position = 'fixed';
      container.style.left = rect.left + 'px';
      container.style.top = rect.top + 'px';
      container.style.bottom = 'auto';
      container.style.right = 'auto';
    }
    videoGridNode?.classList.add('is-active');
  } else {
    profileHoverTimeout = setTimeout(() => {
      videoGridNode?.classList.remove('is-active');
      profileUnlockTimeout = setTimeout(() => {
        if (container && !videoGridNode?.classList.contains('is-active')) {
          container.style.position = '';
          container.style.left = '';
          container.style.top = '';
          container.style.bottom = '';
          container.style.right = '';
        }
      }, 500);
    }, 150);
  }
}

if (profileTriggerBtn) {
  profileTriggerBtn.addEventListener('mouseenter', () => setProfileHover(true));
  profileTriggerBtn.addEventListener('mouseleave', () => setProfileHover(false));
  // Allow toggling on click for touch devices
  profileTriggerBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const isActive = videoGridNode?.classList.contains('is-active');
    setProfileHover(!isActive);
  });
}
if (profilePanelNode) {
  profilePanelNode.addEventListener('mouseenter', () => setProfileHover(true));
  profilePanelNode.addEventListener('mouseleave', () => setProfileHover(false));
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

/**
 * Single app entry point.
 * Registers the auth listener before calling init() so the initial session
 * is handled by renderAuth() rather than a separate code path.
 */
async function bootstrap() {
  Auth.onSessionChange(renderAuth);
  await Auth.init();

  // Wire the gate-screen "Preview profile setup" button.
  const previewBtn = $('gate-preview-profile');
  if (previewBtn) {
    previewBtn.addEventListener('click', () => {
      ProfileUI.open(null, null, null);
    });
  }
}

// Expose a console helper for quick testing:
// Open your browser DevTools and type: showProfileModal()
window.showProfileModal = () => {
  const session = Auth.getSession();
  ProfileUI.open(session, Profile.get(), _onProfileSaved);
};

bootstrap();

// ── Chat Logic ──────────────────────────────────────────────────────────────
const chatContainerDom = document.getElementById('chat-container');
const chatInputDom = document.getElementById('chat-input');
const chatMessagesDom = document.getElementById('chat-messages');

if (chatContainerDom && chatInputDom && chatMessagesDom) {
  // Expand chat when clicking anywhere inside the chat container
  document.addEventListener('click', (e) => {
    if (chatContainerDom.contains(e.target)) {
      chatContainerDom.classList.add('active');
    } else {
      chatContainerDom.classList.remove('active');
    }
  });

  let chatCooldownTimeout = null;
  let chatCooldownInterval = null;
  let isChatCooldown = false;

  chatInputDom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      
      if (isChatCooldown) return;
      
      const text = chatInputDom.value.trim();
      if (!text) return;

      chatInputDom.value = '';
      if (socket && socket.connected) {
        socket.emit('chat-message', text);
      }
      appendChatMessage(text, true);
      
      // Start cooldown
      isChatCooldown = true;
      chatInputDom.classList.add('cooldown');
      let secondsLeft = 3;
      chatInputDom.placeholder = `Wait ${secondsLeft}s...`;

      chatCooldownInterval = setInterval(() => {
        secondsLeft--;
        if (secondsLeft > 0) {
          chatInputDom.placeholder = `Wait ${secondsLeft}s...`;
        }
      }, 1000);

      chatCooldownTimeout = setTimeout(() => {
        clearInterval(chatCooldownInterval);
        isChatCooldown = false;
        chatInputDom.classList.remove('cooldown');
        chatInputDom.placeholder = 'Type a message...';
      }, 3000);
    }
  });
}

function appendChatMessage(text, isMe) {
  const chatMessages = document.getElementById('chat-messages');
  if (!chatMessages) return;
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-message ' + (isMe ? 'me' : 'stranger');
  msgEl.textContent = text;
  chatMessages.appendChild(msgEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
