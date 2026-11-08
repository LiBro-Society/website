// The chat box on libro.gives/talk.html
//
// Each visitor's conversation lives only in their own browser tab (this `messages` list, backed up in
// sessionStorage so a refresh doesn't wipe it). Nothing is stored on a server and nothing is shared
// between visitors, so no sign-in or profile is needed. Closing the tab clears it.
(() => {
  const API_URL = "https://libro-proxy.vercel.app/api/chat";
  const SEND_LAST = 12;        // how many recent messages are sent to the server (same as Messenger)
  const KEEP_LAST = 40;        // how many are kept in this tab
  const TIMEOUT_MS = 30000;    // give up waiting after 30 seconds
  const STORE_KEY = "libro-chat-v1";

  const WELCOME = "Hi, glad you're here. What's on your mind?";
  const TROUBLE =
    "Something went wrong on my side. Please try again, or reach us on Telegram at t.me/LiBro_Society.";
  const TOO_SLOW =
    "That's taking longer than usual. Please try again, or reach us on Telegram at t.me/LiBro_Society.";

  const chatBox = document.getElementById("chat-box");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-btn");
  const newChatBtn = document.getElementById("new-chat");

  let messages = loadMessages(); // [{ role: "user" | "assistant", content: "..." }]
  let sending = false;
  let typingEl = null;
  let failed = null;             // the last question that got no answer: { text, userBubble, errorBubble }

  // ---- saving in this tab (all wrapped, since storage can be blocked, e.g. in private windows) ----
  function loadMessages() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "[]");
      if (!Array.isArray(saved)) return [];
      return saved
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-KEEP_LAST);
    } catch (e) {
      return [];
    }
  }

  function saveMessages() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-KEEP_LAST)));
    } catch (e) { /* the chat still works without saving */ }
  }

  function clearSaved() {
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
  }

  // ---- drawing the conversation ----
  // Replies are put on the page as plain text (never as HTML). Only web addresses are made clickable.
  const LINK_RE = /(https?:\/\/[^\s<>"']+|\b(?:t\.me|libro\.gives)\/[^\s<>"']*)/gi;

  function fillWithLinks(container, text) {
    let last = 0;
    for (const m of text.matchAll(LINK_RE)) {
      let url = m[0];
      const isFull = /^https?:\/\//i.test(url);
      const before = text[m.index - 1];
      // "evil.t.me/x" or "foo/libro.gives/x": not ours, leave as plain text
      if (!isFull && before && /[\w.@\/-]/.test(before)) continue;
      const trailing = url.match(/[.,!?;:)\]]+$/);
      if (trailing) url = url.slice(0, -trailing[0].length);
      if (!url) continue;

      container.append(text.slice(last, m.index));
      const a = document.createElement("a");
      a.href = isFull ? url : "https://" + url;
      a.textContent = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      container.append(a);
      last = m.index + url.length;
    }
    container.append(text.slice(last));
  }

  function scrollToLatest(bubble) {
    // A long reply is shown from its first line; short ones scroll to the bottom as usual
    if (bubble && bubble.offsetHeight > chatBox.clientHeight) {
      chatBox.scrollTop = bubble.offsetTop - 8;
    } else {
      chatBox.scrollTop = chatBox.scrollHeight;
    }
  }

  function addBubble(role, text) {
    const el = document.createElement("div");
    el.className = "msg " + (role === "user" ? "user" : "bot");
    if (role === "user") el.textContent = text;
    else fillWithLinks(el, text);
    chatBox.appendChild(el);
    scrollToLatest(el);
    return el;
  }

  function showTyping() {
    typingEl = document.createElement("div");
    typingEl.className = "msg bot typing";
    typingEl.setAttribute("role", "status");
    typingEl.setAttribute("aria-label", "LiBro Society is typing");
    typingEl.innerHTML = "<span></span><span></span><span></span>"; // fixed markup, no user text
    chatBox.appendChild(typingEl);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function hideTyping() {
    if (typingEl) typingEl.remove();
    typingEl = null;
  }

  function showError(message, text, userBubble) {
    const el = document.createElement("div");
    el.className = "msg bot error";
    fillWithLinks(el, message);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry-btn";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => {
      if (sending) return;
      clearFailed(true);
      send(text);
    });
    el.appendChild(retry);
    chatBox.appendChild(el);
    scrollToLatest(el);
    failed = { text, userBubble, errorBubble: el };
  }

  // Remove the error notice, and (when retrying) the question it belonged to, so it isn't shown twice
  function clearFailed(removeQuestion) {
    if (!failed) return;
    failed.errorBubble.remove();
    if (removeQuestion) failed.userBubble.remove();
    failed = null;
  }

  function updateControls() {
    newChatBtn.hidden = messages.length === 0;
    newChatBtn.disabled = sending;
    sendBtn.disabled = sending;
    chatBox.setAttribute("aria-busy", sending ? "true" : "false");
  }

  function renderAll() {
    chatBox.textContent = "";
    failed = null;
    addBubble("bot", WELCOME);
    messages.forEach(m => addBubble(m.role === "user" ? "user" : "bot", m.content));
    chatBox.scrollTop = chatBox.scrollHeight;
    updateControls();
  }

  // ---- sending ----
  async function send(rawText) {
    const text = (rawText || "").trim();
    if (!text || sending) return;

    clearFailed(false);
    sending = true;
    input.value = "";
    messages.push({ role: "user", content: text });
    const userBubble = addBubble("user", text);
    updateControls();
    showTyping();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: messages.slice(-SEND_LAST), channel: "web" }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      hideTyping();

      if (response.ok && data && typeof data.reply === "string" && data.reply.trim() && !data.fallback) {
        messages.push({ role: "assistant", content: data.reply });
        addBubble("bot", data.reply);
      } else {
        // No real answer. Take the question back out of the history so "Try again" doesn't send it twice,
        // and show the server's own short message if it sent one.
        messages.pop();
        const notice = data && typeof data.reply === "string" && data.reply.trim() ? data.reply : TROUBLE;
        showError(notice, text, userBubble);
      }
    } catch (err) {
      hideTyping();
      messages.pop();
      showError(err && err.name === "AbortError" ? TOO_SLOW : TROUBLE, text, userBubble);
    } finally {
      clearTimeout(timer);
      sending = false;
      saveMessages();
      updateControls();
      input.focus();
    }
  }

  // ---- wiring ----
  form.addEventListener("submit", e => {   // Enter and the Send button both land here
    e.preventDefault();
    send(input.value);
  });

  newChatBtn.addEventListener("click", () => {
    if (sending) return;
    messages = [];
    clearSaved();
    renderAll();
    input.focus();
  });

  renderAll();

  // Fonts and images finish loading after the first draw and change the bubble heights,
  // so jump to the latest message once more when they're done (matters after a refresh)
  const toBottom = () => { chatBox.scrollTop = chatBox.scrollHeight; };
  window.addEventListener("load", toBottom);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(toBottom);
})();
