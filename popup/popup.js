const recordBtn      = document.getElementById("recordBtn");
const recordLabel    = document.getElementById("recordLabel");
const statusEl       = document.getElementById("status");
const resultBox      = document.getElementById("resultBox");
const siteBadge      = document.getElementById("siteBadge");
const siteDot        = document.getElementById("siteDot");
const siteHostname   = document.getElementById("siteHostname");
const siteToggleBtn  = document.getElementById("siteToggleBtn");
const manualToggle   = document.getElementById("manualToggle");
const noKeyWarning   = document.getElementById("noKeyWarning");
const optionsLink    = document.getElementById("optionsLink");
const openOptionsLink = document.getElementById("openOptionsLink");

// ─── Recording state lives in the popup itself ────────────────────────────────
let mediaRecorder = null;
let audioChunks   = [];
let isRecording   = false;

// ─── Status helpers ───────────────────────────────────────────────────────────
function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className = type; // "error", "ok", or ""
}

function setBusy(label) {
  recordBtn.disabled = true;
  recordBtn.classList.remove("recording");
  recordBtn.classList.add("loading");
  recordLabel.textContent = label;
}

function setIdle() {
  isRecording = false;
  recordBtn.disabled = false;
  recordBtn.classList.remove("recording", "loading");
  recordLabel.textContent = "⏺ Start Recording";
  browser.runtime.sendMessage({ action: "recordingStopped" }).catch(() => {});
}

// ─── Start recording ──────────────────────────────────────────────────────────
async function startRecording() {
  setStatus("Requesting microphone access…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    mediaRecorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.start(100); // chunk every 100 ms

    isRecording = true;
    recordBtn.classList.add("recording");
    recordBtn.classList.remove("loading");
    recordBtn.disabled = false;
    recordLabel.textContent = "⏹ Stop & Transcribe";
    setStatus("🔴 Recording — speak now…");
    browser.runtime.sendMessage({ action: "recordingStarted" }).catch(() => {});

  } catch (err) {
    setIdle();
    if (err.name === "NotAllowedError") {
      setStatus("Microphone permission denied. Allow it in Firefox and try again.", "error");
    } else {
      setStatus("Mic error: " + err.message, "error");
    }
  }
}

// ─── Stop + transcribe ────────────────────────────────────────────────────────
async function stopRecording() {
  if (!mediaRecorder) return;

  setBusy("Stopping…");

  await new Promise(resolve => {
    mediaRecorder.onstop = resolve;
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
  });

  if (audioChunks.length === 0) {
    setStatus("No audio captured — try again.", "error");
    setIdle();
    return;
  }

  const { openai_key } = await browser.storage.local.get("openai_key");
  if (!openai_key) {
    setStatus("No API key set — open Options first.", "error");
    setIdle();
    return;
  }

  setBusy("Transcribing…");
  setStatus("Sending audio to Whisper API…");

  const mimeType = audioChunks[0]?.type || "audio/webm";
  const blob = new Blob(audioChunks, { type: mimeType });

  if (blob.size < 500) {
    setStatus("Recording too short, please try again.", "error");
    setIdle();
    return;
  }

  const formData = new FormData();
  formData.append("file", blob, "audio.webm");
  formData.append("model", "whisper-1");
  // No "language" → Whisper auto-detects

  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openai_key}` },
      body: formData
    });

    const data = await res.json();

    if (data.error) {
      setStatus("API error: " + data.error.message, "error");
    } else if (data.text) {
      resultBox.style.display = "block";
      resultBox.value = data.text;
      setStatus("Done ✓", "ok");

      // Try to inject into the active page's focused text field
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        const resp = await browser.tabs.sendMessage(tab.id, { action: "injectText", text: data.text });
        if (resp && resp.ok) {
          setStatus("Done ✓ — text inserted into page", "ok");
        } else {
          setStatus("Done ✓ — no text field focused on page (copy above)", "ok");
        }
      } catch {
        setStatus("Done ✓ — copy text above manually", "ok");
      }
    } else {
      setStatus("Whisper returned no text.", "error");
    }
  } catch (err) {
    setStatus("Network error: " + err.message, "error");
  }

  setIdle();
}

// ─── Button click ─────────────────────────────────────────────────────────────
recordBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
  } else {
    resultBox.style.display = "none";
    resultBox.value = "";
    setStatus("");
    startRecording();
  }
});

// ─── Site / whitelist helpers ─────────────────────────────────────────────────
let currentHost  = "";
let isWhitelisted = false;

function normalizeHost(raw) {
  return raw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

function updateSiteUI(whitelisted) {
  isWhitelisted = whitelisted;
  if (whitelisted) {
    siteDot.classList.add("on");
    siteBadge.textContent = "whitelisted";
    siteBadge.classList.add("active");
    siteToggleBtn.textContent = "Remove from whitelist";
    siteToggleBtn.classList.add("remove");
    manualToggle.checked = true;
  } else {
    siteDot.classList.remove("on");
    siteBadge.textContent = "inactive";
    siteBadge.classList.remove("active");
    siteToggleBtn.textContent = "Add to whitelist";
    siteToggleBtn.classList.remove("remove");
  }
}

siteToggleBtn.addEventListener("click", async () => {
  const { whitelist = [] } = await browser.storage.local.get("whitelist");
  let updated;
  if (isWhitelisted) {
    updated = whitelist.filter(s => normalizeHost(s) !== currentHost);
  } else {
    updated = [...whitelist, currentHost];
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    try { await browser.tabs.sendMessage(tab.id, { action: "enableManual" }); } catch {}
  }
  await browser.storage.local.set({ whitelist: updated });
  updateSiteUI(!isWhitelisted);
  setStatus(isWhitelisted ? "Removed from whitelist" : "Added to whitelist ✓", "ok");
  setTimeout(() => setStatus(""), 2500);
});

manualToggle.addEventListener("change", async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    await browser.tabs.sendMessage(tab.id, {
      action: manualToggle.checked ? "enableManual" : "disableManual"
    });
  } catch { /* content script may not be ready yet */ }
});

// ─── Options links ────────────────────────────────────────────────────────────
optionsLink.addEventListener("click", e => { e.preventDefault(); browser.runtime.openOptionsPage(); });
openOptionsLink.addEventListener("click", e => { e.preventDefault(); browser.runtime.openOptionsPage(); });

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const { openai_key, whitelist = [] } = await browser.storage.local.get(["openai_key", "whitelist"]);

  if (!openai_key) {
    noKeyWarning.style.display = "block";
    recordBtn.disabled = true;
  }

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";

  try { currentHost = new URL(url).hostname; } catch { currentHost = ""; }

  const isBrowserPage = !currentHost || url.startsWith("about:") || url.startsWith("moz-extension:");

  if (isBrowserPage) {
    siteHostname.textContent = "N/A (browser page)";
    document.getElementById("siteSection").style.display = "none";
  } else {
    siteHostname.textContent = currentHost;
    const wl = whitelist.map(normalizeHost);
    const matched = wl.some(s => currentHost === s || currentHost.endsWith("." + s));
    updateSiteUI(matched);
  }
}

init();
