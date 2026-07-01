require("dotenv").config();
const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const app = express();

// Hand the frontend its public Supabase values (anon key is safe to expose).
app.get("/config", (req, res) => {
  res.json({ url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY });
});

// Serve the Supabase client bundle from our own origin (no external CDN).
app.use("/vendor", express.static(path.join(__dirname, "node_modules/@supabase/supabase-js/dist/umd")));

app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server);

// Gate every socket: the handshake must carry a valid Supabase access token.
io.use(async (socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error("unauthorized"));
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return next(new Error("unauthorized"));
  socket.data.user = data.user;
  next();
});

io.on("connection", (socket) => {
  socket.on("join", (room) => {
    const clients = io.sockets.adapter.rooms.get(room);
    const count = clients ? clients.size : 0;
    if (count >= 2) {
      socket.emit("full");
      return;
    }
    socket.join(room);
    socket.data.room = room;
    if (count === 1) {
      // Second peer to arrive kicks off the offer; the first one answers.
      socket.emit("start", { initiator: true });
      socket.to(room).emit("start", { initiator: false });
    }
  });

  // Relay signaling to the other peer in the room.
  socket.on("offer", (d) => socket.to(socket.data.room).emit("offer", d));
  socket.on("answer", (d) => socket.to(socket.data.room).emit("answer", d));
  socket.on("candidate", (d) => socket.to(socket.data.room).emit("candidate", d));

  socket.on("disconnect", () => {
    if (socket.data.room) socket.to(socket.data.room).emit("peer-left");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
