// Tracks recording state to update toolbar icon
let isRecording = false;

browser.runtime.onMessage.addListener((msg) => {
  if (msg.action === "recordingStarted") {
    isRecording = true;
    browser.browserAction.setIcon({ path: "icons/mic-recording.svg" });
    browser.browserAction.setTitle({ title: "Recording… click popup to stop" });
  } else if (msg.action === "recordingStopped") {
    isRecording = false;
    browser.browserAction.setIcon({ path: "icons/mic-idle.svg" });
    browser.browserAction.setTitle({ title: "Whisper STT" });
  }
});
