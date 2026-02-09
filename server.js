let socket;
let chatBox = document.getElementById("chatBox");
let statusText = document.getElementById("status");
let msgInput = document.getElementById("msgInput");

function startChat() {
  socket = new WebSocket("wss://echo.websocket.events");

  statusText.innerText = "Status: Connecting...";

  socket.onopen = () => {
    statusText.innerText = "Status: Connected";
    addMessage("System", "Waiting for a stranger...");
  };

  socket.onmessage = (event) => {
    addMessage("Stranger", event.data);
  };

  socket.onclose = () => {
    statusText.innerText = "Status: Disconnected";
  };
}

function sendMessage() {
  if (!socket || socket.readyState !== 1) return;

  let msg = msgInput.value.trim();
  if (msg === "") return;

  addMessage("You", msg);
  socket.send(msg);
  msgInput.value = "";
}

function disconnectChat() {
  if (socket) socket.close();
}

function nextChat() {
  disconnectChat();
  chatBox.innerHTML = "";
  startChat();
}

function addMessage(sender, text) {
  let div = document.createElement("div");
  div.innerText = sender + ": " + text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}
