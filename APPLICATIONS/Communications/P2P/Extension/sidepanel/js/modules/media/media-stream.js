import { logger } from '../../core/logger.js';
/**
 * Gestionnaire de Flux Multimédias WebRTC (Micro, Caméra, Écran) & Gestion Conviviale des Permissions
 * Capture et gestion fine des pistes audio/vidéo locales avec redirection automatique vers la page d'autorisation.
 */

export class MediaStreamManager {
  constructor() {
    this.localStream = null;
    this.screenStream = null;
    this.isAudioMuted = false;
    this.isVideoMuted = false;
  }

  /**
   * Vérifie l'état actuel de la permission micro
   */
  async checkAudioPermission() {
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' });
        return status.state; // 'granted', 'prompt', 'denied'
      } catch {}
    }
    return 'prompt';
  }

  /**
   * Ouvre la page dédiée d'autorisation si l'accès a été ignoré ou bloqué
   */
  openPermissionHelper() {
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
      } else {
        window.open('permissions.html', '_blank');
      }
    } catch (e) {
      window.open('permissions.html', '_blank');
    }
  }

  /**
   * Capture le microphone (Audio HD Opus) avec gestion conviviale des erreurs de permission
   */
  async getAudioStream() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000
        },
        video: false
      });
      this.localStream = stream;
      return stream;
    } catch (err) {
      logger.warn('Media', 'Erreur accès microphone:', err.name, err.message);

      if (err.name === 'NotAllowedError' || err.name === 'PermissionDismissedError' || err.message?.includes('dismissed') || err.message?.includes('denied')) {
        logger.info('Media', '💡 Ouverture de la page d\'autorisation utilisateur conviviale...');
        this.openPermissionHelper();
        throw new Error("L'accès au microphone est requis. Un onglet d'autorisation vient d'être ouvert pour activer votre micro en un clic.");
      }

      throw new Error(`Impossible d'accéder au microphone : ${err.message || 'Périphérique introuvable'}`);
    }
  }

  /**
   * Capture la caméra vidéo (720p adaptatif)
   */
  async getVideoStream() {
    try {
      // CORRECTIF : on ne demande QUE la vidéo. L'ancienne version demandait aussi
      // `audio`, ce qui recréait une piste micro et écrasait le flux audio déjà
      // capturé (état de sourdine perdu, VAD analysant l'ancien flux, écho).
      const videoOnly = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 30 }
        }
      });

      const videoTrack = videoOnly.getVideoTracks()[0];

      // On fusionne la piste vidéo dans le flux local existant (qui contient déjà
      // l'audio du micro), pour conserver un seul MediaStream cohérent.
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach(t => { t.stop(); this.localStream.removeTrack(t); });
        this.localStream.addTrack(videoTrack);
      } else {
        this.localStream = videoOnly;
      }
      this.isVideoMuted = false;
      return this.localStream;
    } catch (err) {
      logger.warn('Media', 'Erreur accès caméra:', err.name, err.message);

      if (err.name === 'NotAllowedError' || err.message?.includes('dismissed') || err.message?.includes('denied')) {
        this.openPermissionHelper();
        throw new Error("L'accès à la caméra est requis. Un onglet d'autorisation a été ouvert.");
      }

      throw new Error(`Impossible d'accéder à la caméra : ${err.message || 'Périphérique introuvable'}`);
    }
  }

  /**
   * Coupe RÉELLEMENT la caméra : arrête la piste vidéo (voyant éteint) et la
   * retire du flux local. L'audio du micro est conservé intact.
   */
  stopVideoTrack() {
    if (!this.localStream) return;
    this.localStream.getVideoTracks().forEach(t => {
      t.stop();
      this.localStream.removeTrack(t);
    });
    this.isVideoMuted = false;
  }

  /**
   * Capture le partage d'écran
   */
  async getScreenStream() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor'
        },
        audio: false
      });
      this.screenStream = stream;
      return stream;
    } catch (err) {
      logger.error('Media', 'Erreur partage écran:', err);
      throw new Error("Partage d'écran annulé ou non supporté.");
    }
  }

  /**
   * Active ou désactive le micro local
   */
  toggleAudioMute() {
    if (!this.localStream) return false;
    this.isAudioMuted = !this.isAudioMuted;
    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = !this.isAudioMuted;
    });
    return this.isAudioMuted;
  }

  /**
   * Active ou désactive la caméra locale
   */
  toggleVideoMute() {
    if (!this.localStream) return false;
    this.isVideoMuted = !this.isVideoMuted;
    this.localStream.getVideoTracks().forEach(track => {
      track.enabled = !this.isVideoMuted;
    });
    return this.isVideoMuted;
  }

  /**
   * Arrête toutes les captures actives
   */
  stopAll() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(track => track.stop());
      this.screenStream = null;
    }
  }
}
