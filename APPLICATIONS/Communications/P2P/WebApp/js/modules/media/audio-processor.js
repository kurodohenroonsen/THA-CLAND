import { logger } from '../../core/logger.js';

/**
 * AudioProcessor - Processeur Web Audio API & Chaîne DSP Vocale Hors-Thread (Pass 4 Hardened)
 * - Déverrouillage automatique de la politique Autoplay (iOS / Safari / Chrome)
 * - Chaîne DSP : Passe-Haut 80Hz -> Compresseur Dynamique -> Gain Maître -> Limiteur Brickwall -1.0 dBFS
 * - AudioWorklet VAD temps réel multi-critères avec fallback ScriptProcessor
 * - Analyseur spectral optimisé (64 bins vocaux) pour visualiseur Canvas 60fps
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
    this.currentZcr = 0.0;
    this.onSpeakingChange = null;
    this.onEnergyUpdate = null;

    this.fallbackInterval = null;
    this._userGestureBound = false;
    this._boundUnlockAudio = this.unlockAudioContext.bind(this);
  }

  getWorkletUrl() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL('sidepanel/js/modules/media/vad-worklet-processor.js');
    }
    return new URL('./vad-worklet-processor.js', import.meta.url).href;
  }

  /**
   * Installe des écouteurs d'action utilisateur pour débloquer l'AudioContext si suspendu
   */
  _bindUserGestureUnlock() {
    if (this._userGestureBound || typeof document === 'undefined') return;
    const events = ['click', 'touchstart', 'touchend', 'keydown'];
    events.forEach(evt => document.addEventListener(evt, this._boundUnlockAudio, { once: true, passive: true }));
    this._userGestureBound = true;
  }

  async unlockAudioContext() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        logger.info('Media', '🔊 AudioContext réactivé suite au geste utilisateur.');
      } catch (e) {
        logger.debug('Media', 'Reprise AudioContext:', e.message);
      }
    }
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
      const AudioCtx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
      if (!AudioCtx) {
        logger.warn('Media', 'AudioContext non disponible dans cet environnement.');
        return null;
      }

      this.audioContext = new AudioCtx({
        latencyHint: 'interactive',
        sampleRate: 48000
      });

      if (this.audioContext.state === 'suspended') {
        this._bindUserGestureUnlock();
        await this.audioContext.resume().catch(() => {});
      }

      if (!audioStream || typeof audioStream.getAudioTracks !== 'function' || audioStream.getAudioTracks().length === 0) {
        logger.warn('Media', 'Flux audio invalide ou sans pistes audio.');
        return null;
      }

      this.sourceNode = this.audioContext.createMediaStreamSource(audioStream);

      // 1. Filtre Passe-Haut Butterworth 80 Hz (anti-rumble, plosives)
      this.highpassFilter = this.audioContext.createBiquadFilter();
      this.highpassFilter.type = 'highpass';
      this.highpassFilter.frequency.setValueAtTime(80, this.audioContext.currentTime);
      this.highpassFilter.Q.setValueAtTime(0.707, this.audioContext.currentTime);

      // 2. Compresseur de Dynamique Vocale
      this.compressor = this.audioContext.createDynamicsCompressor();
      this.compressor.threshold.setValueAtTime(-24, this.audioContext.currentTime);
      this.compressor.knee.setValueAtTime(12, this.audioContext.currentTime);
      this.compressor.ratio.setValueAtTime(4, this.audioContext.currentTime);
      this.compressor.attack.setValueAtTime(0.003, this.audioContext.currentTime);
      this.compressor.release.setValueAtTime(0.15, this.audioContext.currentTime);

      // 3. Contrôle de Gain Maître avec rampe anti-pop
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.setValueAtTime(1.0, this.audioContext.currentTime);

      // 4. Limiteur de Crête Brickwall -1.0 dBFS
      this.limiter = this.audioContext.createDynamicsCompressor();
      this.limiter.threshold.setValueAtTime(-1.0, this.audioContext.currentTime);
      this.limiter.knee.setValueAtTime(0, this.audioContext.currentTime);
      this.limiter.ratio.setValueAtTime(20, this.audioContext.currentTime);
      this.limiter.attack.setValueAtTime(0.001, this.audioContext.currentTime);
      this.limiter.release.setValueAtTime(0.05, this.audioContext.currentTime);

      // 5. Destination MediaStream pour injection WebRTC
      this.destinationNode = this.audioContext.createMediaStreamDestination();

      // Chaînage DSP Série
      this.sourceNode
        .connect(this.highpassFilter)
        .connect(this.compressor)
        .connect(this.gainNode)
        .connect(this.limiter);

      this.limiter.connect(this.destinationNode);

      // 6. Analyseur Spectral (64 bins vocaux)
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 128;
      this.analyserNode.smoothingTimeConstant = 0.82;
      this.limiter.connect(this.analyserNode);
      this.frequencyDataArray = new Uint8Array(this.analyserNode.frequencyBinCount);

      // 7. AudioWorklet VAD
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
              hangoverMs: 250,
              attackMs: 15,
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
              this.currentZcr = data.zcr || 0;
              if (this.onEnergyUpdate && !this.isMuted) {
                this.onEnergyUpdate(data.rms, data.isSpeaking, data.zcr);
              }
            }
          };

          this.sourceNode.connect(this.workletNode);
          workletLoaded = true;
          logger.info('Media', '✅ [AudioProcessor] DSP & AudioWorklet VAD opérationnels.');
        } catch (e) {
          logger.warn('Media', 'AudioWorklet non supporté ou bloqué, activation fallback Analyser:', e.message);
        }
      }

      if (!workletLoaded) {
        this._startFallbackVAD();
      }

      return this.destinationNode.stream;
    } catch (err) {
      logger.error('Media', 'Erreur initialisation AudioProcessor:', err);
      return audioStream;
    }
  }

  _startFallbackVAD() {
    if (this.fallbackInterval) clearInterval(this.fallbackInterval);

    const bufferLength = this.analyserNode?.frequencyBinCount || 64;
    const dataArray = new Uint8Array(bufferLength);

    this.fallbackInterval = setInterval(() => {
      if (!this.analyserNode || this.isMuted) return;

      this.analyserNode.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
      const avg = sum / bufferLength;
      const normalizedRms = avg / 255.0;

      this.currentEnergy = normalizedRms;
      if (this.onEnergyUpdate) this.onEnergyUpdate(normalizedRms, this.isSpeaking);

      const isAbove = normalizedRms > 0.08;
      if (isAbove !== this.isSpeaking) {
        this._setSpeaking(isAbove, Math.round(normalizedRms * 100));
      }
    }, 40);
  }

  _setSpeaking(speaking, volumePercent) {
    if (this.isSpeaking === speaking) return;
    this.isSpeaking = speaking;
    if (this.onSpeakingChange) {
      this.onSpeakingChange(this.isSpeaking, volumePercent);
    }
  }

  setMute(mute) {
    this.isMuted = !!mute;
    if (this.gainNode && this.audioContext) {
      const now = this.audioContext.currentTime;
      // Rampe de gain douce anti-clic (20ms)
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(this.isMuted ? 0.0 : 1.0, now + 0.02);
    }
    if (this.isMuted && this.isSpeaking) {
      this._setSpeaking(false, 0);
    }
  }

  getFrequencyData() {
    if (!this.analyserNode || !this.frequencyDataArray) return null;
    this.analyserNode.getByteFrequencyData(this.frequencyDataArray);
    return this.frequencyDataArray;
  }

  stop() {
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }

    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'DISPOSE' });
        this.workletNode.disconnect();
      } catch (e) {}
      this.workletNode = null;
    }

    const nodes = [this.sourceNode, this.highpassFilter, this.compressor, this.gainNode, this.limiter, this.analyserNode];
    nodes.forEach(node => {
      if (node) { try { node.disconnect(); } catch (e) {} }
    });

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }

    this.isSpeaking = false;
    this.currentEnergy = 0.0;
  }
}
