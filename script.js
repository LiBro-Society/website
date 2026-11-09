// The chat box on libro.gives/talk.html
//
// Each visitor's conversation is kept in their own browser (localStorage) until they press "Start a new
// conversation" (the page says so), so a visitor who comes back still sees it and any late reply. The
// server keeps replies for 7 days after the last message. Nothing is shared between visitors and no
// sign-in or profile is needed.
//
// The server copies website chats into LiBro's private Telegram inbox, where LiBro angels can read them
// and reply. Those replies are fetched from /api/replies while this page is open, using the conversation's
// random id (128 bits, made here, never shown) so only this conversation's replies come back.
(() => {
  const API_BASE = "https://libro-proxy.vercel.app/api";
  const API_URL = API_BASE + "/chat";
  const REPLIES_URL = API_BASE + "/replies";
  const SEND_LAST = 12;        // how many recent messages are sent to the server (same as Messenger)
  const KEEP_LAST = 40;        // how many are kept in this browser
  const TIMEOUT_MS = 30000;    // give up waiting after 30 seconds
  const STORE_KEY = "libro-chat-v2";
  const OLD_STORE_KEY = "libro-chat-v1"; // the tab-only version, read once so an open chat isn't lost

  // The first bubble, by the visitor's own clock. Not saved with the chat, so it fits whenever they return.
  function welcome(hour = new Date().getHours()) {
    if (hour >= 5 && hour < 11) return "Hey, early start today? What's going on?";
    if (hour >= 11 && hour < 14) return "Hey, taking a little break? What's going on?";
    if (hour >= 14 && hour < 18) return "Hey, how's the day treating you so far?";
    if (hour >= 18 && hour < 22) return "Hey, long day? Come sit for a bit. What's going on?";
    return "Hey, still up? Me too. What's going on?";
  }
  const TROUBLE =
    "Something went wrong on my side. Please try again, or reach us on Telegram at t.me/LiBro_Society.";
  const TOO_SLOW =
    "That's taking longer than usual. Please try again, or reach us on Telegram at t.me/LiBro_Society.";
  const HUMAN_LABEL = "LiBro angel";
  const PAUSED_NOTE = "A LiBro angel will answer you here.";

  const chatBox = document.getElementById("chat-box");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-btn");
  const newChatBtn = document.getElementById("new-chat");

  // messages: [{ role: "user" | "assistant", content: "...", human?: true, id?: number }]
  // (human = typed by a LiBro angel in Telegram; id = that reply's number, to avoid showing it twice)
  let { messages, cid, lastReplyId, lastActive, inbox } = load();
  let sending = false;
  let typingEl = null;
  let failed = null;             // the last question that got no answer: { text, userBubble, errorBubble }
  let stickToBottom = true;      // true while the visitor is reading the latest message (not scrolled up)
  let pollTimer = null;
  let polling = false;

  // ---- saving in this browser (all wrapped, since storage can be blocked, e.g. in private windows) ----
  function cleanList(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => {
        const out = { role: m.role, content: m.content };
        if (m.role === "assistant" && m.human === true) {
          out.human = true;
          if (Number.isSafeInteger(m.id)) out.id = m.id;
        }
        return out;
      })
      .slice(-KEEP_LAST);
  }

  function load() {
    const empty = { messages: [], cid: null, lastReplyId: 0, lastActive: 0, inbox: false };
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (saved && typeof saved === "object") {
        return {
          messages: cleanList(saved.messages),
          cid: typeof saved.cid === "string" && /^[0-9a-f]{32}$/.test(saved.cid) ? saved.cid : null,
          lastReplyId: Number.isSafeInteger(saved.lastReplyId) && saved.lastReplyId > 0 ? saved.lastReplyId : 0,
          lastActive: Number(saved.lastActive) || 0,
          inbox: saved.inbox === true
        };
      }
    } catch (e) { /* fall through */ }
    try {
      const old = cleanList(JSON.parse(sessionStorage.getItem(OLD_STORE_KEY) || "[]"));
      if (old.length) return { ...empty, messages: old, lastActive: Date.now() };
    } catch (e) { /* ignore */ }
    return empty;
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        messages: messages.slice(-KEEP_LAST), cid, lastReplyId, lastActive, inbox
      }));
      sessionStorage.removeItem(OLD_STORE_KEY);
    } catch (e) { /* the chat still works without saving */ }
  }

  function clearSaved() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    try { sessionStorage.removeItem(OLD_STORE_KEY); } catch (e) { /* ignore */ }
  }

  // 16 random bytes as hex. Without a proper random source there is no id, and no Telegram replies.
  function newConversationId() {
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    } catch (e) {
      return null;
    }
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

  // New bubbles go above the "typing" dots, if they are showing
  function place(el) {
    if (typingEl && typingEl.parentNode === chatBox) chatBox.insertBefore(el, typingEl);
    else chatBox.appendChild(el);
  }

  function addBubble(role, text, human) {
    const el = document.createElement("div");
    el.className = "msg " + (role === "user" ? "user" : "bot") + (human ? " human" : "");
    if (role === "user") {
      el.textContent = text;
    } else {
      if (human) {
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = HUMAN_LABEL;
        el.appendChild(who);
      }
      fillWithLinks(el, text);
    }
    place(el);
    scrollToLatest(el);
    return el;
  }

  // A small line in the middle of the conversation (not part of the saved chat)
  function addNotice(text) {
    const el = document.createElement("div");
    el.className = "notice";
    el.textContent = text;
    place(el);
    scrollToLatest(el);
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
    place(el);
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
    document.body.classList.toggle("chatting", messages.length > 0); // phones: header shrinks once chatting
    newChatBtn.hidden = messages.length === 0;
    newChatBtn.disabled = sending;
    sendBtn.disabled = sending;
    chatBox.setAttribute("aria-busy", sending ? "true" : "false");
  }

  function renderAll() {
    updateControls(); // first, so the phone layout (taller box) is in place before anything is measured
    chatBox.textContent = "";
    failed = null;
    typingEl = null;
    addBubble("bot", welcome());
    messages.forEach(m => addBubble(m.role === "user" ? "user" : "bot", m.content, m.human));
    stickToBottom = true;
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  // ---- replies from LiBro angels (typed in Telegram) ----
  // Ask often right after the visitor or an angel wrote, then less and less, and stop after two quiet
  // hours. Never while the tab is hidden; coming back to the tab asks straight away.
  function pollDelay() {
    const quiet = Date.now() - lastActive;
    if (quiet < 3 * 60 * 1000) return 4000;
    if (quiet < 15 * 60 * 1000) return 15000;
    if (quiet < 2 * 60 * 60 * 1000) return 60000;
    return null;
  }

  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!inbox || !cid || document.hidden) return;
    const wait = delay === undefined ? pollDelay() : delay;
    if (wait === null) return;
    pollTimer = setTimeout(poll, wait);
  }

  async function poll() {
    pollTimer = null;
    if (!inbox || !cid || polling) return;
    polling = true;
    const askedFor = cid;
    let retryIn;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(REPLIES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation: cid, after: lastReplyId }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (askedFor !== cid) return;                 // a new conversation started meanwhile
      if (response.status === 429) retryIn = 60000;
      if (data && data.inbox === false) {           // the inbox is switched off: stop asking
        inbox = false;
        save();
        return;
      }
      if (response.ok && data && Array.isArray(data.replies)) receive(data.replies);
    } catch (e) {
      /* offline or slow: try again later */
    } finally {
      clearTimeout(timer);
      polling = false;
      schedulePoll(retryIn);
    }
  }

  function receive(replies) {
    const seen = new Set(messages.filter(m => m.human && m.id).map(m => m.id));
    const fresh = replies
      .filter(r => r && Number.isSafeInteger(r.id) && r.id > lastReplyId && !seen.has(r.id) &&
        typeof r.text === "string" && r.text.trim())
      .sort((a, b) => a.id - b.id);
    if (!fresh.length) return;
    for (const r of fresh) {
      messages.push({ role: "assistant", content: r.text, human: true, id: r.id });
      addBubble("bot", r.text, true);
      lastReplyId = Math.max(lastReplyId, r.id);
    }
    lastActive = Date.now();
    save();
    updateControls();
  }

  // ---- sending ----
  async function send(rawText) {
    const text = (rawText || "").trim();
    if (!text || sending) return;

    clearFailed(false);
    sending = true;
    input.value = "";
    if (!cid) cid = newConversationId();
    lastActive = Date.now();
    const userMsg = { role: "user", content: text };
    messages.push(userMsg);
    const userBubble = addBubble("user", text);
    updateControls();
    showTyping();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const forget = () => {                       // take this question back out of the history
      const i = messages.lastIndexOf(userMsg);
      if (i >= 0) messages.splice(i, 1);
    };

    try {
      const payload = {
        messages: messages.slice(-SEND_LAST).map(m => ({ role: m.role, content: m.content })),
        channel: "web"
      };
      if (cid) payload.conversation = cid;
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      hideTyping();
      // inbox: true = the chat reached the Telegram inbox, so look for replies (even if the bot failed)
      if (data && data.inbox === true) inbox = true;
      else if (response.ok && data) inbox = false;

      if (response.ok && data && data.paused === true) {
        // A LiBro angel has taken over this chat: the message reached them, the bot stays quiet
        addNotice(PAUSED_NOTE);
      } else if (response.ok && data && typeof data.reply === "string" && data.reply.trim() && !data.fallback) {
        messages.push({ role: "assistant", content: data.reply });
        addBubble("bot", data.reply);
      } else {
        // No real answer. Take the question back out of the history so "Try again" doesn't send it twice,
        // and show the server's own short message if it sent one.
        forget();
        const notice = data && typeof data.reply === "string" && data.reply.trim() ? data.reply : TROUBLE;
        showError(notice, text, userBubble);
      }
    } catch (err) {
      hideTyping();
      forget();
      showError(err && err.name === "AbortError" ? TOO_SLOW : TROUBLE, text, userBubble);
    } finally {
      clearTimeout(timer);
      sending = false;
      lastActive = Date.now();
      save();
      updateControls();
      schedulePoll();
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
    cid = null;
    lastReplyId = 0;
    lastActive = 0;
    inbox = false;
    schedulePoll();   // stops asking for replies
    clearSaved();
    renderAll();
    input.focus();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) schedulePoll();   // stops while hidden
    else schedulePoll(0);                  // back on the tab: check for replies now
  });

  // The same chat open in another tab changed it: show the same thing here
  window.addEventListener("storage", e => {
    if (e.key !== STORE_KEY || sending) return;
    ({ messages, cid, lastReplyId, lastActive, inbox } = load());
    renderAll();
    schedulePoll();
  });

  renderAll();
  schedulePoll(0);   // a returning visitor: look for replies that came while they were away

  // Keep the latest message in view. Fonts finishing, the phone's address bar sliding away and the
  // chat box changing size all move things after the first draw, so (unless the visitor has scrolled
  // up to read) jump back to the bottom each time that happens.
  const keepAtBottom = () => { if (stickToBottom) chatBox.scrollTop = chatBox.scrollHeight; };
  chatBox.addEventListener("scroll", () => {
    stickToBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 60;
  });
  if (window.ResizeObserver) new ResizeObserver(keepAtBottom).observe(chatBox);
  window.addEventListener("load", keepAtBottom);
  window.addEventListener("pageshow", keepAtBottom);   // coming back to the tab or using the back button
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(keepAtBottom);
})();
