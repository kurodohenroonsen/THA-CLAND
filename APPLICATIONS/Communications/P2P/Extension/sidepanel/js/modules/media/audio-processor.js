import { logger } from '../../core/logger.js';

/**
 * Processeur Web Audio API & Détection d'Activité Vocale (VAD) Hors-Thread Principal
 * Architecture AudioWorklet temps réel conforme Chrome MV3 & WebApp PWA 2025/2026.
 * Chaîne DSP vocale : Passe-Haut 80Hz -> Compresseur Dynamique -> Gain Master -> Limiteur de Crête -> Destination.
 */
export class AudioProcessor {
  constructor() {
    this.audioContext = null;
    this.sourceNode = null;
    this.highpassFilter = null;
    this.compressor = null;
    this.gainNode = null;
    this.limiter = null;
    this.destinationNode = null;
    this.workletNode = null;
    this.analyserNode = null;
    this.frequencyDataArray = null;

    this.isSpeaking = false;
    this.isMuted = false;
    this.currentEnergy = 0.0;
    this.onSpeakingChange = null;
    this.onEnergyUpdate = null;

    // Fallback timer si AudioWorklet non supporté
    this.fallbackInterval = null;
    this.noiseFloorDb = -60.0;
    this.speechStartTime = 0;
    this.speechHoldTimer = null;
  }

