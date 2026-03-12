const DEFAULTS = { mode: "hybrid", debug: false, timeout: 30, autoPaste: true, sendEnter: false, autoCopy: true, autoClose: true };

document.addEventListener("DOMContentLoaded", () => {
  const elTimeout = document.getElementById("timeout");
  const elDebug = document.getElementById("debug");
  const elAutoPaste = document.getElementById("autoPaste");
  const elSendEnter = document.getElementById("sendEnter");
  const elAutoCopy = document.getElementById("autoCopy");
  const elAutoClose = document.getElementById("autoClose");
  const elBtnSave = document.getElementById("btn-save");
  const elSaveStatus = document.getElementById("save-status");
  const elBtnMic = document.getElementById("btn-mic");
  const elMicResult = document.getElementById("mic-result");

  // Load saved settings
  chrome.storage.local.get(DEFAULTS, (items) => {
    document.querySelector(`input[name="mode"][value="${items.mode}"]`).checked = true;
    elTimeout.value = items.timeout;
    elDebug.checked = items.debug;
    elAutoPaste.checked = items.autoPaste;
    elSendEnter.checked = items.sendEnter;
    elSendEnter.disabled = !items.autoPaste;
    elAutoCopy.checked = items.autoCopy;
    elAutoClose.checked = items.autoClose;
  });

  elAutoPaste.addEventListener("change", () => {
    elSendEnter.disabled = !elAutoPaste.checked;
    if (!elAutoPaste.checked) elSendEnter.checked = false;
  });

  // Save
  elBtnSave.addEventListener("click", () => {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const timeout = Math.min(120, Math.max(10, parseInt(elTimeout.value, 10) || 30));
    const debug = elDebug.checked;
    const autoPaste = elAutoPaste.checked;
    const sendEnter = elSendEnter.checked;
    const autoCopy = elAutoCopy.checked;
    const autoClose = elAutoClose.checked;

    elTimeout.value = timeout;
    chrome.storage.local.set({ mode, debug, timeout, autoPaste, sendEnter, autoCopy, autoClose }, () => {
      elSaveStatus.textContent = "Saved!";
      setTimeout(() => { elSaveStatus.textContent = ""; }, 1500);
    });
  });

  // Mic test
  elBtnMic.addEventListener("click", async () => {
    elMicResult.classList.remove("hidden", "ok", "fail");
    elMicResult.textContent = "Requesting microphone...";

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      elMicResult.textContent = "Microphone OK";
      elMicResult.classList.add("ok");
    } catch (err) {
      const name = err && err.name;
      let msg = "Microphone error";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        msg = "Permission denied — allow microphone access in browser settings";
      } else if (name === "NotFoundError") {
        msg = "No microphone found";
      } else {
        msg = "Microphone error: " + (err.message || name || err);
      }
      elMicResult.textContent = msg;
      elMicResult.classList.add("fail");
    }
  });
});
