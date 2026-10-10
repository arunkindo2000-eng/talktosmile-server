const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Production me ALLOWED_ORIGINS set karo, e.g. "https://talktosmile.com,https://www.talktosmile.com"
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : "*";

const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
  pingInterval: 10000,
  pingTimeout: 15000, // pehle 60000 tha -> ghost users ~80s tak rehte the
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 1e5 // 100 KB, bade payloads block
});

app.get("/", (req, res) => {
  res.status(200).json({
    name: "TalkToSmile Server",
    status: "running",
    message: "Socket.IO server is ready"
  });
});
app.get("/health", (req, res) => res.send("ok"));

const waitingUsers = new Map(); // socketId -> socket
const activeRooms = new Map(); // roomId -> { members: [id, id] }

/* ---------- Simple rate limiter (per socket) ---------- */
function allow(socket, key, limit, windowMs) {
  const now = Date.now();
  socket.data.rl = socket.data.rl || {};
  const bucket = socket.data.rl[key] || { count: 0, start: now };

  if (now - bucket.start > windowMs) {
    bucket.count = 0;
    bucket.start = now;
  }

  bucket.count++;
  socket.data.rl[key] = bucket;
  return bucket.count <= limit;
}

/* ---------- Room helpers ---------- */
function leaveRoom(socket, notify = true) {
  waitingUsers.delete(socket.id);

  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = activeRooms.get(roomId);

  socket.data.roomId = null;
  socket.data.partnerId = null;
  socket.leave(roomId);

  if (!room) return;

  const partnerId = room.members.find((id) => id !== socket.id);
  activeRooms.delete(roomId);

  if (partnerId) {
    const partner = io.sockets.sockets.get(partnerId);

    if (partner) {
      partner.leave(roomId); // FIX: pehle partner room me joined reh jata tha
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
    if (id === socket.id) continue;

    // Disconnected ya stale socket ko queue se hata do
    if (!user.connected) {
      waitingUsers.delete(id);
      continue;
    }

    waitingUsers.delete(id);

    const roomId = "room_" + socket.id + "_" + id;

    activeRooms.set(roomId, { members: [socket.id, id] });

    socket.join(roomId);
    user.join(roomId);

    socket.data.roomId = roomId;
    socket.data.partnerId = id;

    user.data.roomId = roomId;
    user.data.partnerId = socket.id;

    // initiator: jo naya aaya (socket) woh WebRTC offer banayega.
    // Isse dono taraf se ek saath offer bhejne ki problem (glare) nahi hoti.
    socket.emit("matched", {
      roomId,
      partnerId: id,
      username: user.data.username || "Stranger",
      initiator: true
    });

    user.emit("matched", {
      roomId,
      partnerId: socket.id,
      username: socket.data.username || "Stranger",
      initiator: false
    });

    return;
  }

  waitingUsers.set(socket.id, socket);
  socket.emit("waiting");
}

/* ---------- Socket events ---------- */
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("start-chat", (username) => {
    if (!allow(socket, "start", 5, 10000)) return;

    leaveRoom(socket, true);

    socket.data.username = String(username || "Stranger")
      .replace(/[<>]/g, "") // basic sanitize; frontend me bhi textContent use karo
      .trim()
      .slice(0, 20) || "Stranger";

    findMatch(socket);
  });

  socket.on("message", (text) => {
    if (!allow(socket, "msg", 10, 5000)) return; // 5 sec me max 10 msgs

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

  /* ---------- WebRTC signaling (voice chat ke liye zaroori) ---------- */
  ["offer", "answer", "ice-candidate"].forEach((evt) => {
    socket.on(evt, (data) => {
      if (!allow(socket, "signal", 100, 10000)) return;

      const partnerId = socket.data.partnerId;
      if (!partnerId) return;

      // sirf apne current partner ko forward karo
      io.to(partnerId).emit(evt, data);
    });
  });

  socket.on("next-stranger", () => {
    if (!allow(socket, "next", 5, 10000)) return;

    leaveRoom(socket);
    findMatch(socket);
  });

  socket.on("stop-chat", () => {
    leaveRoom(socket);
  });

  socket.on("disconnect", () => {
    leaveRoom(socket);
    console.log("Disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("TalkToSmile server running on port", PORT);
});
