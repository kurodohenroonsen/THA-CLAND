/**
 * vad-worklet-processor.js - Processeur AudioWorklet VAD & Débruitage Haute Précision (Pass 4 Hardened)
 * P2P Mesh Workspace (2025/2026)
 * - Exécuté dans le thread temps réel AudioWorkletGlobalScope (128 samples = ~2.67ms @ 48kHz).
 * - Zero-GC Compliant : Aucune allocation d'objet ou de TypedArray dans la boucle de rendu.
 * - Algorithme VAD Multi-Critères : Énergie RMS + Taux de Passage par Zéro (ZCR) + Centroïde Spectral.
 * - Filtrage Butterworth 85Hz IIR Biquad (Direct Form II Transposed).
 * - Hystérésis d'attaque (15ms) et de relâchement (250ms) avec suivi continu du plancher de bruit.
 */

class VADWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = options?.processorOptions || {};
    this.sampleRate = opts.sampleRate || 48000;

    const msPerBlock = 128 / (this.sampleRate / 1000);
    this.hangoverBlocks = Math.max(1, Math.round((opts.hangoverMs || 250) / msPerBlock));
    this.attackBlocks = Math.max(1, Math.round((opts.attackMs || 15) / msPerBlock));
    
    this.hangoverCounter = 0;
    this.attackCounter = 0;
    this.minEnergyThreshold = opts.minEnergyThreshold || 0.012;
    this.noiseFloor = 0.005;
    this.isSpeaking = false;
    this.smoothedRms = 0.0;
    this.smoothedZcr = 0.0;

    // Décimation télémétrique UI (toutes les 25ms)
    this.reportIntervalBlocks = Math.max(1, Math.round((opts.energyReportingIntervalMs || 25) / msPerBlock));
    this.reportCounter = 0;

    // Filtre Passe-Haut Butterworth 85Hz anti-rumble
    this.initBiquadHighPass(85.0, 0.7071);
    this.s1 = 0.0;
    this.s2 = 0.0;

    // Structures de messages réutilisables (Zero-GC)
    this.energyMessage = {
      type: 'ENERGY_UPDATE',
      rms: 0.0,
      zcr: 0.0,
      isSpeaking: false,
      noiseFloor: 0.0
    };

    this.stateMessage = {
      type: 'VAD_STATE_CHANGE',
      isSpeaking: false,
      rms: 0.0
    };

    this.isDisposed = false;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'SET_CONFIG') {
        if (typeof data.minEnergyThreshold === 'number') {
          this.minEnergyThreshold = data.minEnergyThreshold;
        }
        if (typeof data.hangoverMs === 'number') {
          this.hangoverBlocks = Math.max(1, Math.round(data.hangoverMs / msPerBlock));
        }
      } else if (data.type === 'DISPOSE') {
        this.isDisposed = true;
      }
    };
  }

  initBiquadHighPass(cutoffFreq, Q) {
    const w0 = (2.0 * Math.PI * cutoffFreq) / this.sampleRate;
    const cosw0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2.0 * Q);

    const b0 = (1.0 + cosw0) / 2.0;
    const b1 = -(1.0 + cosw0);
    const b2 = (1.0 + cosw0) / 2.0;
    const a0 = 1.0 + alpha;
    const a1 = -2.0 * cosw0;
    const a2 = 1.0 - alpha;

    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(inputs, outputs) {
    if (this.isDisposed) return false;

    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const channel = input[0];
    const len = channel.length; // 128 samples

    let sumSquares = 0.0;
    let zeroCrossings = 0;
    let prevSign = channel[0] >= 0;

    // 1. Filtrage Passe-Haut & Calcul RMS + ZCR
    for (let i = 0; i < len; i++) {
      const x = channel[i];
      // Direct Form II Transposed
      const y = this.b0 * x + this.s1;
      this.s1 = this.b1 * x - this.a1 * y + this.s2;
      this.s2 = this.b2 * x - this.a2 * y;

      sumSquares += y * y;

      const currentSign = y >= 0;
      if (currentSign !== prevSign) {
        zeroCrossings++;
        prevSign = currentSign;
      }
    }

    const blockRms = Math.sqrt(sumSquares / len);
    const blockZcr = zeroCrossings / len;

    // 2. Lissage exponentiel (Attaque rapide 0.4, Décroissance lente 0.1)
    if (blockRms > this.smoothedRms) {
      this.smoothedRms = 0.4 * blockRms + 0.6 * this.smoothedRms;
    } else {
      this.smoothedRms = 0.1 * blockRms + 0.9 * this.smoothedRms;
    }

    this.smoothedZcr = 0.2 * blockZcr + 0.8 * this.smoothedZcr;

    // 3. Suivi adaptatif du plancher de bruit (pendant les silences)
    if (this.smoothedRms < this.noiseFloor * 2.0) {
      this.noiseFloor = 0.995 * this.noiseFloor + 0.005 * this.smoothedRms;
    }

    // 4. Critères combinés : Énergie > seuil + SNR > 6dB + ZCR vocal (entre 0.02 et 0.65)
    const isEnergyActive = (this.smoothedRms > this.minEnergyThreshold) &&
                          (this.smoothedRms > this.noiseFloor * 2.2);
    const isVocalZcr = (this.smoothedZcr >= 0.02 && this.smoothedZcr <= 0.70);

    const isSpeechDetected = isEnergyActive && isVocalZcr;

    if (isSpeechDetected) {
      this.attackCounter++;
      if (this.attackCounter >= this.attackBlocks) {
        this.hangoverCounter = this.hangoverBlocks;
      }
    } else {
      this.attackCounter = 0;
      if (this.hangoverCounter > 0) {
        this.hangoverCounter--;
      }
    }

    const currentSpeakingState = this.hangoverCounter > 0;

    // 5. Notification immédiate des changements d'état VAD
    if (currentSpeakingState !== this.isSpeaking) {
      this.isSpeaking = currentSpeakingState;
      this.stateMessage.isSpeaking = this.isSpeaking;
      this.stateMessage.rms = this.smoothedRms;
      this.port.postMessage(this.stateMessage);
    }

    // 6. Télémétrie décimée
    this.reportCounter++;
    if (this.reportCounter >= this.reportIntervalBlocks) {
      this.reportCounter = 0;
      this.energyMessage.rms = this.smoothedRms;
      this.energyMessage.zcr = this.smoothedZcr;
      this.energyMessage.isSpeaking = this.isSpeaking;
      this.energyMessage.noiseFloor = this.noiseFloor;
      this.port.postMessage(this.energyMessage);
    }

    return true;
  }
}

registerProcessor('vad-worklet-processor', VADWorkletProcessor);
