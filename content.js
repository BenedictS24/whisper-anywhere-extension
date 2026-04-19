// ─── State ───────────────────────────────────────────────────────────────────
let mediaRecorder = null;
let audioChunks   = [];
let activeInput   = null;
let micButton     = null;
let manualMode    = false; // activated from popup on non-whitelisted site

// ─── Whitelist helpers ────────────────────────────────────────────────────────
function normalizeHost(raw) {
  return raw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

async function isWhitelisted() {
  const { whitelist = [] } = await browser.storage.local.get("whitelist");
  const host = window.location.hostname.toLowerCase();
  return whitelist.some(site => {
    const s = normalizeHost(site);
    return host === s || host.endsWith("." + s);
  });
}

// ─── Mic button ───────────────────────────────────────────────────────────────
function getOrCreateMicButton() {
  if (micButton) return micButton;

  micButton = document.createElement("button");
  micButton.className = "wstt-mic-btn";
  micButton.title = "Whisper STT – click to record";
  micButton.innerHTML = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none">
      <rect x="9" y="2" width="6" height="11" rx="3" fill="currentColor"/>
      <path d="M5 11a7 7 0 0014 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="8"  y1="22" x2="16" y2="22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;

  micButton.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  micButton.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopRecording();
    } else {
      startRecording();
    }
  });

  document.body.appendChild(micButton);
  return micButton;
}

function positionMicButton(input) {
  const btn  = getOrCreateMicButton();
  const rect = input.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  btn.style.top  = `${rect.top  + scrollY + rect.height / 2 - 14}px`;
  btn.style.left = `${rect.left + scrollX + rect.width  - 36}px`;
  btn.style.display = "flex";
}

function hideMicButton() {
  if (micButton) micButton.style.display = "none";
}

// ─── Recording ────────────────────────────────────────────────────────────────
async function startRecording(targetInput) {
  if (targetInput) activeInput = targetInput;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.start();

    if (micButton) {
      micButton.classList.add("wstt-mic-btn--recording");
      micButton.title = "Recording… click to stop";
    }

    browser.runtime.sendMessage({ action: "recordingStarted" });

    // Notify popup that recording started
    browser.runtime.sendMessage({ action: "stateUpdate", recording: true });
  } catch (err) {
    console.error("Whisper STT: mic access denied", err);
    browser.runtime.sendMessage({ action: "stateUpdate", recording: false, error: "Mic access denied" });
  }
}

async function stopRecording() {
  if (!mediaRecorder) return;

  return new Promise((resolve) => {
    mediaRecorder.onstop = async () => {
      if (micButton) {
        micButton.classList.remove("wstt-mic-btn--recording");
        micButton.classList.add("wstt-mic-btn--loading");
        micButton.title = "Transcribing…";
      }

      browser.runtime.sendMessage({ action: "recordingStopped" });
      browser.runtime.sendMessage({ action: "stateUpdate", recording: false, transcribing: true });

      const text = await transcribe();

      if (micButton) {
        micButton.classList.remove("wstt-mic-btn--loading");
        micButton.title = "Whisper STT – click to record";
      }

      browser.runtime.sendMessage({ action: "stateUpdate", recording: false, transcribing: false, result: text });

      if (text && activeInput) {
        insertText(activeInput, text);
      }

      resolve(text);
    };

    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
  });
}

async function transcribe() {
  const { openai_key } = await browser.storage.local.get("openai_key");
  if (!openai_key) {
    browser.runtime.sendMessage({ action: "stateUpdate", error: "No API key – open extension options" });
    return null;
  }

  const blob = new Blob(audioChunks, { type: "audio/webm" });
  const formData = new FormData();
  formData.append("file", blob, "audio.webm");
  formData.append("model", "whisper-1");
  // No "language" field → Whisper auto-detects the language

  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openai_key}` },
      body: formData
    });
    const data = await res.json();
    if (data.error) {
      browser.runtime.sendMessage({ action: "stateUpdate", error: data.error.message });
      return null;
    }
    return data.text || null;
  } catch (err) {
    browser.runtime.sendMessage({ action: "stateUpdate", error: "Network error: " + err.message });
    return null;
  }
}

// ─── Text insertion ───────────────────────────────────────────────────────────
function insertText(el, text) {
  if (el.isContentEditable) {
    el.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
    } else {
      el.textContent += text;
    }
  } else {
    const start = el.selectionStart ?? el.value.length;
    const end   = el.selectionEnd   ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
  }
  el.dispatchEvent(new Event("input",  { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// ─── Focus tracking (only show inline mic when whitelisted or manual) ─────────
document.addEventListener("focusin", async (e) => {
  const el = e.target;
  const isInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
  if (!isInput) return;

  const whitelisted = await isWhitelisted();
  if (!whitelisted && !manualMode) return;

  activeInput = el;
  positionMicButton(el);
});

document.addEventListener("focusout", () => {
  setTimeout(() => {
    if (!mediaRecorder || mediaRecorder.state !== "recording") {
      hideMicButton();
    }
  }, 250);
});

window.addEventListener("scroll", () => { if (activeInput) positionMicButton(activeInput); }, true);
window.addEventListener("resize", () => { if (activeInput) positionMicButton(activeInput); });

// ─── Messages from popup ──────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "ping") {
    sendResponse({ alive: true });
    return true;
  }

  if (msg.action === "enableManual") {
    manualMode = true;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === "disableManual") {
    manualMode = false;
    hideMicButton();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === "startRecordingFromPopup") {
    startRecording(activeInput || document.activeElement);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === "stopRecordingFromPopup") {
    stopRecording().then(() => sendResponse({ ok: true }));
    return true; // keep channel open for async
  }
});