  /**
   * Résolution d'URL isomorphique pour charger le script AudioWorklet
   */
  getWorkletUrl() {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL('sidepanel/js/modules/media/vad-worklet-processor.js');
    }
    return new URL('./vad-worklet-processor.js', import.meta.url).href;
  }

  /**
   * Initialise le graphe DSP vocal et l'analyseur VAD
   */
  async start(audioStream, onSpeakingChange = null, onEnergyUpdate = null) {
    this.stop();
    this.onSpeakingChange = onSpeakingChange;
    this.onEnergyUpdate = onEnergyUpdate;
    this.isMuted = false;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx({
        latencyHint: 'interactive',
        sampleRate: 48000
      });

      // Déblocage systématique de la politique Autoplay
      if (this.audioContext.state === 'suspended') {
        logger.debug('Media', 'AudioContext suspendu, réveil en cours...');
        await this.audioContext.resume();
      }

      this.sourceNode = this.audioContext.createMediaStreamSource(audioStream);

      // --- 1. CHAÎNE DSP VOCALE HAUTE FIDÉLITÉ (Personas 5.1 & 5.2) ---
      // A. Filtre Passe-Haut Butterworth 80 Hz (anti-rumble, plosives et vibrations de table)
      this.highpassFilter = this.audioContext.createBiquadFilter();
      this.highpassFilter.type = 'highpass';
      this.highpassFilter.frequency.setValueAtTime(80, this.audioContext.currentTime);
      this.highpassFilter.Q.setValueAtTime(0.707, this.audioContext.currentTime);

      // B. Compresseur de Dynamique Vocale (Soft Vocal Compression)
      this.compressor = this.audioContext.createDynamicsCompressor();
      this.compressor.threshold.setValueAtTime(-24, this.audioContext.currentTime);
      this.compressor.knee.setValueAtTime(12, this.audioContext.currentTime);
      this.compressor.ratio.setValueAtTime(4, this.audioContext.currentTime);
      this.compressor.attack.setValueAtTime(0.003, this.audioContext.currentTime);
      this.compressor.release.setValueAtTime(0.15, this.audioContext.currentTime);

      // C. Contrôle de Gain Maître & Rampe Anti-Pop Mute
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.setValueAtTime(1.0, this.audioContext.currentTime);

      // D. Limiteur de Crête (Brickwall Limiter -1.0 dBFS)
      this.limiter = this.audioContext.createDynamicsCompressor();
      this.limiter.threshold.setValueAtTime(-1.0, this.audioContext.currentTime);
      this.limiter.knee.setValueAtTime(0, this.audioContext.currentTime);
      this.limiter.ratio.setValueAtTime(20, this.audioContext.currentTime);
      this.limiter.attack.setValueAtTime(0.001, this.audioContext.currentTime);
      this.limiter.release.setValueAtTime(0.05, this.audioContext.currentTime);

      // E. Nœud de destination MediaStream pour injection WebRTC
      this.destinationNode = this.audioContext.createMediaStreamDestination();

      // Chaînage DSP Série
      this.sourceNode
        .connect(this.highpassFilter)
        .connect(this.compressor)
        .connect(this.gainNode)
        .connect(this.limiter);

      this.limiter.connect(this.destinationNode);

      // --- 2. ANALYSEUR SPECTRAL POUR VISUALISEUR CANVAS (Persona 5.3) ---
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 128; // 64 bins optimisés pour la voix
      this.analyserNode.smoothingTimeConstant = 0.82;
      this.limiter.connect(this.analyserNode);
      this.frequencyDataArray = new Uint8Array(this.analyserNode.frequencyBinCount);

      // --- 3. DÉTECTION VOCALE VAD (AudioWorklet ou Fallback) (Persona 5.8) ---
      let workletLoaded = false;
      if (this.audioContext.audioWorklet) {
        try {
          const workletUrl = this.getWorkletUrl();
          await this.audioContext.audioWorklet.addModule(workletUrl);

          this.workletNode = new AudioWorkletNode(this.audioContext, 'vad-worklet-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: 1,
            processorOptions: {
              sampleRate: this.audioContext.sampleRate,
              hangoverMs: 350,
              minEnergyThreshold: 0.012,
              energyReportingIntervalMs: 25
            }
          });

          this.workletNode.port.onmessage = (event) => {
            const data = event.data;
            if (!data) return;

            if (data.type === 'VAD_STATE_CHANGE') {
              if (this.isMuted) return;
              this._setSpeaking(data.isSpeaking, Math.round(data.rms * 100));
            } else if (data.type === 'ENERGY_UPDATE') {
              this.currentEnergy = data.rms;
              if (this.onEnergyUpdate && !this.isMuted) {
                this.onEnergyUpdate(data.rms, data.isSpeaking);
              }
            }
          };

          this.sourceNode.connect(this.workletNode);
          workletLoaded = true;
          logger.info('Media', '✅ [AudioProcessor] DSP & AudioWorklet VAD opérationnels (Off-Main-Thread).');
        } catch (workletErr) {
          logger.warn('Media', '[AudioProcessor] Échec chargement AudioWorklet, bascule sur VAD spectral fallback:', workletErr);
        }
      }

      if (!workletLoaded) {
        this._startFallbackVAD();
      }

      return this.destinationNode.stream;
    } catch (err) {
      logger.warn('Media', '[AudioProcessor] Erreur initialisation chaîne DSP:', err);
      return audioStream;
    }
  }

  /**
   * VAD Spectral Fallback basé sur l'analyse fréquentielle de la bande vocale (300Hz - 3400Hz)
   */
  _startFallbackVAD() {
    if (!this.analyserNode || !this.audioContext) return;

    const sampleRate = this.audioContext.sampleRate;
    const binWidth = sampleRate / this.analyserNode.fftSize;
    const minBin = Math.max(1, Math.floor(300 / binWidth));
    const maxBin = Math.min(this.frequencyDataArray.length - 1, Math.ceil(3400 / binWidth));

    const VAD_INTERVAL_MS = 40;
    this.fallbackInterval = setInterval(() => {
      if (!this.analyserNode || !this.frequencyDataArray || this.isMuted) {
        if (this.isSpeaking) this._setSpeaking(false, 0);
        return;
      }

      this.analyserNode.getByteFrequencyData(this.frequencyDataArray);

      let sumSquares = 0;
      let count = 0;
      for (let i = minBin; i <= maxBin; i++) {
        const val = this.frequencyDataArray[i] / 255;
        sumSquares += val * val;
        count++;
      }

      const vocalRms = Math.sqrt(sumSquares / Math.max(1, count));
      const currentDb = vocalRms > 0.0001 ? 20 * Math.log10(vocalRms) : -80;

      // Suivi adaptatif du plancher de bruit
      if (currentDb < this.noiseFloorDb) {
        this.noiseFloorDb += (currentDb - this.noiseFloorDb) * 0.1;
      } else {
        this.noiseFloorDb += (currentDb - this.noiseFloorDb) * 0.02;
      }
      this.noiseFloorDb = Math.max(-75, Math.min(-30, this.noiseFloorDb));

      const isAbove = currentDb > (this.noiseFloorDb + 9.0) && currentDb > -50;
      const now = performance.now();

      if (isAbove) {
        this.speechStartTime = now;
        if (this.speechHoldTimer) {
          clearTimeout(this.speechHoldTimer);
          this.speechHoldTimer = null;
        }
        if (!this.isSpeaking) {
          this._setSpeaking(true, Math.round(vocalRms * 100));
        }
      } else {
        if (this.isSpeaking && !this.speechHoldTimer) {
          this.speechHoldTimer = setTimeout(() => {
            this._setSpeaking(false, 0);
            this.speechHoldTimer = null;
          }, 350);
        }
      }
    }, VAD_INTERVAL_MS);
  }

  _setSpeaking(state, level) {
    if (this.isSpeaking !== state) {
      this.isSpeaking = state;
      if (this.onSpeakingChange) {
        this.onSpeakingChange(this.isSpeaking, level);
      }
    }
  }

  /**
   * Mute acoustique avec rampe exponentielle 25ms (Anti-Pop)
   */
  setMuted(muted, rampDurationMs = 25) {
    this.isMuted = !!muted;
    if (this.gainNode && this.audioContext) {
      const now = this.audioContext.currentTime;
      const targetGain = this.isMuted ? 0.0 : 1.0;
      const timeConstant = rampDurationMs / 3000;

      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.setTargetAtTime(targetGain, now, timeConstant);
    }

    if (this.isMuted && this.isSpeaking) {
      if (this.speechHoldTimer) {
        clearTimeout(this.speechHoldTimer);
        this.speechHoldTimer = null;
      }
      this._setSpeaking(false, 0);
    }
  }

  /**
   * Retourne le flux audio traité prêt pour injection WebRTC
   */
  getProcessedStream() {
    return this.destinationNode?.stream || null;
  }

  /**
   * Données fréquentielles pour le visualiseur Canvas
   */
  getFrequencyData() {
    if (!this.analyserNode || !this.frequencyDataArray || this.isMuted) {
      return null;
    }
    this.analyserNode.getByteFrequencyData(this.frequencyDataArray);
    return this.frequencyDataArray;
  }

  /**
   * Arrêt propre et libération complète de toutes les ressources
   */
  stop() {
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }
    if (this.speechHoldTimer) {
      clearTimeout(this.speechHoldTimer);
      this.speechHoldTimer = null;
    }

    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'DISPOSE' });
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch (e) {}
      this.workletNode = null;
    }

    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (e) {}
      this.sourceNode = null;
    }
    if (this.highpassFilter) {
      try { this.highpassFilter.disconnect(); } catch (e) {}
      this.highpassFilter = null;
    }
    if (this.compressor) {
      try { this.compressor.disconnect(); } catch (e) {}
      this.compressor = null;
    }
    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch (e) {}
      this.gainNode = null;
    }
    if (this.limiter) {
      try { this.limiter.disconnect(); } catch (e) {}
      this.limiter = null;
    }
    if (this.analyserNode) {
      try { this.analyserNode.disconnect(); } catch (e) {}
      this.analyserNode = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }

    this.isSpeaking = false;
    this.isMuted = false;
    this.currentEnergy = 0.0;
    this.frequencyDataArray = null;
  }
}
