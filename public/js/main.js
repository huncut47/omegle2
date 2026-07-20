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
let socket      = null;   // Persistent Socket.IO connection (lives for the auth session)
let localStream = null;   // MediaStream from getUserMedia

// ── State machine ─────────────────────────────────────────────────────────

/**
 * The four UI states the app can be in.
 * @typedef {'camera-off'|'idle'|'searching'|'connected'} AppState
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

  // ── Camera button ────────────────────────────────────────────────────
  // Only enabled before camera has been started.
  $('start').style.display = (state === 'camera-off') ? '' : 'none';

  // ── Find Stranger button ─────────────────────────────────────────────
  // Visible (and enabled) only when idle and camera is on.
  $('find').style.display  = (state === 'idle')      ? '' : 'none';
  $('find').disabled       = false;

  // ── Next / Skip button ───────────────────────────────────────────────
  // Visible only when in an active call.
  $('next').style.display  = (state === 'connected')  ? '' : 'none';

  // ── Stop button ──────────────────────────────────────────────────────
  // Visible while searching (cancel) or connected (hang up).
  $('stop').style.display  = (state === 'searching' || state === 'connected') ? '' : 'none';

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
}

// ── Status indicator ──────────────────────────────────────────────────────

/**
 * Update the status pill label and dot color.
 * @param {string}      text
 * @param {string|null} cls   - 'on' | 'warn' | 'err' | null (grey)
 */
function setStatus(text, cls) {
  $('status').textContent = text;
  $('dot').className = 'dot' + (cls ? ' ' + cls : '');
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

  $('gate').style.display    = authed ? 'none'  : 'block';
  $('app').style.display     = authed ? 'flex'  : 'none';
  $('account').style.display = authed ? 'flex'  : 'none';

  if (authed) {
    $('who').textContent = session.user.email;
    connectSocket(session);       // opens socket if not already open
    _checkProfile(session);       // ensure profile is complete before matching
  } else {
    disconnectSocket();           // closes socket and resets state
    setState('camera-off', 'Not started');
  }
}

/**
 * Load the user's profile and open the setup modal only if the profile
 * is not yet complete (i.e. first-time users or incomplete returning users).
 * Returning users with a full profile bypass the modal entirely.
 * @param {object} session
 */
async function _checkProfile(session) {
  try {
    Profile.init(Auth.getClient());
    const profile = await Profile.load(session.user.id);

    if (!Profile.isComplete(profile)) {
      // First-time user or incomplete profile — show onboarding modal
      ProfileUI.open(session, profile, _onProfileSaved);
    }
    // else: profile is complete — silently cached, no modal

  } catch (err) {
    console.error('[main] _checkProfile threw:', err);
    ProfileUI.open(session, null, _onProfileSaved);
  }
}

/**
 * Called by ProfileUI after a successful profile save.
 * @param {object} savedProfile
 */
function _onProfileSaved(savedProfile) {
  // Nothing extra to do — the app is already rendered, profile is cached in Profile.get()
  console.log('[main] Profile saved:', savedProfile?.age, savedProfile?.gender);
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
    setState('idle', 'Stranger disconnected — find a new one?', 'warn');
  });

  // ── WebRTC signaling relay ───────────────────────────────────────────

  socket.on('offer',     async offer     => WebRTC.handleOffer(offer, socket));
  socket.on('answer',    async answer    => WebRTC.handleAnswer(answer));
  socket.on('candidate', async candidate => WebRTC.handleCandidate(candidate));
}

// ── WebRTC state → UI ─────────────────────────────────────────────────────

/**
 * Map RTCPeerConnection connection states to status pill updates.
 * Passed as a callback to WebRTC.createPeer().
 * @param {string} rtcState
 */
function onRtcStateChange(rtcState) {
  if      (rtcState === 'connected')    setState('connected', 'Connected!', 'on');
  else if (rtcState === 'connecting')   setStatus('Connecting…', 'warn');
  else if (rtcState === 'failed')       setState('idle', 'Connection failed — try again', 'err');
  else if (rtcState === 'disconnected') setState('idle', 'Connection lost — find a new stranger?', 'err');
}

// ── Button handlers ───────────────────────────────────────────────────────

