import { logger } from '../../core/logger.js';

/**
 * Gestionnaire des Périphériques Média, Flux Audio/Vidéo & Partage d'Écran
 * Conforme aux standards W3C Media Capture & Streams 2025/2026 :
 * - Énumération sécurisée des périphériques (audioinput, audiooutput, videoinput)
 * - Surveillance d'événements matériels (devicechange, track.onended)
 * - Isolation vocale IA (voiceIsolation: true) & Capture Mono 48 kHz
 * - Partage d'écran avancé (CaptureController no-focus-change, selfBrowserSurface, surfaceSwitching)
 * - Commutation à chaud de périphériques
 */
export class MediaStreamManager {
  constructor() {
    this.localStream = null;
    this.screenStream = null;
    this.isAudioMuted = false;
    this.isVideoMuted = false;

    this.selectedAudioInputId = '';
    this.selectedAudioOutputId = '';
    this.selectedVideoInputId = '';

    this.deviceChangeListeners = new Set();
    this.onTrackEndedCallback = null;
  }

  /**
   * Énumère de manière sécurisée tous les périphériques matériels
   */
  async getAvailableDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return { audioInputs: [], audioOutputs: [], videoInputs: [] };
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        audioInputs: devices.filter(d => d.kind === 'audioinput'),
        audioOutputs: devices.filter(d => d.kind === 'audiooutput'),
        videoInputs: devices.filter(d => d.kind === 'videoinput')
      };
    } catch (err) {
      logger.error('Media', 'Erreur enumerateDevices:', err);
      return { audioInputs: [], audioOutputs: [], videoInputs: [] };
    }
  }

  /**
   * Installe l'écouteur anti-rebond sur 'devicechange' (Persona 5.6)
   */
  initDeviceChangeListener() {
    if (!navigator.mediaDevices?.addEventListener) return;
    let debounceTimer = null;
    navigator.mediaDevices.addEventListener('devicechange', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        logger.info('Media', '🔌 Changement matériel détecté (devicechange)');
        const devices = await this.getAvailableDevices();
        this.deviceChangeListeners.forEach(listener => {
          try { listener(devices); } catch (e) { logger.warn('Media', 'Listener error:', e); }
        });
      }, 400);
    });
  }

  onDeviceChange(callback) {
    this.deviceChangeListeners.add(callback);
    return () => this.deviceChangeListeners.delete(callback);
  }

  /**
   * Ouvre la page d'aide aux permissions matérielles
   */
  openPermissionHelper() {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.runtime?.getURL) {
      const permUrl = chrome.runtime.getURL('permissions.html');
      chrome.tabs.create({ url: permUrl });
    } else if (typeof window !== 'undefined') {
      window.open('permissions.html', '_blank', 'noopener,noreferrer');
    }
  }

  /**
   * Capture le flux audio du microphone avec isolation vocale et ciblage de périphérique
   */
  async getAudioStream(deviceId = null) {
    if (deviceId) this.selectedAudioInputId = deviceId;

    const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {};

    const audioConstraints = {
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      latency: { ideal: 0.01, max: 0.03 }
    };

    // Activation de l'isolation vocale IA système W3C (Chrome 126+ / Apple)
    if (supported.voiceIsolation) {
      audioConstraints.voiceIsolation = true;
    }

    if (this.selectedAudioInputId && this.selectedAudioInputId !== 'default') {
      audioConstraints.deviceId = { exact: this.selectedAudioInputId };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });

      this.localStream = stream;
      this.isAudioMuted = false;

      // Surveillance du débranchement physique (track.onended)
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => {
          logger.warn('Media', '⚠️ Piste micro arrêtée de force (débranchement matériel)');
          if (this.onTrackEndedCallback) this.onTrackEndedCallback('audio');
        };
      }

      return stream;
    } catch (err) {
      logger.warn('Media', 'Erreur accès microphone avec contraintes avancées, tentative fallback:', err.name, err.message);
      try {
        const fallbackStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false
        });
        this.localStream = fallbackStream;
        this.isAudioMuted = false;
        return fallbackStream;
      } catch (fallbackErr) {
        if (fallbackErr.name === 'NotAllowedError' || fallbackErr.name === 'PermissionDismissedError') {
          this.openPermissionHelper();
          throw new Error("L'accès au microphone est requis. Veuillez autoriser le périphérique.");
        }
        throw new Error(`Impossible d'accéder au microphone : ${fallbackErr.message}`);
      }
    }
  }

  /**
   * Capture le flux vidéo de la caméra avec contrainte de périphérique ciblée
   */
  async getVideoStream(deviceId = null) {
    if (deviceId) this.selectedVideoInputId = deviceId;

    const videoConstraints = {
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      frameRate: { ideal: 30, max: 30 }
    };

    if (this.selectedVideoInputId && this.selectedVideoInputId !== 'default') {
      videoConstraints.deviceId = { exact: this.selectedVideoInputId };
    }

    try {
      const videoOnly = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
      const videoTrack = videoOnly.getVideoTracks()[0];

      if (videoTrack) {
        videoTrack.onended = () => {
          logger.warn('Media', '⚠️ Piste caméra arrêtée de force (débranchement)');
          if (this.onTrackEndedCallback) this.onTrackEndedCallback('video');
        };
      }

      if (this.localStream) {
        this.localStream.getVideoTracks().forEach(t => {
          t.stop();
          this.localStream.removeTrack(t);
        });
        this.localStream.addTrack(videoTrack);
      } else {
        this.localStream = videoOnly;
      }
      this.isVideoMuted = false;
      return this.localStream;
    } catch (err) {
      logger.warn('Media', 'Erreur accès caméra:', err.name, err.message);
      if (err.name === 'NotAllowedError') {
        this.openPermissionHelper();
        throw new Error("L'accès à la caméra est requis.");
      }
      throw new Error(`Impossible d'accéder à la caméra : ${err.message}`);
    }
  }

  /**
   * Capture le partage d'écran avec options modernes 2025/2026 (Persona 5.5)
   */
  async getScreenStream(options = {}) {
    try {
      const controller = typeof CaptureController !== 'undefined' ? new CaptureController() : null;

      const constraints = {
        video: {
          cursor: options.cursor || 'always',
          displaySurface: options.displaySurface || 'monitor',
          width: { ideal: 1920, max: 2560 },
          height: { ideal: 1080, max: 1440 },
          frameRate: { ideal: 30, max: 30 }
        },
        audio: options.withAudio ? {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          suppressLocalAudioPlayback: true
        } : false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include'
      };

      if (controller) {
        constraints.controller = controller;
      }

      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);

      // Empêche le basculement forcé du focus vers l'application capturée (Side Panel preservation)
      if (controller) {
        try {
          controller.setFocusBehavior('no-focus-change');
        } catch (e) {
          logger.debug('Media', 'CaptureController setFocusBehavior non supporté:', e.message);
        }
      }

      this.screenStream = stream;
      return stream;
    } catch (err) {
      logger.error('Media', 'Erreur capture d\'écran:', err);
      throw new Error("Partage d'écran annulé ou non supporté.");
    }
  }

  /**
   * Bascule l'état de coupure micro
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
   * Bascule l'état de coupure caméra
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
   * Surveillance dynamique des permissions matérielles (Persona 5.6)
   */
  async queryAllHardwarePermissions(onStatusChange = null) {
    const results = { microphone: 'prompt', camera: 'prompt', speakerSelection: 'prompt' };
    if (!navigator.permissions?.query) return results;

    const queries = [
      { key: 'microphone', name: 'microphone' },
      { key: 'camera', name: 'camera' },
      { key: 'speakerSelection', name: 'speaker-selection' }
    ];

    for (const q of queries) {
      try {
        const status = await navigator.permissions.query({ name: q.name });
        results[q.key] = status.state;
        status.onchange = () => {
          logger.info('Media', `Permission ${q.name} modifiée : ${status.state}`);
          if (onStatusChange) onStatusChange(q.key, status.state);
        };
      } catch {}
    }
    return results;
  }

  /**
   * Libère toutes les pistes locales et partages d'écran
   */
  stopAllStreams() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(track => track.stop());
      this.screenStream = null;
    }
    this.isAudioMuted = false;
    this.isVideoMuted = false;
  }
}
