browser.runtime.onMessage.addListener((msg) => {
  if (msg.action === "recordingStarted") {
    browser.browserAction.setIcon({ path: "icons/mic-recording.svg" });
    browser.browserAction.setTitle({ title: "Whisper STT — Recording…" });
  } else if (msg.action === "recordingStopped") {
    browser.browserAction.setIcon({ path: "icons/mic-idle.svg" });
    browser.browserAction.setTitle({ title: "Whisper STT" });
  }
});
