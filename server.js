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

// Comma separated list. Use "*" to allow every origin (testing only).
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  "https://talktosmile.online,https://www.talktosmile.online"
)
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

const allowAllOrigins = allowedOrigins.includes("*");

const MAX_USERNAME_LENGTH = 20; // matches the frontend input
const MAX_MESSAGE_LENGTH = 500; // matches the frontend input

// Behind Render / Railway / Nginx proxies.
app.set("trust proxy", 1);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // No origin = non-browser clients or same-origin requests.
      if (!origin || allowAllOrigins || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn("BLOCKED ORIGIN:", origin);
      return callback(null, false);
    },
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 20000,
  connectTimeout: 20000,
  maxHttpBufferSize: 1e5 // 100 KB is plenty for chat and WebRTC signaling
});

app.use(express.json({ limit: "10kb" }));

// ======================================
// DATA
// ======================================

// Waiting users: socketId -> username
const waitingUsers = new Map();

// Active users: socketId -> partnerSocketId
const activeUsers = new Map();

// Room lookup: socketId -> roomId
const roomOf = new Map();

// Usernames: socketId -> username
const usernames = new Map();

// Message rate limiting: socketId -> timestamps
const messageLimits = new Map();

// Signaling rate limiting: socketId -> timestamps
const signalLimits = new Map();

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
    online: io.engine.clientsCount,
    waiting: waitingUsers.size,
    chatting: activeUsers.size
  });
});

// Lightweight endpoint for uptime pingers (keeps free hosts awake).
app.get("/ping", (req, res) => {
  res.status(200).send("pong");
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

  const name = value
    .replace(/[\u0000-\u001F\u007F<>]/g, "") // strip control chars and angle brackets
    .trim()
    .slice(0, MAX_USERNAME_LENGTH);

  return name || "Guest";
}

function removeFromWaiting(socketId) {
  waitingUsers.delete(socketId);
}

function getPartner(socketId) {
  return activeUsers.get(socketId);
}

function getRoom(socketId) {
  return roomOf.get(socketId) || null;
}

function isWithinLimit(map, socketId, maxCount, windowMs) {
  const now = Date.now();

  const recent = (map.get(socketId) || []).filter(
    (timestamp) => now - timestamp < windowMs
  );

  if (recent.length >= maxCount) {
    map.set(socketId, recent);
    return false;
  }

  recent.push(now);
  map.set(socketId, recent);

  return true;
}

// ======================================
// END ACTIVE CHAT
// ======================================

function leaveChat(socketId, notifyPartner = true) {
  removeFromWaiting(socketId);

  const partnerId = getPartner(socketId);

  if (!partnerId) return;

  activeUsers.delete(socketId);
  activeUsers.delete(partnerId);

  roomOf.delete(socketId);
  roomOf.delete(partnerId);

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

  // Leave any previous chat and avoid duplicate queue entries.
  leaveChat(socketId, true);
  removeFromWaiting(socketId);

  const username = usernames.get(socketId) || "Guest";

  // Find a valid waiting user (oldest first).
  let partnerId = null;

  for (const waitingId of [...waitingUsers.keys()]) {
    const stillConnected = io.sockets.sockets.has(waitingId);

    if (
      waitingId !== socketId &&
      stillConnected &&
      !activeUsers.has(waitingId)
    ) {
      partnerId = waitingId;
      break;
    }

    // Clean up stale entries.
    if (!stillConnected) {
      waitingUsers.delete(waitingId);
    }
  }

  // No available partner: join the queue.
  if (!partnerId) {
    waitingUsers.set(socketId, username);
    socket.emit("waiting");
    return;
  }

  const partnerUsername = waitingUsers.get(partnerId) || "Guest";
  waitingUsers.delete(partnerId);

  // Create private room.
  const roomId = crypto.randomUUID();

  activeUsers.set(socketId, partnerId);
  activeUsers.set(partnerId, socketId);

  roomOf.set(socketId, roomId);
  roomOf.set(partnerId, roomId);

  // First waiting user becomes the WebRTC initiator.
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

  console.log(`MATCH: ${partnerUsername} <-> ${username}`);
}

// ======================================
// SOCKET CONNECTION
// ======================================

io.on("connection", (socket) => {
  console.log("USER CONNECTED:", socket.id);

  usernames.set(socket.id, "Guest");

  // Send the count straight to the new user, then update everyone.
  socket.emit("online-count", io.engine.clientsCount);
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
    // findMatch already leaves the current chat and notifies the partner.
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
    if (!isWithinLimit(messageLimits, socket.id, 15, 5000)) return;

    const partnerId = getPartner(socket.id);

    if (!partnerId) return;

    const text = typeof data === "string" ? data : data?.text;

    if (typeof text !== "string") return;

    const message = text.trim().slice(0, MAX_MESSAGE_LENGTH);

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
    // ICE candidates arrive in bursts, so allow a generous limit.
    if (!isWithinLimit(signalLimits, socket.id, 200, 10000)) return;

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

  socket.on("offer", (data) => forwardSignal("offer", data));
  socket.on("answer", (data) => forwardSignal("answer", data));
  socket.on("ice-candidate", (data) => forwardSignal("ice-candidate", data));

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
    signalLimits.delete(socket.id);

    broadcastOnlineCount();
  });
});

// ======================================
// ERROR HANDLING AND SHUTDOWN
// ======================================

process.on("unhandledRejection", (error) => {
  console.error("UNHANDLED REJECTION:", error);
});

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
});

function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);

  io.close(() => {
    server.close(() => process.exit(0));
  });

  // Force exit if shutdown hangs.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ======================================
// SERVER START
// ======================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TalkToSmile server running on port ${PORT}`);
  console.log("Allowed origins:", allowAllOrigins ? "ALL" : allowedOrigins.join(", "));
});
