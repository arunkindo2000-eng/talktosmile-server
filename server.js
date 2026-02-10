const socket = io("https://talktosmile-server.onrender.com");

const status = document.getElementById("status");
const chatBox = document.getElementById("chatBox");
const msgInput = document.getElementById("msgInput");

socket.on("connect", () => {
  status.innerText = "Status: Connected";
});

socket.on("disconnect", () => {
  status.innerText = "Status: Disconnected";
});

socket.on("message", (msg) => {
  const div = document.createElement("div");
  div.innerText = msg;
  chatBox.appendChild(div);
});

function startChat() {
  socket.emit("start");
  status.innerText = "Status: Waiting for stranger...";
}

function sendMessage() {
  const msg = msgInput.value;
  if (msg.trim() === "") return;
  socket.emit("message", msg);
  msgInput.value = "";
}
