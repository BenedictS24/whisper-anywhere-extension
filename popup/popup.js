// ─── Elements ─────────────────────────────────────────────────────────────────
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeHost(raw) {
  return raw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "error" : "";
}

// ─── Init ─────────────────────────────────────────────────────────────────────
let currentHost = "";
let isWhitelisted = false;
let isRecording = false;

async function init() {
  // Get active tab
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || "";

  // Check API key
  const { openai_key, whitelist = [] } = await browser.storage.local.get(["openai_key", "whitelist"]);
  if (!openai_key) {
    noKeyWarning.style.display = "block";
    recordBtn.disabled = true;
  }

  // Set hostname display
  try {
    currentHost = new URL(url).hostname;
  } catch {
    currentHost = "";
  }

  if (!currentHost || url.startsWith("about:") || url.startsWith("moz-extension:")) {
    siteHostname.textContent = "N/A (browser page)";
    siteToggleBtn.style.display = "none";
    manualToggle.parentElement.parentElement.style.display = "none";
  } else {
    siteHostname.textContent = currentHost;

    // Check whitelist
    isWhitelisted = whitelist.some(s => {
      const n = normalizeHost(s);
      return currentHost === n || currentHost.endsWith("." + n);
    });

    updateSiteUI(isWhitelisted);

    // Check if manual mode is on in the content script
    try {
      const resp = await browser.tabs.sendMessage(tab.id, { action: "ping" });
      if (resp && resp.alive) {
        // Content script is loaded
      }
    } catch {
      // Content script not reachable
    }
  }

  // Listen for state updates from content script
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.action === "stateUpdate") {
      if (msg.recording) {
        setRecordingUI(true);
      } else if (msg.transcribing) {
        setTranscribingUI();
      } else {
        setIdleUI();
        if (msg.result) {
          resultBox.style.display = "block";
          resultBox.value = msg.result;
        }
        if (msg.error) {
          setStatus(msg.error, true);
        }
      }
    }
  });
}

function updateSiteUI(whitelisted) {
  if (whitelisted) {
    siteDot.classList.add("on");
    siteBadge.textContent = "active";
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

function setRecordingUI(on) {
  isRecording = on;
  recordBtn.classList.toggle("recording", on);
  recordLabel.textContent = on ? "Stop Recording" : "Start Recording";
  if (on) setStatus("Recording…");
}

function setTranscribingUI() {
  recordBtn.classList.remove("recording");
  recordBtn.classList.add("loading");
  recordBtn.disabled = true;
  recordLabel.textContent = "Transcribing…";
  setStatus("Sending to Whisper…");
}

function setIdleUI() {
  recordBtn.classList.remove("recording", "loading");
  recordBtn.disabled = false;
  recordLabel.textContent = "Start Recording";
  setStatus("");
}

// ─── Record button ────────────────────────────────────────────────────────────
recordBtn.addEventListener("click", async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (isRecording) {
    try {
      await browser.tabs.sendMessage(tab.id, { action: "stopRecordingFromPopup" });
    } catch {
      setStatus("Could not reach page", true);
    }
  } else {
    resultBox.style.display = "none";
    resultBox.value = "";
    try {
      await browser.tabs.sendMessage(tab.id, { action: "startRecordingFromPopup" });
    } catch {
      setStatus("Could not reach page — try reloading it", true);
    }
  }
});

// ─── Manual toggle (enable mic button on this page without whitelisting) ──────
manualToggle.addEventListener("change", async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    if (manualToggle.checked) {
      await browser.tabs.sendMessage(tab.id, { action: "enableManual" });
    } else {
      await browser.tabs.sendMessage(tab.id, { action: "disableManual" });
    }
  } catch {
    setStatus("Could not reach page — try reloading it", true);
    manualToggle.checked = !manualToggle.checked;
  }
});

// ─── Add / remove from whitelist ──────────────────────────────────────────────
siteToggleBtn.addEventListener("click", async () => {
  const { whitelist = [] } = await browser.storage.local.get("whitelist");

  let updated;
  if (isWhitelisted) {
    updated = whitelist.filter(s => normalizeHost(s) !== currentHost);
    isWhitelisted = false;
  } else {
    updated = [...whitelist, currentHost];
    isWhitelisted = true;
    // Also enable manual mode on the current tab right now
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    try { await browser.tabs.sendMessage(tab.id, { action: "enableManual" }); } catch {}
  }

  await browser.storage.local.set({ whitelist: updated });
  updateSiteUI(isWhitelisted);
  setStatus(isWhitelisted ? "Site added to whitelist ✓" : "Site removed from whitelist");
  setTimeout(() => setStatus(""), 2500);
});

// ─── Options links ────────────────────────────────────────────────────────────
optionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});
openOptionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});

// ─── Start ────────────────────────────────────────────────────────────────────
init();
