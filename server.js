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

// ── Friends & Private Messaging Maps ──────────────────────────────
const connectedUsers = new Map(); // user_id -> socket.id
const socketToUser = new Map();   // socket.id -> user_id

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

function isCompatible(s1, s2) {
  const p1 = s1.data.profile || {};
  const f1 = s1.data.filters || {};
  const m1 = s1.data.matchMode || 'strict';
  const t1 = s1.data.queueEntryTime || Date.now();

  const p2 = s2.data.profile || {};
  const f2 = s2.data.filters || {};
  const m2 = s2.data.matchMode || 'strict';
  const t2 = s2.data.queueEntryTime || Date.now();

  const strict1 = m1 === 'strict' || (m1 === 'speed' && Date.now() - t1 < 10000);
  const strict2 = m2 === 'strict' || (m2 === 'speed' && Date.now() - t2 < 10000);

  // If s1 requires strict, s2's profile must pass s1's filters
  if (strict1) {
    if (f1.gender && f1.gender !== 'any' && p2.gender !== f1.gender) return false;
    if (f1.language && f1.language !== 'any' && p2.language !== f1.language) return false;
    if (p2.age && (p2.age < f1.ageMin || p2.age > f1.ageMax)) return false;
  }

  // If s2 requires strict, s1's profile must pass s2's filters
  if (strict2) {
    if (f2.gender && f2.gender !== 'any' && p1.gender !== f2.gender) return false;
    if (f2.language && f2.language !== 'any' && p1.language !== f2.language) return false;
    if (p1.age && (p1.age < f2.ageMin || p1.age > f2.ageMax)) return false;
  }

  return true;
}

function processQueue() {
  // Clean out stale sockets
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    const s = io.sockets.sockets.get(waitingQueue[i]);
    if (!s || !s.connected || s.data.room) {
      waitingQueue.splice(i, 1);
    }
  }

  // Try to match pairs
  for (let i = 0; i < waitingQueue.length; i++) {
    const s1Id = waitingQueue[i];
    const s1 = io.sockets.sockets.get(s1Id);
    if (!s1 || s1.data.room) continue;

    let bestScore = -1;
    let bestIndex = -1;

    const p1 = s1.data.profile || {};
    const interests1 = Array.isArray(p1.activities) ? p1.activities : [];
    const songs1 = Array.isArray(p1.top_songs) ? p1.top_songs : [];

    for (let j = i + 1; j < waitingQueue.length; j++) {
      const s2Id = waitingQueue[j];
      const s2 = io.sockets.sockets.get(s2Id);
      if (!s2 || s2.data.room) continue;

      if (!isCompatible(s1, s2)) continue;

      const isRandom = Math.random() < 0.3;
      if (isRandom) {
        bestIndex = j;
        break; // Random match, take it
      }

      // Score based on interests & songs
      let score = 0;
      const p2 = s2.data.profile || {};
      const interests2 = Array.isArray(p2.activities) ? p2.activities : [];
      const songs2 = Array.isArray(p2.top_songs) ? p2.top_songs : [];

      interests2.forEach(interest => {
        if (interests1.includes(interest)) score += 1;
      });

      songs2.forEach(song2 => {
        if (song2 && song2.artist) {
          const hasArtist = songs1.some(song1 => song1 && song1.artist === song2.artist);
          if (hasArtist) score += 1;
        }
      });

      if (score > bestScore) {
        bestScore = score;
        bestIndex = j;
      }
    }

    if (bestIndex !== -1) {
      // Match found!
      const s2Id = waitingQueue[bestIndex];
      const s2 = io.sockets.sockets.get(s2Id);

      // Remove both from queue
      waitingQueue.splice(bestIndex, 1);
      waitingQueue.splice(i, 1);
      i--; // Adjust index since we removed i

      const room = randomUUID();
      s1.join(room);
      s2.join(room);
      s1.data.room = room;
      s2.data.room = room;

      s1.emit('start', { initiator: true, partnerProfile: s2.data.profile || {} });
      s2.emit('start', { initiator: false, partnerProfile: s1.data.profile || {} });
    }
  }
}

// Poll queue every 2 seconds for speed match fallbacks
setInterval(processQueue, 2000);

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
  // Track user for private messaging & friend requests
  const userId = socket.data.user.id;
  connectedUsers.set(userId, socket.id);
  socketToUser.set(socket.id, userId);

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
  socket.on('find-stranger', (payload) => {
    const data = (payload && typeof payload === 'object') ? payload : {};
    
    // Support legacy clients sending just profile, or new clients sending { profile, filters, matchMode }
    const profile = data.profile !== undefined ? data.profile : data;
    const filters = data.filters || { gender: 'any', language: 'any', ageMin: 13, ageMax: 120 };
    const matchMode = data.matchMode || 'strict';

    socket.data.profile = (profile && typeof profile === 'object') ? profile : {};
    socket.data.filters = filters;
    socket.data.matchMode = matchMode;
    socket.data.queueEntryTime = Date.now();

    // Idempotency: ensure we're not already in the queue
    removeFromQueue(socket.id);

    // Leave any active room so the current partner gets notified
    if (socket.data.room) {
      socket.to(socket.data.room).emit('peer-left');
      socket.leave(socket.data.room);
      socket.data.room = null;
    }

    waitingQueue.push(socket.id);
    socket.emit('searching');
    processQueue();
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
  socket.on('chat-message', (d) => socket.to(socket.data.room).emit('chat-message', d));

  // ── Disconnect ────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    // Scrub from queue so dead IDs never block a future match
    removeFromQueue(socket.id);

    // Clean up tracking maps
    const uid = socketToUser.get(socket.id);
    if (uid) {
      connectedUsers.delete(uid);
      socketToUser.delete(socket.id);
    }

    // Notify the active room partner, if any
    if (socket.data.room) {
      socket.to(socket.data.room).emit('peer-left');
    }
  });

  // ── Friends & Private Messaging ────────────────────────────────────────
  socket.on('friend-request', (data) => {
    // data = { to: receiverId, from: myUserId, profile: myProfileData }
    const targetSocket = connectedUsers.get(data.to);
    if (targetSocket) {
      io.to(targetSocket).emit('friend-request', data);
    }
  });

  socket.on('friend-accept', (data) => {
    const targetSocket = connectedUsers.get(data.to);
    if (targetSocket) {
      io.to(targetSocket).emit('friend-accept', data);
    }
  });

  socket.on('private-message', (data) => {
    // data = { to: receiverId, from: myUserId, content: string, timestamp: Date }
    const targetSocket = connectedUsers.get(data.to);
    if (targetSocket) {
      io.to(targetSocket).emit('private-message', data);
    }
  });
});

// ── Server start ─────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening → http://localhost:${PORT}`));
