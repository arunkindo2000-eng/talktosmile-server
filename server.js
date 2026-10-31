JavaScript
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

// ======================================
// CONFIGURATION
// ======================================

const PORT = process.env.PORT || 3000;

const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  "https://talktosmile.online,https://www.talktosmile.online"
)
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 20000,
  connectTimeout: 20000
});

app.use(express.json());

// ======================================
// DATA
// ======================================

// Waiting users: socketId -> username
const waitingUsers = new Map();

// Active users: socketId -> partnerSocketId
const activeUsers = new Map();

// Rooms: roomId -> { user1, user2 }
const activeRooms = new Map();

// Usernames: socketId -> username
const usernames = new Map();

// Message rate limiting
const messageLimits = new Map();

// ======================================
// BASIC ROUTES
// ======================================

app.get("/", (req, res) => {
  res.json({
    name: "TalkToSmile Server",
    status: "running",
    features: [
      "Random matching",
      "Text chat",
      "WebRTC signaling",
      "Voice chat support",
      "Next stranger",
      "Disconnect"
    ]
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    online: io.engine.clientsCount
  });
});

// ======================================
// ONLINE COUNT
// ======================================

function broadcastOnlineCount() {
  io.emit("online-count", io.engine.clientsCount);
}

// ======================================
// HELPERS
// ======================================

function cleanUsername(value) {
  if (typeof value !== "string") return "Guest";

  const name = value.trim().slice(0, 24);

  return name || "Guest";
}

function removeFromWaiting(socketId) {
  waitingUsers.delete(socketId);
}

function getPartner(socketId) {
  return activeUsers.get(socketId);
}

function getRoom(socketId) {
  const partnerId = getPartner(socketId);

  if (!partnerId) return null;

  for (const [roomId, room] of activeRooms.entries()) {
    if (
      (room.user1 === socketId && room.user2 === partnerId) ||
      (room.user2 === socketId && room.user1 === partnerId)
    ) {
      return roomId;
    }
  }

  return null;
}

// ======================================
// END ACTIVE CHAT
// ======================================

function leaveChat(socketId, notifyPartner = true) {
  removeFromWaiting(socketId);

  const partnerId = getPartner(socketId);

  if (!partnerId) return;

  const roomId = getRoom(socketId);

  activeUsers.delete(socketId);
  activeUsers.delete(partnerId);

  if (roomId) {
    activeRooms.delete(roomId);
  }

  if (notifyPartner) {
    io.to(partnerId).emit("partner-disconnected");
  }
}

// ======================================
// RANDOM MATCHING
// ======================================

function findMatch(socket) {
  if (!socket.connected) return;

  const socketId = socket.id;

  // Avoid duplicate queue entries.
  removeFromWaiting(socketId);

  // Leave any previous chat.
  leaveChat(socketId, true);

  const username = usernames.get(socketId) || "Guest";

  // Find a valid waiting user.
  let partnerId = null;

  for (const waitingId of waitingUsers.keys()) {
    if (
      waitingId !== socketId &&
      io.sockets.sockets.has(waitingId) &&
      !activeUsers.has(waitingId)
    ) {
      partnerId = waitingId;
      break;
    }

    waitingUsers.delete(waitingId);
  }

  // No available partner: add to queue.
  if (!partnerId) {
    waitingUsers.set(socketId, username);

    socket.emit("waiting");

    return;
  }

  // Remove partner from waiting queue.
  const partnerUsername =
    waitingUsers.get(partnerId) || "Guest";

  waitingUsers.delete(partnerId);

  // Create private room.
  const roomId = crypto.randomUUID();

  activeUsers.set(socketId, partnerId);
  activeUsers.set(partnerId, socketId);

  activeRooms.set(roomId, {
    user1: partnerId,
    user2: socketId
  });

  // First waiting user becomes initiator.
  io.to(partnerId).emit("matched", {
    roomId,
    partnerId: socketId,
    username,
    initiator: true
  });

  socket.emit("matched", {
    roomId,
    partnerId,
    username: partnerUsername,
    initiator: false
  });

  console.log(
    `MATCH: ${partnerUsername} <-> ${username}`
  );
}

// ======================================
// MESSAGE RATE LIMIT
// ======================================

function canSendMessage(socketId) {
  const now = Date.now();

  const previous = messageLimits.get(socketId) || [];

  const recent = previous.filter(
    timestamp => now - timestamp < 5000
  );

  if (recent.length >= 15) {
    messageLimits.set(socketId, recent);
    return false;
  }

  recent.push(now);
  messageLimits.set(socketId, recent);

  return true;
}

// ======================================
// SOCKET CONNECTION
// ======================================

io.on("connection", (socket) => {
  console.log("USER CONNECTED:", socket.id);

  usernames.set(socket.id, "Guest");

  broadcastOnlineCount();

  // ----------------------------------
  // START CHAT
  // ----------------------------------

  socket.on("start-chat", (data) => {
    const username = cleanUsername(
      typeof data === "string" ? data : data?.username
    );

    usernames.set(socket.id, username);

    findMatch(socket);
  });

  // ----------------------------------
  // NEXT STRANGER
  // ----------------------------------

  socket.on("next-stranger", () => {
    const username = usernames.get(socket.id) || "Guest";

    leaveChat(socket.id, true);

    usernames.set(socket.id, username);

    findMatch(socket);
  });

  // ----------------------------------
  // STOP CHAT
  // ----------------------------------

  socket.on("stop-chat", () => {
    leaveChat(socket.id, true);

    socket.emit("chat-stopped");
  });

  // ----------------------------------
  // TEXT MESSAGE
  // ----------------------------------

  socket.on("message", (data) => {
    if (!canSendMessage(socket.id)) return;

    const partnerId = getPartner(socket.id);

    if (!partnerId) return;

    const text = (
      typeof data === "string"
        ? data
        : data?.text
    );

    if (typeof text !== "string") return;

    const message = text.trim().slice(0, 2000);

    if (!message) return;

    io.to(partnerId).emit("message", {
      text: message,
      username: usernames.get(socket.id) || "Guest"
    });
  });

  // ==================================
  // WEBRTC SIGNALING
  // ==================================

  function forwardSignal(eventName, data) {
    const partnerId = getPartner(socket.id);

    if (!partnerId) return;

    const roomId = getRoom(socket.id);

    if (!roomId) return;

    // Ignore signals for stale or incorrect rooms.
    if (
      data &&
      typeof data === "object" &&
      data.roomId &&
      data.roomId !== roomId
    ) {
      return;
    }

    io.to(partnerId).emit(eventName, data);
  }

  socket.on("offer", (data) => {
    forwardSignal("offer", data);
  });

  socket.on("answer", (data) => {
    forwardSignal("answer", data);
  });

  socket.on("ice-candidate", (data) => {
    forwardSignal("ice-candidate", data);
  });

  // ----------------------------------
  // END VOICE
  // ----------------------------------

  socket.on("voice-end", () => {
    const partnerId = getPartner(socket.id);

    if (partnerId) {
      io.to(partnerId).emit("voice-end");
    }
  });

  // ----------------------------------
  // DISCONNECT
  // ----------------------------------

  socket.on("disconnect", (reason) => {
    console.log("USER DISCONNECTED:", socket.id, reason);

    leaveChat(socket.id, true);

    usernames.delete(socket.id);
    messageLimits.delete(socket.id);

    broadcastOnlineCount();
  });
});

// ======================================
// SERVER START
// ======================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TalkToSmile server running on port ${PORT}`);
});
