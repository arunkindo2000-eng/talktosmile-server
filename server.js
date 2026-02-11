const socket = new WebSocket("wss://echo.websocket.events");

socket.onopen = () => {
    document.getElementById("status").innerText = "Status: Connected";
};

socket.onmessage = (event) => {
    const chatBox = document.getElementById("chat");
    chatBox.innerHTML += "<div>" + event.data + "</div>";
};

function sendMessage() {
    const input = document.getElementById("messageInput");
    socket.send(input.value);
    input.value = "";
}
