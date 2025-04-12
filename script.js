let messages = []; // No system prompt needed here — already in backend

function appendMessage(sender, text) {
  const chatBox = document.getElementById("chat-box");
  const messageEl = document.createElement("div");
  messageEl.innerHTML = `<strong>${sender}:</strong> ${text}`;
  chatBox.appendChild(messageEl);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function sendMessage() {
  const input = document.getElementById("user-input");
  const message = input.value.trim();
  if (!message) return;

  appendMessage("You", message);
  input.value = "";

  // Add user message to chat history
  messages.push({ role: "user", content: message });

  try {
    const response = await fetch("https://libro-proxy.vercel.app/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ messages }) // Send message history
    });

    const data = await response.json();
    const reply = data.reply || "⚠️ No response received.";

    // Add assistant reply to memory
    messages.push({ role: "assistant", content: reply });

    appendMessage("LiBro Society", reply);
  } catch (err) {
    console.error("❌ Error while sending message:", err);
    appendMessage("LiBro Society", "⚠️ Something went wrong.");
  }
}
