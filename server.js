
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 20000,
  pingTimeout: 60000,
  transports: ["websocket", "polling"]
});

app.get("/", (req, res) => {
  res.status(200).json({
    name: "TalkToSmile Server",
    status: "running",
    message: "Socket.IO server is ready"
  });
});
app.get("/health", (req, res) => res.send("ok"));
const waitingUsers = new Map();
const activeRooms = new Map();

function leaveRoom(socket, notify = true) {
  const roomId = socket.data.roomId;

  if (!roomId) {
    waitingUsers.delete(socket.id);
    return;
  }

  const room = activeRooms.get(roomId);

  socket.data.roomId = null;
  socket.data.partnerId = null;
  socket.leave(roomId);

  if (!room) return;

  const partnerId = room.members.find(id => id !== socket.id);

  activeRooms.delete(roomId);

  if (partnerId) {
    const partner = io.sockets.sockets.get(partnerId);

    if (partner) {
      partner.data.roomId = null;
      partner.data.partnerId = null;

      if (notify) {
        partner.emit("partner-disconnected");
      }
    }
  }
}

function findMatch(socket) {
  if (!socket.connected || socket.data.roomId) return;

  for (const [id, user] of waitingUsers) {
    if (id === socket.id || !user.connected) continue;

    waitingUsers.delete(id);

    const roomId = "room_" + socket.id + "_" + id;

    activeRooms.set(roomId, {
      members: [socket.id, id]
    });

    socket.join(roomId);
    user.join(roomId);

    socket.data.roomId = roomId;
    socket.data.partnerId = id;

    user.data.roomId = roomId;
    user.data.partnerId = socket.id;

    socket.emit("matched", {
      roomId,
      partnerId: id,
      username: user.data.username || "Stranger"
    });

    user.emit("matched", {
      roomId,
      partnerId: socket.id,
      username: socket.data.username || "Stranger"
    });

    return;
  }

  waitingUsers.set(socket.id, socket);
  socket.emit("waiting");
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("start-chat", (username) => {
    leaveRoom(socket, true);

    for (const [id, user] of waitingUsers) {
      if (id === socket.id) waitingUsers.delete(id);
    }

    socket.data.username =
      String(username || "Stranger").slice(0, 20);

    findMatch(socket);
  });

  socket.on("message", (text) => {
    const roomId = socket.data.roomId;

    if (!roomId || typeof text !== "string") return;

    const message = text.trim().slice(0, 500);
    if (!message) return;

    socket.to(roomId).emit("message", {
      sender: socket.id,
      username: socket.data.username || "Stranger",
      text: message,
      timestamp: Date.now()
    });
  });

  socket.on("next-stranger", () => {
    leaveRoom(socket);
    findMatch(socket);
  });

  socket.on("disconnect", () => {
    waitingUsers.delete(socket.id);
    leaveRoom(socket);
    console.log("Disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("TalkToSmile server running on port", PORT);
});
