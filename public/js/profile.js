/**
 * profile.js — Supabase profiles table & Storage interactions.
 *
 * Responsibilities:
 *   • Hold a reference to the initialized Supabase client.
 *   • Load a user's profile row from the `profiles` table.
 *   • Save (upsert) a profile row.
 *   • Upload a profile picture File to Supabase Storage bucket `avatars`
 *     and return the public URL.
 *   • Expose whether a profile is "complete" enough to allow matchmaking.
 *   • Cache the current profile in module state for fast reads.
 *
 * Exports (global):
 *   window.Profile.init(sbClient)
 *   window.Profile.load(userId)       → Promise<profile|null>
 *   window.Profile.save(userId, data) → Promise<{error}>
 *   window.Profile.uploadAvatar(userId, file) → Promise<string|null>  (public URL)
 *   window.Profile.get()              → cached profile object or null
 *   window.Profile.isComplete(p)      → boolean
 */

window.Profile = (() => {
  // ── Private state ─────────────────────────────────────────
  let _sb      = null;   // Supabase client (set by init)
  let _current = null;   // Cached profile for the signed-in user

  // ── Public API ────────────────────────────────────────────

  /**
   * Store the Supabase client reference.
   * Must be called once before any other method.
   * @param {object} sbClient  - Initialized Supabase JS client
   */
  function init(sbClient) {
    _sb = sbClient;
  }

  /**
   * Fetch the profile row for `userId` from the `profiles` table.
   * Caches the result internally.
   *
   * @param   {string}       userId
   * @returns {Promise<object|null>}  The profile row, or null if none exists / error.
   */
  async function load(userId) {
    if (!_sb) { console.error('[Profile] init() not called'); return null; }

    const { data, error } = await _sb
      .from('profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();   // returns null (not error) when no row found

    if (error) {
      console.error('[Profile] load error:', error.message);
      return null;
    }

    _current = data;   // may be null if first-time user
    return _current;
  }

  /**
   * Upsert a profile row.
   * Merges `data` with the required `user_id` and `updated_at` fields.
   *
   * @param   {string} userId
   * @param   {object} data   - { age, gender, profile_picture, activities, top_songs }
   * @returns {Promise<{error: object|null}>}
   */
  async function save(userId, data) {
    if (!_sb) { console.error('[Profile] init() not called'); return { error: 'not initialized' }; }

    const payload = {
      user_id:         userId,
      nickname:        data.nickname        ?? null,
      age:             data.age             ?? null,
      gender:          data.gender          ?? null,
      profile_picture: data.profile_picture ?? null,
      activities:      data.activities      ?? [],
      top_songs:       data.top_songs       ?? [],
      updated_at:      new Date().toISOString(),
    };

    const { error } = await _sb
      .from('profiles')
      .upsert(payload, { onConflict: 'user_id' });

    if (error) {
      console.error('[Profile] save error:', error.message);
    } else {
      // Keep cache in sync
      _current = { ..._current, ...payload };
    }

    return { error };
  }

  /**
   * Upload a profile picture to Supabase Storage.
   *
   * Bucket:  `avatars`  (must be created as a public bucket in the dashboard)
   * Path:    `{userId}/{timestamp}-{originalFileName}`
   *
   * @param   {string} userId
   * @param   {File}   file    - File object from <input type="file">
   * @returns {Promise<string|null>}  Public URL, or null on failure.
   */
  async function uploadAvatar(userId, file) {
    if (!_sb) { console.error('[Profile] init() not called'); return null; }

    // Build a unique, sanitised path to prevent collisions and path-traversal
    const ext      = file.name.split('.').pop().toLowerCase();
    const safeName = `${Date.now()}.${ext}`;
    const path     = `${userId}/${safeName}`;

    const { error: uploadError } = await _sb.storage
      .from('avatars')
      .upload(path, file, {
        cacheControl: '3600',
        upsert:       true,          // overwrite if a stale file is at the same path
        contentType:  file.type,
      });

    if (uploadError) {
      console.error('[Profile] avatar upload error:', uploadError.message);
      return null;
    }

    // Retrieve the CDN public URL (works for public buckets)
    const { data: urlData } = _sb.storage
      .from('avatars')
      .getPublicUrl(path);

    return urlData?.publicUrl ?? null;
  }

  /**
   * Return the currently cached profile (or null if not yet loaded).
   * @returns {object|null}
   */
  function get() {
    return _current;
  }

  /**
   * Decide whether a profile has enough data to enable matchmaking.
   * Minimum required: age (> 0), gender (non-empty), at least one activity.
   *
   * @param   {object|null} p
   * @returns {boolean}
   */
  function isComplete(p) {
    if (!p) return false;
    return (
      typeof p.age === 'number' && p.age > 0 &&
      typeof p.gender === 'string' && p.gender.trim() !== '' &&
      Array.isArray(p.activities) && p.activities.length > 0
    );
  }

  return { init, load, save, uploadAvatar, get, isComplete };
})();
