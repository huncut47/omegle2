/**
 * profile-ui.js — Profile Setup modal: rendering, interactions, and save flow.
 *
 * Responsibilities:
 *   • Render the #profile-modal (defined in index.html).
 *   • Pre-populate fields from an existing profile when editing.
 *   • Handle avatar file selection → local preview → upload on save.
 *   • Toggle Tinder-style activity pills.
 *   • Collect + validate form data.
 *   • Delegate persistence to window.Profile.
 *   • Call the `onComplete` callback after a successful save.
 *
 * Exports (global):
 *   window.ProfileUI.open(session, existingProfile, onComplete)
 *   window.ProfileUI.close()
 */

window.ProfileUI = (() => {
  // ── Activity pills catalogue ───────────────────────────────
  const ACTIVITIES = [
    { id: 'gaming',      label: 'Gaming',      emoji: '🎮' },
    { id: 'fitness',     label: 'Fitness',     emoji: '💪' },
    { id: 'movies',      label: 'Movies',      emoji: '🎬' },
    { id: 'anime',       label: 'Anime',       emoji: '⛩️' },
    { id: 'tech',        label: 'Tech',        emoji: '💻' },
    { id: 'travel',      label: 'Travel',      emoji: '✈️' },
    { id: 'music',       label: 'Music',       emoji: '🎵' },
    { id: 'art',         label: 'Art',         emoji: '🎨' },
    { id: 'cooking',     label: 'Cooking',     emoji: '🍳' },
    { id: 'sports',      label: 'Sports',      emoji: '⚽' },
    { id: 'books',       label: 'Books',       emoji: '📚' },
    { id: 'photography', label: 'Photography', emoji: '📸' },
  ];

  // ── Private state ─────────────────────────────────────────
  let _session            = null;
  let _onComplete         = null;
  let _pendingFile        = null;       // File object awaiting upload on save
  let _selectedActivities = new Set();
  let _googleDisplayName  = '';         // Extracted from OAuth metadata for new users
  let _songs              = [];         // Current list of song tag strings (max 5)
  let _searchTimeout      = null;       // Debounce handle for iTunes search

  // ── DOM helpers ───────────────────────────────────────────
  const $ = id => document.getElementById(id);

  // ── Modal open / close ────────────────────────────────────

  /**
   * Show the Profile Setup modal.
   *
   * @param {object}      session          - Supabase session
   * @param {object|null} existingProfile  - Pre-loaded profile row (or null)
   * @param {function}    onComplete       - Called with the saved profile after success
   */
  function open(session, existingProfile, onComplete) {
    _session    = session;
    _onComplete = onComplete;
    _pendingFile = null;
    _selectedActivities = new Set();
    _songs = [];
    clearTimeout(_searchTimeout);
    _hideSongDropdown();

    // Extract Google display name for first-time user pre-fill.
    // Supabase surfaces it under full_name (Google) or name (generic OAuth).
    _googleDisplayName =
      session?.user?.user_metadata?.full_name ||
      session?.user?.user_metadata?.name      ||
      '';

    _render();
    _prefill(existingProfile);

    const modal = $('green-room-lobby');
    if (!modal) {
      console.error('[ProfileUI] FATAL: #green-room-lobby not found in DOM!');
      return;
    }

    const sheet = modal.querySelector('.green-room-card');

    // Force-show: bypass CSS transitions entirely so nothing can hide it
    modal.style.display       = 'flex';
    modal.style.opacity       = '1';
    modal.style.pointerEvents = 'auto';
    modal.classList.add('is-open');

    if (sheet) {
      sheet.style.animation  = 'none';
      sheet.style.opacity    = '1';
      sheet.style.transform  = 'translateY(0) scale(1)';
    }

    console.log('[ProfileUI] Lobby is now visible');

    setTimeout(() => { if (sheet) sheet.focus(); }, 80);
  }

  /**
   * Hide the modal with an exit animation.
   */
  function close() {
    const modal = $('green-room-lobby');
    modal.classList.remove('is-open');
    // Wait for CSS transition to finish before hiding
    modal.addEventListener('transitionend', () => {
      modal.style.display = 'none';
    }, { once: true });
  }

  // ── Rendering ─────────────────────────────────────────────

  /**
   * Build and inject the activity pills grid into the modal.
   * Separated from the static HTML to keep the catalogue editable here.
   */
  function _render() {
    const grid = $('activity-grid');
    if (!grid) return;
    grid.innerHTML = '';

    ACTIVITIES.forEach(({ id, label, emoji }) => {
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.id          = `activity-${id}`;
      btn.className   = 'activity-pill';
      btn.dataset.id  = id;
      btn.innerHTML   = `<span class="pill-emoji">${emoji}</span><span class="pill-label">${label}</span>`;
      btn.addEventListener('click', () => _toggleActivity(id, btn));
      grid.appendChild(btn);
    });
  }

  /**
   * Pre-fill form fields from an existing profile object.
   * @param {object|null} p
   */
  function _prefill(p) {
    // ── Nickname — prefer saved value, fall back to Google name for new users ──
    const nicknameEl = $('prof-nickname');
    if (nicknameEl) {
      nicknameEl.value = (p?.nickname) || _googleDisplayName || '';
    }

    if (!p) return;

    // Basic fields
    if (p.age)    $('prof-age').value    = p.age;
    if (p.gender) $('prof-gender').value = p.gender;

    // Avatar
    if (p.profile_picture) {
      _setAvatarPreview(p.profile_picture);
    }

    // Activities
    if (Array.isArray(p.activities)) {
      p.activities.forEach(id => {
        _selectedActivities.add(id);
        const btn = $(`activity-${id}`);
        if (btn) btn.classList.add('active');
      });
    }

    // Top songs — parse JSONB objects from Supabase and render track rows
    if (Array.isArray(p.top_songs)) {
      _songs = p.top_songs
        .slice(0, 5)
        .filter(Boolean)
        .map(item => {
          // JSONB[] gives us objects directly; guard against legacy text strings
          if (item && typeof item === 'object') return item;
          // Legacy plain-string row (TEXT[] era) — wrap it gracefully
          return { title: String(item), artist: '', cover: '' };
        });
      _syncSongUI();
    }
  }

  // ── Song tag-input ────────────────────────────────────────

  const SONG_MAX = 5;

  /**
   * Rebuild the vertical track list in #song-selected-list
   * and sync the counter + search bar disabled state.
   */
  function _syncSongUI() {
    const list      = $('song-selected-list');
    const box       = $('song-tag-box');
    const input     = $('song-tag-input');
    const counter   = $('song-tag-count');
    const counterEl = document.querySelector('.song-tag-counter');
    if (!list || !input) return;

    // Rebuild list from scratch
    list.innerHTML = '';

    _songs.forEach((song, idx) => {
      const row = document.createElement('div');
      row.className = 'song-row-card';
      row.setAttribute('role', 'listitem');
      row.style.animationDelay = `${idx * 35}ms`;

      // ── Track number ──
      const num = document.createElement('span');
      num.className   = 'song-row-num';
      num.textContent = idx + 1;

      // ── Album art ──
      const img = document.createElement('img');
      img.className = 'song-row-art';
      img.src       = song.cover || '';
      img.alt       = song.title || '';
      img.width     = 42;
      img.height    = 42;
      img.loading   = 'lazy';

      // ── Info block ──
      const info = document.createElement('div');
      info.className = 'song-row-info';

      const titleEl = document.createElement('div');
      titleEl.className   = 'song-row-title';
      titleEl.textContent = song.title || '';

      const artistEl = document.createElement('div');
      artistEl.className   = 'song-row-artist';
      artistEl.textContent = song.artist || '';

      info.appendChild(titleEl);
      info.appendChild(artistEl);

      // ── Remove button (trash icon) ──
      const removeBtn = document.createElement('button');
      removeBtn.type      = 'button';
      removeBtn.className = 'song-row-remove';
      removeBtn.setAttribute('aria-label', `Remove ${song.title}`);
      removeBtn.innerHTML =
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2.2"
              stroke-linecap="round" stroke-linejoin="round">
           <polyline points="3 6 5 6 21 6"/>
           <path d="M19 6l-1 14H6L5 6"/>
           <path d="M10 11v6"/><path d="M14 11v6"/>
           <path d="M9 6V4h6v2"/>
         </svg>`;
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _removeSongTag(idx);
      });

      row.appendChild(num);
      row.appendChild(img);
      row.appendChild(info);
      row.appendChild(removeBtn);
      list.appendChild(row);
    });

    // Update counter
    if (counter) counter.textContent = _songs.length;
    if (counterEl) counterEl.classList.toggle('is-full', _songs.length >= SONG_MAX);

    // Lock search bar when cap is reached
    const full = _songs.length >= SONG_MAX;
    input.disabled = full;
    if (box) box.dataset.full = String(full);
    input.placeholder = full ? '' : 'Search for a song\u2026';
  }

  /**
   * Add a song object to the list.
   * Only called from _renderDropdown() mousedown — never from free text.
   * @param {{ title: string, artist: string, cover: string }} songObj
   */
  function _addSongTag(songObj) {
    if (!songObj?.title || _songs.length >= SONG_MAX) return;
    // Deduplicate by title + artist
    const isDupe = _songs.some(
      s => s.title === songObj.title && s.artist === songObj.artist
    );
    if (isDupe) return;
    _songs.push(songObj);
    _syncSongUI();
  }

  /**
   * Remove the song tag at position `idx` from the list.
   * @param {number} idx
   */
  function _removeSongTag(idx) {
    _songs.splice(idx, 1);
    _syncSongUI();
    // Return focus to the input so the user can keep typing
    const input = $('song-tag-input');
    if (input) { input.disabled = false; input.focus(); }
  }

  // ── iTunes autocomplete ──────────────────────────────────────

  const ITUNES_DEBOUNCE_MS = 350;
  const ITUNES_FETCH_LIMIT = 7;   // fetch a few extra; we filter already-added songs

  /** Hide the dropdown panel without touching its contents. */
  function _hideSongDropdown() {
    const el = $('song-dropdown');
    if (el) el.style.display = 'none';
  }

  /**
   * Show the dropdown with a single centred message (loading / no results / error).
   * @param {string} msg
   */
  function _showDropdownMsg(msg) {
    const el = $('song-dropdown');
    if (!el) return;
    el.innerHTML = `<div class="song-dropdown-msg">${msg}</div>`;
    el.style.display = 'block';
  }

  /**
   * Render a list of iTunes track results into the dropdown.
   * Excludes tracks the user has already added.
   * @param {Array} results  - iTunes API result objects
   */
  function _renderDropdown(results) {
    const el = $('song-dropdown');
    if (!el) return;

    // Filter out songs the user has already added
    const filtered = results.filter(r =>
      !_songs.some(s => s.title === r.trackName && s.artist === r.artistName)
    );

    if (filtered.length === 0) {
      _showDropdownMsg('No results found.');
      return;
    }

    el.innerHTML = '';
    el.style.display = 'block';

    filtered.forEach(track => {
      const label = `${track.artistName} \u2014 ${track.trackName}`;

      const item = document.createElement('div');
      item.className = 'song-dropdown-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-label', label);

      // Album artwork
      const img = document.createElement('img');
      img.className   = 'song-dropdown-artwork';
      img.src         = track.artworkUrl60 || '';
      img.alt         = '';
      img.loading     = 'lazy';
      img.width       = 38;
      img.height      = 38;

      // Text block
      const info = document.createElement('div');
      info.className  = 'song-dropdown-info';

      const trackEl = document.createElement('div');
      trackEl.className   = 'song-dropdown-track';
      trackEl.textContent = track.trackName;

      const artistEl = document.createElement('div');
      artistEl.className   = 'song-dropdown-artist';
      artistEl.textContent = track.artistName;

      info.appendChild(trackEl);
      info.appendChild(artistEl);
      item.appendChild(img);
      item.appendChild(info);

      /*
       * Use mousedown (not click) so the event fires BEFORE the input's blur
       * event hides the dropdown. e.preventDefault() keeps focus on the input.
       */
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        _addSongTag({
          title:  track.trackName,
          artist: track.artistName,
          // Prefer higher-res art (100px) but fall back to 60px thumbnail
          cover:  (track.artworkUrl100 || track.artworkUrl60 || '').replace('100x100', '200x200'),
        });
        const input = $('song-tag-input');
        if (input) { input.value = ''; }
        _hideSongDropdown();
      });

      el.appendChild(item);
    });
  }

  /**
   * Fetch songs from the iTunes Search API and render results.
   * @param {string} query
   */
  async function _searchITunes(query) {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&media=music&limit=${ITUNES_FETCH_LIMIT}`;
      const res  = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      _renderDropdown(data.results || []);
    } catch (_err) {
      _showDropdownMsg('Search unavailable — check your connection.');
    }
  }

  /**
   * Bind all keyboard and pointer events that drive the autocomplete.
   * Called once during bootstrap from _bindEvents().
   *
   * Keyboard contract:
   *   • Any printable character  → debounced iTunes search
   *   • Backspace (empty input)  → remove last tag
   *   • Escape                   → close dropdown
   *   • Enter                    → suppressed (selection only via click)
   */
  function _bindSongAutocomplete() {
    const box   = $('song-tag-box');
    const input = $('song-tag-input');
    if (!box || !input) return;

    // Focus the input when clicking anywhere on the box
    box.addEventListener('click', () => {
      if (!input.disabled) input.focus();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        _hideSongDropdown();
      } else if (e.key === 'Enter') {
        // Prevent accidental form submit; selection is mouse/touch only
        e.preventDefault();
      } else if (e.key === 'Backspace' && input.value === '' && _songs.length > 0) {
        _removeSongTag(_songs.length - 1);
      }
    });

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearTimeout(_searchTimeout);

      if (!q) { _hideSongDropdown(); return; }

      // Show loading state immediately, then debounce the network call
      _showDropdownMsg('Searching\u2026');
      _searchTimeout = setTimeout(() => _searchITunes(q), ITUNES_DEBOUNCE_MS);
    });

    // Hide dropdown on blur — setTimeout gives mousedown on an item time to fire first
    input.addEventListener('blur', () => {
      setTimeout(_hideSongDropdown, 180);
    });
  }

  // ── Activity pills ────────────────────────────────────────

  function _toggleActivity(id, btn) {
    if (_selectedActivities.has(id)) {
      _selectedActivities.delete(id);
      btn.classList.remove('active');
    } else {
      _selectedActivities.add(id);
      btn.classList.add('active');
    }
  }

  // ── Avatar handling ───────────────────────────────────────

  /**
   * Set the avatar preview image src.
   * @param {string} src  - URL or object URL
   */
  function _setAvatarPreview(src) {
    const img = $('avatar-preview');
    if (!img) return;
    img.src = src;
    img.style.display = 'block';
    $('avatar-placeholder').style.display = 'none';
  }

  /**
   * Wire up the hidden file input and the clickable avatar circle.
   * Called once after DOM is ready.
   */
  function _bindAvatarInput() {
    const circle = $('avatar-circle');
    const fileIn = $('avatar-file-input');
    if (!circle || !fileIn) return;

    circle.addEventListener('click', () => fileIn.click());

    fileIn.addEventListener('change', () => {
      const file = fileIn.files[0];
      if (!file) return;
      _pendingFile = file;
      // Show local preview immediately — no upload yet
      const objectUrl = URL.createObjectURL(file);
      _setAvatarPreview(objectUrl);
    });
  }

  // ── Save flow ─────────────────────────────────────────────

  /**
   * Validate, upload avatar if needed, then upsert profile.
   */
  async function _handleSave() {
    const userId = _session?.user?.id;
    if (!userId) {
      _showError('You must be signed in to save your profile.');
      return;
    }

    // ── Collect form values ────────────────────────────────
    const nickname = $('prof-nickname')?.value.trim() || null;  // optional
    const age      = parseInt($('prof-age').value, 10);
    const gender   = $('prof-gender').value.trim();
    const activities = Array.from(_selectedActivities);
    const topSongs = _songs.slice();   // snapshot of the tag array

    // ── Validate ───────────────────────────────────────────
    const errors = [];
    if (!age || age < 13 || age > 120) errors.push('Please enter a valid age (13–120).');
    if (!gender)                        errors.push('Please select your gender.');
    if (activities.length === 0)        errors.push('Pick at least one activity.');

    if (errors.length > 0) {
      _showError(errors[0]);
      return;
    }

    _setLoading(true);
    _clearError();

    // ── Upload avatar if a new file was picked ─────────────
    let profilePictureUrl = Profile.get()?.profile_picture ?? null;

    if (_pendingFile) {
      const uploadedUrl = await Profile.uploadAvatar(userId, _pendingFile);
      if (uploadedUrl) {
        profilePictureUrl = uploadedUrl;
      } else {
        _showError('Avatar upload failed. Your profile was not saved — please try again.');
        _setLoading(false);
        return;
      }
    }

    // ── Persist ────────────────────────────────────────────
    const { error } = await Profile.save(userId, {
      nickname,
      age,
      gender,
      profile_picture: profilePictureUrl,
      activities,
      top_songs: topSongs,
    });

    _setLoading(false);

    if (error) {
      _showError('Could not save your profile. Please try again.');
      return;
    }

    // Success — notify caller and close
    if (_onComplete) _onComplete(Profile.get());
    close();
  }

  // ── UI helpers ────────────────────────────────────────────

  function _setLoading(on) {
    const btn = $('prof-save-btn');
    if (!btn) return;
    btn.disabled = on;
    btn.textContent = on ? 'Entering Queue…' : 'Find a Stranger';
  }

  function _showError(msg) {
    const el = $('prof-error');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
  }

  function _clearError() {
    const el = $('prof-error');
    if (!el) return;
    el.textContent = '';
    el.style.display = 'none';
  }

  // ── Bootstrap — bind events once DOM is loaded ────────────
  function _bindEvents() {
    _bindAvatarInput();
    _bindSongAutocomplete();

    const saveBtn = $('prof-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', _handleSave);
  }

  // Defer binding until the DOM is fully parsed
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bindEvents);
  } else {
    _bindEvents();
  }

  return { open, close };
})();
