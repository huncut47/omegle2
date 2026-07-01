const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server);

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
