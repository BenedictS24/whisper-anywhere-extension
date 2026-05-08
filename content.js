// ─── State ───────────────────────────────────────────────────────────────────
let mediaRecorder  = null;
let audioChunks    = [];
let activeInput    = null;  // last focused text element on this page
let micButton      = null;
let tooltip        = null;
let manualMode     = false;

// ─── Whitelist check ──────────────────────────────────────────────────────────
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

// ─── Track the last focused input on the page ─────────────────────────────────
// We store this BEFORE the popup steals focus, so we know where to paste.
function isTextInput(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    return ["text", "search", "url", "email", "password", ""].includes(t);
  }
  return false;
}

document.addEventListener("focusin", async (e) => {
  if (!isTextInput(e.target)) return;

  // Always track the last focused input, regardless of whitelist
  // so popup-based recording knows where to paste
  activeInput = e.target;

  const whitelisted = await isWhitelisted();
  if (!whitelisted && !manualMode) return;

  positionMicButton(e.target);
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

// ─── Tooltip ──────────────────────────────────────────────────────────────────
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
    const r = micButton.getBoundingClientRect();
    tooltip.style.top  = `${r.top  + window.scrollY - 32}px`;
    tooltip.style.left = `${r.left + window.scrollX - 40}px`;
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

// ─── Inline recording (in-page mic button) ────────────────────────────────────
async function startInlineRecording() {
  showTooltip("Requesting mic…", "#555");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
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
      } else if (data.text) {
        const target = activeInput || document.activeElement;
        if (isTextInput(target)) {
          insertText(target, data.text);
          showTooltip("Done ✓", "#27ae60");
        } else {
          await copyToClipboard(data.text);
          showTooltip("Copied to clipboard ✓", "#27ae60");
        }
        setTimeout(hideTooltip, 2500);
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
// Uses execCommand as primary method — works with React, Vue, and complex editors
// like Perplexity, Notion, ChatGPT etc. Falls back to direct value manipulation.
function insertText(el, text) {
  if (!el) return;
  el.focus();

  // execCommand('insertText') works at browser level — frameworks intercept it correctly
  const inserted = document.execCommand("insertText", false, text);

  if (!inserted) {
    // Fallback for elements that don't support execCommand
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
    } else if ("value" in el) {
      const start = el.selectionStart ?? el.value.length;
      const end   = el.selectionEnd   ?? el.value.length;
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}

// ─── Clipboard fallback ───────────────────────────────────────────────────────
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

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
    // Popup finished transcribing — try to insert into best available target.
    // Priority: last known activeInput → current activeElement → clipboard fallback
    const target = (activeInput && isTextInput(activeInput))
      ? activeInput
      : isTextInput(document.activeElement) ? document.activeElement : null;

    if (target) {
      insertText(target, msg.text);
      sendResponse({ ok: true, method: "insert" });
    } else {
      // No text field found — copy to clipboard so the user can paste manually
      copyToClipboard(msg.text).then(ok => {
        sendResponse({ ok, method: "clipboard" });
      });
      return true; // async response
    }
  }
  return true;
});
