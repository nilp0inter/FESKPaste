// FESK DSP engine — Goertzel-based multi-bank tone detector
// Ported from fesk-rt's mb-fesk-worklet.js as a plain class (no AudioWorklet)

const HYBRID_FREQ_SETS = [
  // Bank 0 (4FSK) — narrow detune
  {
    base: [2349.32, 2637.02, 2959.96, 3322.44],
    harmonicMultipliers: [1, 2, 3, 4],
    detuneFactors: [0.99, 1, 1.01],
  },
  // Bank 1 (4FSK) — wide detune
  {
    base: [2349.32, 2637.02, 2959.96, 3322.44],
    harmonicMultipliers: [1, 2, 3, 4],
    detuneFactors: [0.97, 0.985, 1, 1.015, 1.03],
  },
  // Bank 2 (BFSK) — narrow detune
  {
    base: [2490.2, 3134.8],
    harmonicMultipliers: [1, 2, 3, 4],
    detuneFactors: [0.99, 1, 1.01],
  },
  // Bank 3 (BFSK) — wide detune
  {
    base: [7394.0, 9313.0],
    harmonicMultipliers: [1, 2, 3, 4],
    detuneFactors: [0.97, 0.985, 1, 1.015, 1.03],
  },
];

const DEFAULT_ENERGY = {
  floor: 5e-7,
  on: 6e-4,
  off: 2e-4,
  minToneMs: 40,
  minGapMs: 5,
  ignoreHeadMs: 6,
  envelopeMs: 6,
  hpCutoffHz: 600,
};

class FeskDSP {
  constructor(sampleRate, onCandidate, freqSets, energy) {
    const cfg = { ...DEFAULT_ENERGY, ...energy };
    this.sampleRate = sampleRate;
    this.onCandidate = onCandidate;

    // Energy thresholds
    this.energyFloor = cfg.floor;
    this.energyOn = cfg.on;
    this.energyOff = cfg.off;
    if (this.energyOn < this.energyOff) this.energyOn = this.energyOff;

    // Timing in samples
    this.minToneSamples = Math.max(1, Math.round(cfg.minToneMs * sampleRate / 1000));
    this.minGapSamples = Math.max(1, Math.round(cfg.minGapMs * sampleRate / 1000));
    this.ignoreHeadSamples = Math.max(0, Math.round(cfg.ignoreHeadMs * sampleRate / 1000));

    // Envelope smoothing
    const envSamples = Math.max(1, cfg.envelopeMs * sampleRate / 1000);
    this.energyDecay = Math.exp(-1 / envSamples);
    this.energyRise = 1 - this.energyDecay;
    this.energyEnv = 0;

    // High-pass filter state
    this.hpAlpha = Math.exp(-2 * Math.PI * cfg.hpCutoffHz / sampleRate);
    this.hpLastX = 0;
    this.hpLastY = 0;

    // Tone state
    this.toneActive = false;
    this.toneBuffer = [];
    this.toneSamples = 0;
    this.gapSamples = 0;

    // Build Goertzel banks
    this.banks = this._buildBanks(freqSets || HYBRID_FREQ_SETS);
  }

  _buildBanks(freqSets) {
    const banks = [];
    for (const cfg of freqSets) {
      banks.push(this._buildBank(cfg));
    }
    return banks;
  }

  _buildBank(cfg) {
    const base = Array.isArray(cfg) ? cfg : (cfg.base || []);
    const harmonics = cfg.harmonicMultipliers || [1];
    const detune = cfg.detuneFactors || [1];
    const digitCount = base.length;
    const digits = new Array(digitCount);
    const nyquist = this.sampleRate * 0.49;

    for (let d = 0; d < digitCount; d++) {
      const freqMap = new Map();
      const baseFreq = base[d];
      if (Number.isFinite(baseFreq) && baseFreq > 0) {
        for (const mult of harmonics) {
          const target = baseFreq * mult;
          for (const det of detune) {
            const f = target * det;
            if (f > 0 && f < nyquist) {
              const key = Math.round(f * 10);
              if (!freqMap.has(key)) freqMap.set(key, f);
            }
          }
        }
      }

      let freqArr = Array.from(freqMap.values()).sort((a, b) => a - b);
      if (!freqArr.length && Number.isFinite(baseFreq) && baseFreq > 0 && baseFreq < nyquist) {
        freqArr = [baseFreq];
      }

      const coeffs = new Float32Array(freqArr.length);
      for (let i = 0; i < freqArr.length; i++) {
        coeffs[i] = 2 * Math.cos(2 * Math.PI * freqArr[i] / this.sampleRate);
      }
      digits[d] = { freqs: freqArr, coeffs };
    }
    return { digits };
  }

