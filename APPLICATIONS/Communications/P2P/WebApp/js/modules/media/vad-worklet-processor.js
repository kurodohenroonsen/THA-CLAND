/**
 * Processeur AudioWorklet : Filtrage Haute Performance & Détection d'Activité Vocale (VAD)
 * Exécuté dans le thread temps réel AudioWorkletGlobalScope (128 samples = ~2.67ms @ 48kHz).
 * Conforme standard 2025/2026 : Zéro allocation mémoire dans la boucle de rendu (Zero-GC compliant).
 */

class VADWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = options?.processorOptions || {};
    this.sampleRate = opts.sampleRate || 48000;

    // Paramètres VAD & Hystérésis
    const msPerBlock = 128 / (this.sampleRate / 1000);
    this.hangoverBlocks = Math.max(1, Math.round((opts.hangoverMs || 350) / msPerBlock));
    this.hangoverCounter = 0;
    this.minEnergyThreshold = opts.minEnergyThreshold || 0.012;
    this.noiseFloor = 0.005;
    this.isSpeaking = false;
    this.smoothedRms = 0.0;

    // Décimation de la télémétrie d'énergie vers l'UI (ex. toutes les 25ms = ~10 blocs)
    this.reportIntervalBlocks = Math.max(1, Math.round((opts.energyReportingIntervalMs || 25) / msPerBlock));
    this.reportCounter = 0;

    // Coefficients Filtre Passe-Haut IIR Biquad (Butterworth 85Hz @ sampleRate anti-rumble)
    this.initBiquadHighPass(85.0, 0.7071);

    // États du filtre (Direct Form II Transposed)
    this.s1 = 0.0;
    this.s2 = 0.0;

    // Structures de messages pré-allouées (Zero GC Churn)
    this.energyMessage = {
      type: 'ENERGY_UPDATE',
      rms: 0.0,
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
      if (event.data?.type === 'SET_CONFIG') {
        if (typeof event.data.minEnergyThreshold === 'number') {
          this.minEnergyThreshold = event.data.minEnergyThreshold;
        }
      } else if (event.data?.type === 'DISPOSE') {
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

    // Normalisation par a0
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

    // Filtrage Passe-Haut & Calcul de l'énergie RMS
    for (let i = 0; i < len; i++) {
      const x = channel[i];
      // Direct Form II Transposed structure
      const y = this.b0 * x + this.s1;
      this.s1 = this.b1 * x - this.a1 * y + this.s2;
      this.s2 = this.b2 * x - this.a2 * y;

      sumSquares += y * y;
    }

    const blockRms = Math.sqrt(sumSquares / len);

    // Lissage exponentiel de l'énergie (attack 0.4, decay 0.1)
    if (blockRms > this.smoothedRms) {
      this.smoothedRms = 0.4 * blockRms + 0.6 * this.smoothedRms;
    } else {
      this.smoothedRms = 0.1 * blockRms + 0.9 * this.smoothedRms;
    }

    // Suivi adaptatif du plancher de bruit (uniquement en silence relatif)
    if (this.smoothedRms < this.noiseFloor * 2.0) {
      this.noiseFloor = 0.995 * this.noiseFloor + 0.005 * this.smoothedRms;
    }

    // Seuil de détection dynamique : SNR > 6dB (x2.0) et au-dessus du plancher minimal
    const isAboveThreshold = (this.smoothedRms > this.minEnergyThreshold) &&
                             (this.smoothedRms > this.noiseFloor * 2.2);

    if (isAboveThreshold) {
      this.hangoverCounter = this.hangoverBlocks;
    } else if (this.hangoverCounter > 0) {
      this.hangoverCounter--;
    }

    const currentSpeakingState = this.hangoverCounter > 0;

    // 1. Notification immédiate des transitions d'état VAD (front montant / descendant)
    if (currentSpeakingState !== this.isSpeaking) {
      this.isSpeaking = currentSpeakingState;
      this.stateMessage.isSpeaking = this.isSpeaking;
      this.stateMessage.rms = this.smoothedRms;
      this.port.postMessage(this.stateMessage);
    }

    // 2. Décimation de la télémétrie RMS continue vers l'UI
    this.reportCounter++;
    if (this.reportCounter >= this.reportIntervalBlocks) {
      this.reportCounter = 0;
      this.energyMessage.rms = this.smoothedRms;
      this.energyMessage.isSpeaking = this.isSpeaking;
      this.energyMessage.noiseFloor = this.noiseFloor;
      this.port.postMessage(this.energyMessage);
    }

    return true;
  }
}

registerProcessor('vad-worklet-processor', VADWorkletProcessor);
