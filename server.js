const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: process.env.PORT || 3000 });

let clients = [];

wss.on("connection", function(ws) {
  clients.push(ws);

  ws.on("message", function(message) {
    // send message to any other connected user
    clients.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
  });

  ws.on("close", function() {
    clients = clients.filter(client => client !== ws);
  });
});

console.log("WebSocket server running");