/** Step 1: Request camera + mic access. Unlocks the matchmaking buttons. */
$('start').onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    setStatus('Camera blocked: ' + err.name, 'err');
    return;
  }
  const localVideo = $('local');
  localVideo.srcObject = localStream;
  localVideo.onloadedmetadata = () => {
    if (localVideo.videoWidth && localVideo.videoHeight) {
      const ratio = localVideo.videoWidth / localVideo.videoHeight;
      const card = $('local-card');
      if (card) card.style.aspectRatio = ratio.toString();
    }
  };
  $('local-overlay').style.display = 'none'; // lift the overlay off the live feed
  setState('idle', 'Camera on — click Find Stranger to begin', 'warn');
};

/**
 * Find Stranger — enter the matchmaking queue.
 * The server will either match us immediately or emit "searching".
 */
$('find').onclick = () => {
  if (!socket || !socket.connected) return;
  // Attach profile data so the server can use it for future matchmaking filters
  const profileData = Profile.get() ?? {};
  socket.emit('find-stranger', profileData);
  // Optimistically update status while awaiting server echo
  setStatus('Entering queue…', 'warn');
};

/**
 * Next / Skip — tear down the current call and immediately re-queue.
 * Leaves the current room server-side, then asks for a new stranger.
 */
$('next').onclick = () => {
  if (!socket || !socket.connected) return;
  WebRTC.closePeer();
  socket.emit('leave-room');
  const profileData = Profile.get() ?? {};
  socket.emit('find-stranger', profileData);
  setStatus('Finding next stranger…', 'warn');
};

/**
 * Stop — tear down any active call or cancel a pending search.
 * Returns to the idle state without re-queuing.
 */
$('stop').onclick = () => {
  if (!socket || !socket.connected) return;
  WebRTC.closePeer();
  socket.emit('leave-room');
  setState('idle', 'Stopped — click Find Stranger to try again', null);
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

// Edit Profile button (in header) — opens modal pre-filled with existing data
const editProfileBtn = $('edit-profile-btn');
if (editProfileBtn) {
  editProfileBtn.addEventListener('click', () => {
    const session = Auth.getSession();
    if (session) ProfileUI.open(session, Profile.get(), _onProfileSaved);
  });
}

// ── Partner Profile UI ────────────────────────────────────────────────────

const ACTIVITIES_MAP = {
  gaming: { label: 'Gaming', emoji: '🎮' },
  fitness: { label: 'Fitness', emoji: '💪' },
  movies: { label: 'Movies', emoji: '🎬' },
  anime: { label: 'Anime', emoji: '⛩️' },
  tech: { label: 'Tech', emoji: '💻' },
  travel: { label: 'Travel', emoji: '✈️' },
  music: { label: 'Music', emoji: '🎵' },
  art: { label: 'Art', emoji: '🎨' },
  cooking: { label: 'Cooking', emoji: '🍳' },
  sports: { label: 'Sports', emoji: '⚽' },
  books: { label: 'Books', emoji: '📚' },
  photography: { label: 'Photography', emoji: '📸' }
};

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

  // Activities
  const grid = $('partner-activities');
  if (grid) {
    grid.innerHTML = '';
    if (Array.isArray(p.activities)) {
      p.activities.forEach(id => {
        const act = ACTIVITIES_MAP[id];
        if (!act) return;
        const btn = document.createElement('div');
        btn.className = 'activity-pill active';
        btn.innerHTML = `<span class="pill-emoji">${act.emoji}</span><span class="pill-label">${act.label}</span>`;
        grid.appendChild(btn);
      });
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
function setProfileHover(active) {
  clearTimeout(profileHoverTimeout);
  if (active) {
    videoGridNode?.classList.add('is-active');
  } else {
    profileHoverTimeout = setTimeout(() => {
      videoGridNode?.classList.remove('is-active');
    }, 150);
  }
}

if (profileTriggerBtn) {
  profileTriggerBtn.addEventListener('mouseenter', () => setProfileHover(true));
  profileTriggerBtn.addEventListener('mouseleave', () => setProfileHover(false));
  // Allow toggling on click for touch devices
  profileTriggerBtn.addEventListener('click', () => {
    videoGridNode?.classList.toggle('is-active');
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
