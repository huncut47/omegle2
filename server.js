require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { randomUUID } = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase admin client (server-side only, never exposed to browsers) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Matchmaking queue ────────────────────────────────────────────────────
//
// An ordered array of socket IDs waiting for a match.
// Invariant: every ID in this array MUST belong to a currently-connected socket.
// Any code path that could invalidate this (disconnect, re-queue) calls
// removeFromQueue() first to enforce the invariant.
//
const waitingQueue = [];

/**
 * Remove a socket ID from the waiting queue.
 * Safe to call even if the ID is not present.
 * @param {string} socketId
 */
function removeFromQueue(socketId) {
  const idx = waitingQueue.indexOf(socketId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

// ── Routes ───────────────────────────────────────────────────────────────

/**
 * /config — Deliver public Supabase credentials to the frontend.
 * The anon key is designed to be public (RLS enforces row-level permissions).
 */
app.get('/config', (_req, res) => {
  res.json({
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
  });
});

/**
 * /vendor — Self-hosted Supabase UMD bundle. No external CDN dependency.
 */
app.use(
  '/vendor',
  express.static(path.join(__dirname, 'node_modules/@supabase/supabase-js/dist/umd')),
);

/**
 * Static assets — ONLY the /public directory is served.
 * server.js, package.json, Dockerfile etc. are never reachable by a browser.
 */
app.use(express.static(path.join(__dirname, 'public')));

// ── Socket.IO middleware: JWT authentication gate ────────────────────────

/**
 * Every socket connection must carry a valid Supabase access token in the
 * handshake auth object. Unauthenticated connections are rejected immediately.
 */
io.use(async (socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauthorized'));

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return next(new Error('unauthorized'));

  socket.data.user = data.user;
  next();
});

// ── Socket.IO events ─────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // ── Matchmaking ────────────────────────────────────────────────────────

  /**
   * find-stranger — Enter the matchmaking queue.
   *
   * Flow:
   *   • If the caller is already in a room, notify the other peer and leave.
   *   • Drain stale entries from the queue front until a live socket is found.
   *   • If a live partner is found  → create a UUID room, join both, start WebRTC.
   *   • If no partner is available  → push this socket and emit "searching".
   */
  socket.on('find-stranger', (profile) => {
    // Store the profile data for future matchmaking filter use.
    // The payload is optional (older clients omit it) — default to empty object.
    socket.data.profile = (profile && typeof profile === 'object') ? profile : {};

    // Idempotency: ensure we're not already in the queue
    removeFromQueue(socket.id);

    // Leave any active room so the current partner gets notified
    if (socket.data.room) {
      socket.to(socket.data.room).emit('peer-left');
      socket.leave(socket.data.room);
      socket.data.room = null;
    }

    // ── Matchmaking Algorithm ──────────────────────────────────────────
    // Clean out stale sockets first
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
      const s = io.sockets.sockets.get(waitingQueue[i]);
      if (!s || !s.connected) {
        waitingQueue.splice(i, 1);
      }
    }

    let matched = false;

    if (waitingQueue.length > 0) {
      let partnerIndex = -1;
      const isRandom = Math.random() < 0.3;

      if (isRandom) {
        partnerIndex = 0;
      } else {
        const myProfile = socket.data.profile || {};
        const myInterests = Array.isArray(myProfile.activities) ? myProfile.activities : [];
        const mySongs = Array.isArray(myProfile.top_songs) ? myProfile.top_songs : [];

        let bestScore = 0;
        let bestIndex = -1;

        waitingQueue.forEach((id, index) => {
          const s = io.sockets.sockets.get(id);
          const theirProfile = s.data.profile || {};
          const theirInterests = Array.isArray(theirProfile.activities) ? theirProfile.activities : [];
          const theirSongs = Array.isArray(theirProfile.top_songs) ? theirProfile.top_songs : [];

          let score = 0;
          // Score Interests
          theirInterests.forEach(interest => {
            if (myInterests.includes(interest)) score += 1;
          });

          // Score Artists
          theirSongs.forEach(theirSong => {
            if (theirSong && theirSong.artist) {
              const hasArtist = mySongs.some(mySong => mySong && mySong.artist === theirSong.artist);
              if (hasArtist) score += 1;
            }
          });

          if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
          }
        });

        if (bestIndex !== -1) {
          partnerIndex = bestIndex;
        } else {
          partnerIndex = 0; // Fallback
        }
      }

      const partnerId = waitingQueue[partnerIndex];
      waitingQueue.splice(partnerIndex, 1);
      const partnerSocket = io.sockets.sockets.get(partnerId);

      // ── Successful match ───────────────────────────────────────────────
      const room = randomUUID();

      socket.join(room);
      partnerSocket.join(room);
      socket.data.room = room;
      partnerSocket.data.room = room;

      // The incoming socket (the "new arrival") creates the WebRTC offer.
      socket.emit('start', { initiator: true, partnerProfile: partnerSocket.data.profile || {} });
      partnerSocket.emit('start', { initiator: false, partnerProfile: socket.data.profile || {} });

      matched = true;
    }

    if (!matched) {
      // No partner available — wait in the queue
      waitingQueue.push(socket.id);
      socket.emit('searching');
    }
  });

  // ── Graceful room exit (Next / Skip / Stop) ────────────────────────────

  /**
   * leave-room — Leave the current room or cancel a queue search without
   * fully disconnecting the socket.
   *
   * Used by "Next / Skip" (client re-emits find-stranger immediately after)
   * and "Stop" (client returns to idle). The server's job is only cleanup.
   */
  socket.on('leave-room', () => {
    removeFromQueue(socket.id);
    if (socket.data.room) {
      socket.to(socket.data.room).emit('peer-left');
      socket.leave(socket.data.room);
      socket.data.room = null;
    }
  });

  // ── WebRTC signaling relay ─────────────────────────────────────────────
  // Pure relay — payloads are forwarded verbatim. All media is peer-to-peer.

  socket.on('offer', (d) => socket.to(socket.data.room).emit('offer', d));
  socket.on('answer', (d) => socket.to(socket.data.room).emit('answer', d));
  socket.on('candidate', (d) => socket.to(socket.data.room).emit('candidate', d));

  // ── Disconnect ────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    // Scrub from queue so dead IDs never block a future match
    removeFromQueue(socket.id);

    // Notify the active room partner, if any
    if (socket.data.room) {
      socket.to(socket.data.room).emit('peer-left');
    }
  });
});

// ── Server start ─────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening → http://localhost:${PORT}`));
