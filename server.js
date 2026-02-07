const WebSocket = require("ws");

const wss = new WebSocket.Server({
  port: process.env.PORT || 3000
});

let waitingUser = null;

wss.on("connection", function (ws) {

  // pairing logic
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

  // message forward
  ws.on("message", function (msg) {
    if (ws.partner && ws.partner.readyState === WebSocket.OPEN) {
      ws.partner.send(msg.toString());
    }
  });

  // disconnect handling
  ws.on("close", function () {
    if (ws.partner) {
      ws.partner.send("Stranger disconnected");
      ws.partner.partner = null;
    }
    if (waitingUser === ws) {
      waitingUser = null;
    }
  });

});

console.log("WebSocket server running");
