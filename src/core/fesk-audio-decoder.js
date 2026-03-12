// FESK audio decoder — orchestrates DSP + bank decoders via ScriptProcessor
// FESK audio decoder — orchestrates DSP + bank decoders

import { FeskDSP } from "../lib/fesk-dsp.js";
import { createFeskBankDecoder } from "../lib/fesk-decoder.js";

const DEFAULT_TIMEOUT_MS = 30000;
const ALL_BANK_MODULATION = ["4FSK", "4FSK", "BFSK", "BFSK"];
const ALL_BANK_SCORE_THRESHOLDS = [0.28, 0.18, 0.18, 0.18];

const MODE_BANKS = {
  hybrid: [0, 1, 2, 3],
  "4fsk": [0, 1],
  bfsk: [2, 3],
};

class FeskAudioDecoder {
  constructor({ debug = false, mode = "hybrid", timeout = 30 } = {}) {
    this._debug = debug;
    this._mode = mode;
    this._timeoutMs = (timeout || 30) * 1000;
    this._activeBankIndices = MODE_BANKS[mode] || MODE_BANKS.hybrid;
    this.audioCtx = null;
    this.stream = null;
    this.scriptNode = null;
    this.source = null;
    this.dsp = null;
    this.bankDecoders = [];
    this.timeoutTimer = null;
    this._resolve = null;
    this._reject = null;
    this._cancelled = false;
    this._stopped = false;
    this._statusCb = null;
    this._startTime = null;
    this._hasReceivedCandidate = false;
    this._candidateCount = 0;
    this._toneCount = 0;
    this._debugLog = [];
  }

  startListening(onStatusChange) {
    this._statusCb = onStatusChange;
    return new Promise(async (resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;

      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          reject(new Error("Microphone API not available in this context"));
          return;
        }
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        const name = err && err.name;
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          reject(new Error("Microphone blocked — allow mic access for this extension in browser settings, then retry"));
        } else if (name === "NotFoundError") {
          reject(new Error("No microphone found"));
        } else {
          reject(new Error("Microphone error: " + (err.message || name || err)));
        }
        return;
      }

      this.audioCtx = new AudioContext();
      const sampleRate = this.audioCtx.sampleRate;
      this.source = this.audioCtx.createMediaStreamSource(this.stream);

      // Create bank decoders for active banks only
      this.bankDecoders = new Array(ALL_BANK_MODULATION.length).fill(null);
      for (const i of this._activeBankIndices) {
        this.bankDecoders[i] = createFeskBankDecoder(ALL_BANK_MODULATION[i]);
      }

      // Create DSP engine
      this.dsp = new FeskDSP(sampleRate, (candidate) => this._onCandidate(candidate));

      // ScriptProcessor with 4096 buffer
      this.scriptNode = this.audioCtx.createScriptProcessor(4096, 1, 1);
      this.scriptNode.onaudioprocess = (e) => {
        this.dsp.processSamples(e.inputBuffer.getChannelData(0));
      };
      this.source.connect(this.scriptNode);
      this.scriptNode.connect(this.audioCtx.destination);

      this._startTime = Date.now();
      this._emitStatus("listening");

      this.timeoutTimer = setTimeout(() => {
        if (!this._cancelled && !this._stopped) {
          this._emitStatus("timeout");
          this._cleanup();
          reject(new Error("No transmission detected (timeout)"));
        }
      }, this._timeoutMs);
    });
  }

  _onCandidate(candidate) {
    if (this._cancelled || this._stopped) return;

    const { bankIndex, symbolIndex, score } = candidate;
    if (bankIndex < 0 || bankIndex >= this.bankDecoders.length) return;
    if (!this.bankDecoders[bankIndex]) return;

    this._toneCount++;

    if (score < ALL_BANK_SCORE_THRESHOLDS[bankIndex]) {
      // Below threshold — still report tone activity
      this._emitStatus("listening", "", this._toneCount, this._candidateCount);
      return;
    }

    this._candidateCount++;

    if (!this._hasReceivedCandidate) {
      this._hasReceivedCandidate = true;
    }

    if (this._debug && this._debugLog.length < 200) {
      this._debugLog.push("b" + bankIndex + ":s" + symbolIndex + "(" + score.toFixed(2) + ")");
    }

    const result = this.bankDecoders[bankIndex].feedOne(symbolIndex, score);
    if (result) {
      if (result.ok) {
        this._stopped = true;
        this._emitStatus("decoding");
        this._cleanup();
        this._resolve({ text: result.text, valid: result.crcOk });
        return;
      }
      if (this._debug && this._debugLog.length < 200) {
        this._debugLog.push("[FRAME crc=" + result.crcOk + " text=" + JSON.stringify(result.text) + "]");
      }
    }

    // Emit preview from best bank + debug info
    let bestPreview = "";
    for (const dec of this.bankDecoders) {
      if (!dec) continue;
      const p = dec.getPreviewText();
      if (p.length > bestPreview.length) bestPreview = p;
    }
    const debugStr = this._debug ? this._debugLog.slice(-30).join(" ") : "";
    this._emitStatus("receiving", bestPreview, this._toneCount, this._candidateCount, debugStr);
  }

  stopAndDecode() {
    if (this._cancelled || this._stopped) return;
    this._stopped = true;
    this._emitStatus("decoding");

    // Get best preview text from any bank decoder
    let bestText = "";
    for (const dec of this.bankDecoders) {
      if (!dec) continue;
      const preview = dec.getPreviewText();
      if (preview.length > bestText.length) {
        bestText = preview;
      }
    }

    this._cleanup();

    if (bestText) {
      this._resolve({ text: bestText, valid: false });
    } else {
      this._reject(new Error("No transmission detected"));
    }
  }

  cancel() {
    if (this._cancelled || this._stopped) return;
    this._cancelled = true;
    this._cleanup();
    this._reject(new Error("Cancelled"));
  }

  _cleanup() {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }

  _emitStatus(status, preview, tones, candidates, debug) {
    if (this._statusCb) {
      this._statusCb({
        status,
        elapsed: this._startTime ? Date.now() - this._startTime : 0,
        preview: preview || "",
        tones: tones || 0,
        candidates: candidates || 0,
        debug: debug || "",
      });
    }
  }

  getElapsed() {
    return this._startTime ? Date.now() - this._startTime : 0;
  }
}

export { FeskAudioDecoder };
