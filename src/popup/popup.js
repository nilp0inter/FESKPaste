import {FeskAudioDecoder} from "../core/fesk-audio-decoder.js";

let decoder = null;
let timerInterval = null;
let autoPaste = true;
let sendEnter = false;
let autoCopy = true;
let autoClose = true;

document.addEventListener("DOMContentLoaded", () => {
  const elStatus = document.getElementById("status");
  const elStatusText = document.getElementById("status-text");
  const elTimer = document.getElementById("timer");
  const elBtnStop = document.getElementById("btn-stop");
  const elResult = document.getElementById("result");
  const elResultText = document.getElementById("result-text");
  const elBtnCopy = document.getElementById("btn-copy");
  const elError = document.getElementById("error");
  const elPreview = document.getElementById("preview");
  const elPreviewText = document.getElementById("preview-text");

  function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min + ":" + sec.toString().padStart(2, "0");
  }

  function updateTimer() {
    if (decoder) elTimer.textContent = formatTime(decoder.getElapsed());
  }

  function setStatus(status, text) {
    elStatus.className = "status " + status;
    elStatusText.textContent = text;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => execCopy(text));
    }
    return execCopy(text);
  }

  function execCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return Promise.resolve();
  }

  async function copyAndMaybeClose(text) {
    if (autoCopy) {
      await copyToClipboard(text);
    }
    if (autoClose) {
      setTimeout(() => window.close(), 300);
    }
  }

  function showResult(result) {
    stopTimer();
    elBtnStop.classList.add("hidden");

    if (!autoPaste || !result.valid) {
      showFallback(result);
      return;
    }

    // Try to paste into the active tab's focused input
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (!tabs[0]) {
        showFallback(result);
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, {type: "feskpaste-insert", text: result.text, sendEnter}, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          showFallback(result);
          return;
        }
        setStatus("success", "Pasted!");
        copyAndMaybeClose(result.text);
      });
    });
  }

  function showFallback(result) {
    setStatus("success", "Decoded!");
    elResult.classList.remove("hidden");
    elResultText.textContent = result.text;
    elBtnCopy.classList.remove("hidden");
    copyAndMaybeClose(result.text);
  }

  function showError(msg) {
    stopTimer();
    setStatus("error", "Error");
    elBtnStop.classList.add("hidden");
    elError.classList.remove("hidden");
    elError.textContent = msg;

    const settingsLink = document.createElement("a");
    settingsLink.href = "#";
    settingsLink.textContent = "Open Settings";
    settingsLink.style.cssText = "display:block;margin-top:6px;color:hsl(217,50%,50%);font-size:12px";
    settingsLink.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    elError.appendChild(settingsLink);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function startDecoding(config) {
    decoder = new FeskAudioDecoder(config);

    timerInterval = setInterval(updateTimer, 200);

    decoder.startListening((info) => {
      if (info.status === "listening" && info.tones > 0) {
        setStatus("listening", "Listening... (tones: " + info.tones + ")");
      } else if (info.status === "receiving") {
        setStatus("receiving", "Receiving... (" + info.candidates + " symbols)");
        elPreview.classList.remove("hidden");
        elPreviewText.textContent = info.preview || info.debug || "\u2588";
      } else if (info.status === "decoding") {
        setStatus("decoding", "Decoding...");
      }
    }).then((result) => {
      showResult(result);
    }).catch((err) => {
      if (err.message !== "Cancelled") {
        showError(err.message);
      }
    });

    elBtnStop.addEventListener("click", () => {
      decoder.stopAndDecode();
    });
  }

  // Load settings then start
  chrome.storage.local.get({ mode: "hybrid", debug: false, timeout: 30, autoPaste: true, sendEnter: false, autoCopy: true, autoClose: true }, (items) => {
    autoPaste = items.autoPaste;
    sendEnter = items.sendEnter;
    autoCopy = items.autoCopy;
    autoClose = items.autoClose;
    startDecoding({ mode: items.mode, debug: items.debug, timeout: items.timeout });
  });

  elBtnCopy.addEventListener("click", () => {
    copyToClipboard(elResultText.textContent).then(() => {
      elBtnCopy.textContent = "Copied!";
      setTimeout(() => { elBtnCopy.textContent = "Copy to Clipboard"; }, 1500);
    });
  });

  window.addEventListener("beforeunload", () => {
    if (decoder) decoder.cancel();
  });
});
