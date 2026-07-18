/**
 * auth.js — Supabase initialization, Google OAuth, and session state.
 *
 * Responsibilities:
 *   • Fetch Supabase credentials from the server's /config endpoint.
 *   • Initialize the Supabase client (using the self-hosted UMD bundle).
 *   • Handle Google OAuth sign-in and sign-out.
 *   • Expose the active session and a listener hook for other modules.
 *
 * Exports (as globals, since we're using plain <script> tags):
 *   window.Auth.getSession()        → current Supabase session (or null)
 *   window.Auth.onSessionChange(fn) → register a callback fired on auth changes
 *   window.Auth.signIn()            → trigger Google OAuth popup/redirect
 *   window.Auth.signOut()           → sign out and clear session
 */

window.Auth = (() => {
  // ── Private state ────────────────────────────────────────
  let _sb = null;           // Supabase client instance
  let _session = null;      // Current auth session
  const _listeners = [];    // Modules that want to react to auth changes

  // ── Internal helpers ─────────────────────────────────────

  /**
   * Notify all registered session-change listeners.
   * @param {object|null} session
   */
  function _notify(session) {
    _session = session;
    _listeners.forEach(fn => fn(session));
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Initialize Supabase by fetching credentials from the server.
   * Must be called once before any other Auth method.
   * @returns {Promise<void>}
   */
  async function init() {
    const config = await fetch('/config').then(r => r.json());

    // supabase is the global exposed by /vendor/supabase.js (UMD build)
    _sb = supabase.createClient(config.url, config.anonKey);

    // Restore any existing session from storage
    _session = (await _sb.auth.getSession()).data.session;

    // React to future auth state changes (login, logout, token refresh)
    _sb.auth.onAuthStateChange((_event, session) => _notify(session));

    // Fire listeners once with the initial session so the rest of the
    // app can render its correct initial state.
    _notify(_session);
  }

  /**
   * Trigger Google OAuth. Supabase will redirect back to the origin.
   */
  function signIn() {
    if (!_sb) throw new Error('Auth.init() has not been called');
    _sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  }

  /**
   * Sign the current user out.
   * @returns {Promise<void>}
   */
  async function signOut() {
    if (!_sb) return;
    await _sb.auth.signOut();
    // onAuthStateChange will fire and call _notify(null) automatically
  }

  /**
   * Return the current session object (or null if signed out).
   * @returns {object|null}
   */
  function getSession() {
    return _session;
  }

  /**
   * Register a callback that is invoked every time the session changes.
   * The callback receives the new session (or null on sign-out).
   * @param {function} fn
   */
  function onSessionChange(fn) {
    _listeners.push(fn);
  }

  return { init, signIn, signOut, getSession, onSessionChange };
})();