  _goertzelEnergy(block, digit) {
    if (!digit || !digit.coeffs || !digit.coeffs.length) return 0;
    let energy = 0;
    const coeffs = digit.coeffs;
    for (let i = 0; i < coeffs.length; i++) {
      const c = coeffs[i];
      let s1 = 0, s2 = 0;
      for (let n = 0; n < block.length; n++) {
        const s0 = block[n] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      energy += s1 * s1 + s2 * s2 - c * s1 * s2;
    }
    return energy;
  }

  _finalizeTone() {
    if (!this.toneSamples) return;
    const totalSamples = this.toneSamples;
    const effectiveSamples = Math.max(0, totalSamples - this.ignoreHeadSamples);
    if (totalSamples < this.minToneSamples || effectiveSamples <= 0) {
      this._resetTone();
      return;
    }

    // Trim head
    const start = Math.min(this.ignoreHeadSamples, this.toneBuffer.length);
    const length = this.toneBuffer.length - start;
    if (length <= 0) {
      this._resetTone();
      return;
    }

    const block = new Float32Array(length);
    for (let i = 0; i < length; i++) block[i] = this.toneBuffer[start + i];

    // Hann window edges (5ms taper)
    const w = Math.min(Math.floor(0.005 * this.sampleRate), block.length >> 2);
    if (w > 0) {
      for (let i = 0; i < w; i++) {
        const r = 0.5 - 0.5 * Math.cos(Math.PI * i / (w - 1));
        block[i] *= r;
        block[block.length - 1 - i] *= r;
      }
    }

    // Run Goertzel analysis on all banks
    for (let b = 0; b < this.banks.length; b++) {
      const bank = this.banks[b];
      const digitCount = bank.digits.length;
      if (!digitCount) continue;

      const energies = new Float32Array(digitCount);
      let totalEnergy = 0;
      for (let i = 0; i < digitCount; i++) {
        const e = this._goertzelEnergy(block, bank.digits[i]);
        energies[i] = e;
        totalEnergy += e;
      }

      if (totalEnergy <= this.energyFloor) continue;

      let iMax = 0, vMax = energies[0], v2 = 0;
      for (let i = 1; i < digitCount; i++) {
        if (energies[i] > vMax) {
          v2 = vMax;
          vMax = energies[i];
          iMax = i;
        } else if (energies[i] > v2) {
          v2 = energies[i];
        }
      }

      const score = (vMax - v2) / Math.max(1e-12, totalEnergy);
      this.onCandidate({ bankIndex: b, symbolIndex: iMax, score });
    }

    this._resetTone();
  }

  _resetTone() {
    this.toneActive = false;
    this.toneBuffer = [];
    this.toneSamples = 0;
    this.gapSamples = 0;
  }

  processSamples(samples) {
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];

      // High-pass filter
      const filtered = sample - this.hpLastX + this.hpAlpha * this.hpLastY;
      this.hpLastX = sample;
      this.hpLastY = filtered;

      // Energy envelope
      const energy = filtered * filtered;
      this.energyEnv = this.energyEnv * this.energyDecay + energy * this.energyRise;

      if (!this.toneActive) {
        if (this.energyEnv >= this.energyOn) {
          this.toneActive = true;
          this.toneBuffer = [];
          this.toneSamples = 0;
          this.gapSamples = 0;
        }
      }

      if (this.toneActive) {
        this.toneBuffer.push(filtered);
        this.toneSamples++;

        if (this.energyEnv <= this.energyOff) {
          this.gapSamples++;
          if (this.gapSamples >= this.minGapSamples) {
            this._finalizeTone();
          }
        } else {
          this.gapSamples = 0;
        }
      }
    }
  }
}

export { FeskDSP, HYBRID_FREQ_SETS, DEFAULT_ENERGY };
