const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

let waitingUser = null;

wss.on("connection", (ws) => {

  if (waitingUser === null) {
    waitingUser = ws;
    ws.send("Waiting for a stranger...");
  } else {
    ws.partner = waitingUser;
    waitingUser.partner = ws;

    ws.send("Stranger connected!");
    waitingUser.send("Stranger connected!");

    waitingUser = null;
  }

  ws.on("message", (msg) => {
    if (ws.partner && ws.partner.readyState === WebSocket.OPEN) {
      ws.partner.send(msg.toString());
    }
  });

  ws.on("close", () => {
    if (ws.partner) {
      ws.partner.send("Stranger disconnected.");
      ws.partner.partner = null;
    }
    if (waitingUser === ws) {
      waitingUser = null;
    }
  });
});

console.log("WebSocket server running on port", PORT);
