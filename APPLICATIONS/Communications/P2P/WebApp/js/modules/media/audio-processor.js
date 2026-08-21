import { logger } from '../../core/logger.js';
/**
 * Processeur Web Audio API & Détection d'Activité Vocale (VAD)
 * Analyse spectrale en temps réel, calcul du volume sonore et indicateur d'orateur actif.
 */

export class AudioProcessor {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.source = null;
    this.dataArray = null;
    this.vadInterval = null;
    this.isSpeaking = false;
    this.onSpeakingChange = null;
  }

  /**
   * Initialise l'analyseur sur un MediaStream audio
   */
  start(audioStream, onSpeakingChange = null) {
    this.onSpeakingChange = onSpeakingChange;

    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.source = this.audioContext.createMediaStreamSource(audioStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.6;

      this.source.connect(this.analyser);
      const bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(bufferLength);

      // Boucle d'évaluation VAD
      this.vadInterval = setInterval(() => {
        this.evaluateSpeakingState();
      }, 100);
    } catch (err) {
      logger.warn('Media', '[AudioProcessor] Impossible d\'initialiser l\'analyseur audio:', err);
    }
  }

  evaluateSpeakingState() {
    if (!this.analyser || !this.dataArray) return;

    this.analyser.getByteFrequencyData(this.dataArray);
    
    // Calcul du volume moyen RMS
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      sum += this.dataArray[i];
    }
    const average = sum / this.dataArray.length;
    const isNowSpeaking = average > 25; // Seuil VAD de détection de voix

    if (isNowSpeaking !== this.isSpeaking) {
      this.isSpeaking = isNowSpeaking;
      if (this.onSpeakingChange) {
        this.onSpeakingChange(this.isSpeaking, average);
      }
    }
  }

  /**
   * Retourne les données fréquentielles actuelles pour le visualiseur Canvas
   */
  getFrequencyData() {
    if (!this.analyser || !this.dataArray) return new Uint8Array(0);
    this.analyser.getByteFrequencyData(this.dataArray);
    return this.dataArray;
  }

  stop() {
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch (e) { logger.debug('Media', 'Erreur source disconnect:', e); }
      this.source = null;
    }
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (e) { logger.debug('Media', 'Erreur audioContext close:', e); }
      this.audioContext = null;
    }
    this.isSpeaking = false;
  }
}
