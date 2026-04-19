// ─── State ───────────────────────────────────────────────────────────────────
let mediaRecorder = null;
let audioChunks   = [];
let activeInput   = null;
let micButton     = null;
let tooltip       = null;
let manualMode    = false;

// ─── Whitelist check ─────────────────────────────────────────────────────────
function normalizeHost(raw) {
  return raw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

async function isWhitelisted() {
  const { whitelist = [] } = await browser.storage.local.get("whitelist");
  const host = window.location.hostname.toLowerCase();
  return whitelist.some(s => {
    const n = normalizeHost(s);
    return host === n || host.endsWith("." + n);
  });
}

// ─── Tooltip (status shown near mic button) ───────────────────────────────────
function showTooltip(msg, color = "#333") {
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "wstt-tooltip";
    document.body.appendChild(tooltip);
  }
  tooltip.textContent = msg;
  tooltip.style.background = color;
  tooltip.style.display = "block";

  if (micButton) {
    const rect = micButton.getBoundingClientRect();
    tooltip.style.top  = `${rect.top  + window.scrollY - 32}px`;
    tooltip.style.left = `${rect.left + window.scrollX - 40}px`;
  }
}

function hideTooltip() {
  if (tooltip) tooltip.style.display = "none";
}

// ─── Mic button ───────────────────────────────────────────────────────────────
function getOrCreateMicButton() {
  if (micButton) return micButton;

  micButton = document.createElement("button");
  micButton.className = "wstt-mic-btn";
  micButton.title = "Whisper STT — click to record";
  micButton.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="2" width="6" height="11" rx="3" fill="currentColor"/>
      <path d="M5 11a7 7 0 0014 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="8"  y1="22" x2="16" y2="22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;

  micButton.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
  micButton.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopInlineRecording();
    } else {
      startInlineRecording();
    }
  });

  document.body.appendChild(micButton);
  return micButton;
}

function positionMicButton(input) {
  const btn  = getOrCreateMicButton();
  const rect = input.getBoundingClientRect();
  btn.style.top  = `${rect.top  + window.scrollY + rect.height / 2 - 14}px`;
  btn.style.left = `${rect.left + window.scrollX + rect.width  - 36}px`;
  btn.style.display = "flex";
}

function hideMicButton() {
  if (micButton) micButton.style.display = "none";
  hideTooltip();
}

// ─── Inline recording (used by the in-page mic button) ────────────────────────
async function startInlineRecording() {
  showTooltip("Requesting mic…", "#555");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    mediaRecorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.start(100);

    micButton.classList.add("wstt-mic-btn--recording");
    micButton.title = "Recording… click to stop";
    showTooltip("Recording…", "#e74c3c");
    browser.runtime.sendMessage({ action: "recordingStarted" });
  } catch (err) {
    showTooltip("Mic error: " + err.message, "#c0392b");
    setTimeout(hideTooltip, 3000);
  }
}

async function stopInlineRecording() {
  if (!mediaRecorder) return;

  micButton.classList.remove("wstt-mic-btn--recording");
  micButton.classList.add("wstt-mic-btn--loading");
  micButton.title = "Transcribing…";
  showTooltip("Transcribing…", "#f39c12");
  browser.runtime.sendMessage({ action: "recordingStopped" });

  mediaRecorder.onstop = async () => {
    mediaRecorder.stream.getTracks().forEach(t => t.stop());

    const { openai_key } = await browser.storage.local.get("openai_key");
    if (!openai_key) {
      showTooltip("No API key! Open extension options.", "#c0392b");
      setTimeout(hideTooltip, 4000);
      micButton.classList.remove("wstt-mic-btn--loading");
      return;
    }

    const mimeType = audioChunks[0]?.type || "audio/webm";
    const blob = new Blob(audioChunks, { type: mimeType });

    if (blob.size < 500) {
      showTooltip("Too short, try again", "#c0392b");
      setTimeout(hideTooltip, 3000);
      micButton.classList.remove("wstt-mic-btn--loading");
      return;
    }

    const formData = new FormData();
    formData.append("file", blob, "audio.webm");
    formData.append("model", "whisper-1");

    try {
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openai_key}` },
        body: formData
      });
      const data = await res.json();

      if (data.error) {
        showTooltip("API error: " + data.error.message, "#c0392b");
        setTimeout(hideTooltip, 5000);
      } else if (data.text && activeInput) {
        insertText(activeInput, data.text);
        showTooltip("Done ✓", "#27ae60");
        setTimeout(hideTooltip, 2000);
      }
    } catch (err) {
      showTooltip("Network error", "#c0392b");
      setTimeout(hideTooltip, 3000);
    }

    micButton.classList.remove("wstt-mic-btn--loading");
    micButton.title = "Whisper STT — click to record";
  };

  mediaRecorder.stop();
}

// ─── Text insertion ───────────────────────────────────────────────────────────
function insertText(el, text) {
  if (!el) return;
  el.focus();
  if (el.isContentEditable) {
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

// ─── Focus tracking ───────────────────────────────────────────────────────────
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
  if (msg.action === "enableManual") {
    manualMode = true;
    sendResponse({ ok: true });
  } else if (msg.action === "disableManual") {
    manualMode = false;
    hideMicButton();
    sendResponse({ ok: true });
  } else if (msg.action === "injectText") {
    // Called by popup after it recorded & transcribed
    const el = document.activeElement;
    const target = (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
      ? el
      : activeInput;
    if (target) {
      insertText(target, msg.text);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, reason: "No focused text field" });
    }
  }
  return true;
});
