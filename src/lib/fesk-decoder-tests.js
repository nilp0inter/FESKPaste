// Unit tests for fesk-decoder.js

import { bitsToCodes, decodeCodes, crc8ATM, createFeskBankDecoder } from "./fesk-decoder.js";

function assert(condition, msg) {
  if (!condition) throw new Error("FAIL: " + msg);
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error("FAIL: " + msg + " — got " + a + ", expected " + e);
}

function codesToBits(codes) {
  return codes.flatMap(code => {
    const bits = [];
    for (let shift = 5; shift >= 0; shift--) {
      bits.push((code >> shift) & 1);
    }
    return bits;
  });
}

function runFeskDecoderTests() {
  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name, pass: true });
    } catch (e) {
      results.push({ name, pass: false, error: e.message });
    }
  }

  // --- bitsToCodes ---
  test("bitsToCodes converts bit stream to 6-bit codes", () => {
    const codes = [0, 1, 2, 41, 26, 35];
    const bits = codesToBits(codes);
    const parsed = bitsToCodes(bits);
    assertEq(parsed, codes, "roundtrip codes");
  });

  test("bitsToCodes ignores trailing bits", () => {
    const bits = [1, 0, 1, 0, 1, 0, 1]; // 7 bits → 1 code + 1 leftover
    const codes = bitsToCodes(bits);
    assertEq(codes, [42], "code from 101010");
  });

  // --- decodeCodes ---
  test("decodeCodes maps codes to text (abc\\n09)", () => {
    const codes = [0, 1, 2, 41, 26, 35];
    const result = decodeCodes(codes);
    assert(result.ok, "should be ok");
    assertEq(result.text, "abc\n09", "decoded text");
  });

  test("decodeCodes handles all character types", () => {
    // a=0, space=36, comma=37, colon=38, apostrophe=39, quote=40
    const codes = [0, 36, 37, 38, 39, 40];
    const result = decodeCodes(codes);
    assert(result.ok, "should be ok");
    assertEq(result.text, "a ,:'" + '"', "special chars");
  });

  test("decodeCodes fails on reserved codes", () => {
    const result = decodeCodes([0, 50, 1]); // 50 is reserved
    assert(!result.ok, "should fail on reserved code");
  });

  // --- crc8ATM ---
  test("crc8ATM matches fesk-rt reference ([0,1,2,41,26,35] → 110)", () => {
    const crc = crc8ATM([0, 1, 2, 41, 26, 35]);
    assertEq(crc, 110, "crc value");
  });

  test("crc8ATM empty input returns 0", () => {
    assertEq(crc8ATM([]), 0, "empty crc");
  });

  // --- State machine roundtrip (4FSK) ---
  test("4FSK state machine roundtrip: encode 'hello' → decode", () => {
    // h=7, e=4, l=11, l=11, o=14
    const payloadCodes = [7, 4, 11, 11, 14];
    const crc = crc8ATM(payloadCodes);

    // Build frame: START(62) + payload codes + CRC(8 bits) + END(63)
    const startBits = codesToBits([62]);  // 111110
    const payloadBits = codesToBits(payloadCodes);

    const crcBits = [];
    for (let shift = 7; shift >= 0; shift--) {
      crcBits.push((crc >> shift) & 1);
    }

    const endBits = codesToBits([63]); // 111111
    const allBits = [...startBits, ...payloadBits, ...crcBits, ...endBits];

    // Feed as 4FSK symbols (2 bits per symbol, MSB first)
    const dec = createFeskBankDecoder("4FSK");
    let result = null;
    for (let i = 0; i < allBits.length; i += 2) {
      const symIdx = (allBits[i] << 1) | allBits[i + 1];
      const r = dec.feedOne(symIdx, 0.5);
      if (r) result = r;
    }

    assert(result !== null, "should produce a result");
    assert(result.ok, "should be ok");
    assert(result.crcOk, "crc should match");
    assertEq(result.text, "hello", "decoded text");
  });

  // --- State machine roundtrip (BFSK) ---
  test("BFSK state machine roundtrip: encode 'ab' → decode", () => {
    const payloadCodes = [0, 1]; // a=0, b=1
    const crc = crc8ATM(payloadCodes);

    const startBits = codesToBits([62]);
    const payloadBits = codesToBits(payloadCodes);
    const crcBits = [];
    for (let shift = 7; shift >= 0; shift--) {
      crcBits.push((crc >> shift) & 1);
    }
    const endBits = codesToBits([63]);
    const allBits = [...startBits, ...payloadBits, ...crcBits, ...endBits];

    // Feed as BFSK symbols (1 bit per symbol)
    const dec = createFeskBankDecoder("BFSK");
    let result = null;
    for (const bit of allBits) {
      const r = dec.feedOne(bit, 0.5);
      if (r) result = r;
    }

    assert(result !== null, "should produce a result");
    assert(result.ok, "should be ok");
    assert(result.crcOk, "crc should match");
    assertEq(result.text, "ab", "decoded text");
  });

  // --- Bad CRC ---
  test("CRC mismatch detected", () => {
    const payloadCodes = [0]; // 'a'
    // Compute correct CRC then corrupt it
    const crc = crc8ATM(payloadCodes) ^ 0xFF;

    const startBits = codesToBits([62]);
    const payloadBits = codesToBits(payloadCodes);
    const crcBits = [];
    for (let shift = 7; shift >= 0; shift--) {
      crcBits.push((crc >> shift) & 1);
    }
    const endBits = codesToBits([63]);
    const allBits = [...startBits, ...payloadBits, ...crcBits, ...endBits];

    const dec = createFeskBankDecoder("4FSK");
    let result = null;
    for (let i = 0; i < allBits.length; i += 2) {
      const symIdx = (allBits[i] << 1) | (allBits[i + 1] || 0);
      const r = dec.feedOne(symIdx, 0.5);
      if (r) result = r;
    }

    assert(result !== null, "should produce a result");
    assert(!result.crcOk, "crc should NOT match");
    assert(!result.ok, "should not be ok");
  });

  return results;
}

export { runFeskDecoderTests };
