// FESK protocol decoder — state machine, CRC-8 ATM, 6-bit character codes
// Ported from fesk-rt's decoder/index.js

const CODE_BITS = 6;
const CRC_BITS = 8;
const START_CODE = 62; // 111110
const END_CODE = 63;   // 111111
const START_END_MASK = (1 << CODE_BITS) - 1;

// 6-bit character table
const CHAR_TABLE = (function () {
  const t = new Array(64);
  // 0-25: a-z
  for (let i = 0; i < 26; i++) t[i] = String.fromCharCode(97 + i);
  // 26-35: 0-9
  for (let i = 0; i < 10; i++) t[26 + i] = String(i);
  t[36] = " ";
  t[37] = ",";
  t[38] = ":";
  t[39] = "'";
  t[40] = '"';
  t[41] = "\n";
  // 42-61: reserved (null)
  for (let i = 42; i < 62; i++) t[i] = null;
  t[62] = null; // start marker
  t[63] = null; // end marker
  return t;
})();

const END_MARK_BITS = Array.from(
  { length: CODE_BITS },
  (_, i) => (END_CODE >> (CODE_BITS - 1 - i)) & 1,
);

function crc8ATM(codes) {
  let crc = 0x00;
  for (const code of codes) {
    for (let bit = CODE_BITS - 1; bit >= 0; bit--) {
      const inputBit = (code >> bit) & 1;
      const mix = ((crc >> 7) & 1) ^ inputBit;
      crc = (crc << 1) & 0xFF;
      if (mix) crc ^= 0x07;
    }
  }
  return crc;
}

function bitsToCodes(bits, length) {
  const len = length !== undefined ? length : bits.length;
  const codes = [];
  for (let i = 0; i + CODE_BITS <= len; i += CODE_BITS) {
    let code = 0;
    for (let b = 0; b < CODE_BITS; b++) {
      code = (code << 1) | bits[i + b];
    }
    codes.push(code);
  }
  return codes;
}

function decodeCodes(codes) {
  const chars = [];
  for (const code of codes) {
    if (code === START_CODE || code === END_CODE) continue;
    const ch = CHAR_TABLE[code];
    if (ch === null) return { ok: false, text: "" };
    chars.push(ch);
  }
  return { ok: true, text: chars.join("") };
}

function createFeskBankDecoder(modulationType) {
  const isBFSK = modulationType === "BFSK";
  let state = "hunt";
  let markerBits = [];
  let frameBits = [];
  let bitScores = [];
  let recentBits = 0;
  let recentCount = 0;
  let previewCodes = [];

  function reset() {
    state = "hunt";
    markerBits = [];
    frameBits = [];
    bitScores = [];
    recentBits = 0;
    recentCount = 0;
    previewCodes = [];
  }

  function feedBit(bit, score) {
    const s = score ?? 0;

    if (state === "hunt") {
      recentBits = ((recentBits << 1) | bit) & START_END_MASK;
      recentCount = Math.min(recentCount + 1, CODE_BITS);
      if (recentCount === CODE_BITS && recentBits === START_CODE) {
        state = "payload";
        frameBits = [];
        bitScores = [];
        markerBits = [];
        recentBits = 0;
        recentCount = 0;
        previewCodes = [];
      }
      return null;
    }

    if (state !== "payload") return null;

    markerBits.push(bit);

    // Flush non-matching prefix bits one at a time
    while (markerBits.length) {
      let matchesPrefix = true;
      for (let i = 0; i < markerBits.length; i++) {
        if (markerBits[i] !== END_MARK_BITS[i]) {
          matchesPrefix = false;
          break;
        }
      }
      if (matchesPrefix) break;
      frameBits.push(markerBits.shift());
      bitScores.push(s);
      // Update preview
      const usable = frameBits.length - (frameBits.length % CODE_BITS);
      if (usable > 0) previewCodes = bitsToCodes(frameBits, usable);
    }

    // Check if we have a full end marker candidate
    while (markerBits.length >= CODE_BITS) {
      const totalBits = frameBits.length;
      const payloadBitLength = totalBits - CRC_BITS;
      if (payloadBitLength < 0 || payloadBitLength % CODE_BITS !== 0) {
        // Alignment wrong — flush one bit and retry
        frameBits.push(markerBits.shift());
        bitScores.push(s);
        const usable = frameBits.length - (frameBits.length % CODE_BITS);
        if (usable > 0) previewCodes = bitsToCodes(frameBits, usable);
        continue;
      }
      // Aligned — finalize frame
      return finalizeFrame();
    }

    return null;
  }

  function feedOne(symbolIndex, score) {
    if (isBFSK) {
      if (symbolIndex < 0 || symbolIndex > 1) return null;
      return feedBit(symbolIndex, score);
    } else {
      if (symbolIndex < 0 || symbolIndex > 3) return null;
      const bit0 = (symbolIndex >> 1) & 1; // MSB
      const bit1 = symbolIndex & 1;         // LSB
      const r0 = feedBit(bit0, score);
      if (r0) return r0;
      return feedBit(bit1, score);
    }
  }

  function finalizeFrame() {
    const totalBits = frameBits.length;
    if (totalBits < CRC_BITS) {
      reset();
      return { ok: false, crcOk: false, text: "", confidence: 0 };
    }

    const payloadBitLength = totalBits - CRC_BITS;
    const payloadCodes = bitsToCodes(frameBits, payloadBitLength);

    let recvCrc = 0;
    for (let i = payloadBitLength; i < payloadBitLength + CRC_BITS; i++) {
      recvCrc = (recvCrc << 1) | frameBits[i];
    }

    const wantCrc = crc8ATM(payloadCodes);
    const crcOk = recvCrc === wantCrc;

    const decoded = crcOk ? decodeCodes(payloadCodes) : { ok: false, text: "" };
    const avgScore = bitScores.length > 0
      ? bitScores.reduce((a, b) => a + b, 0) / bitScores.length
      : 0;

    reset();

    return {
      ok: decoded.ok && crcOk,
      crcOk,
      text: decoded.text,
      confidence: avgScore,
    };
  }

  function getPreviewText() {
    if (previewCodes.length === 0) return "";
    const decoded = decodeCodes(previewCodes);
    return decoded.ok ? decoded.text : "";
  }

  return { feedOne, reset, getPreviewText };
}

export { createFeskBankDecoder, crc8ATM, bitsToCodes, decodeCodes };
