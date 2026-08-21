/**
 * screen-share-controller.js - Contrôleur de Partage d'Écran et Capture Canvas Haute Performance (Pass 4 Hardened)
 * P2P Mesh Workspace (2025/2026)
 * - Conforme aux standards W3C Media Capture & Screen Share :
 * - CaptureController avec Conditional Focus ('no-focus-change')
 * - Region Capture (CropTarget) & Element Capture (RestrictionTarget)
 * - Presets adaptatifs (detail 15fps, motion 30/60fps, presentation, canvas_whiteboard)
 * - Gestion granulaire du cycle de vie (onended, onmute, onunmute, surfaceSwitching)
 * - Mixage et routage de l'audio système/onglet (systemAudio)
 */

export const SCREEN_PRESETS = Object.freeze({
  DETAIL: {
    name: 'detail',
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution',
    idealFps: 15,
    maxFps: 15,
    idealWidth: 2560,
    idealHeight: 1440,
    maxBitrate: 3_000_000,
    scaleResolutionDownBy: 1.0
  },
  MOTION: {
    name: 'motion',
    contentHint: 'motion',
    degradationPreference: 'maintain-framerate',
    idealFps: 60,
    maxFps: 60,
    idealWidth: 1920,
    idealHeight: 1080,
    maxBitrate: 4_500_000,
    scaleResolutionDownBy: 1.0
  },
  TEXT_PRESENTATION: {
    name: 'text',
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution',
    idealFps: 10,
    maxFps: 15,
    idealWidth: 1920,
    idealHeight: 1080,
    maxBitrate: 1_500_000,
    scaleResolutionDownBy: 1.0
  },
  CANVAS_WHITEBOARD: {
    name: 'canvas_whiteboard',
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution',
    idealFps: 30,
    maxFps: 30,
    idealWidth: 1920,
    idealHeight: 1080,
    maxBitrate: 2_000_000,
    scaleResolutionDownBy: 1.0
  }
});

export class ScreenShareController {
  constructor({ mesh = null, mediaManager = null, onStateChange = null, logger = console } = {}) {
    this.mesh = mesh;
    this.mediaManager = mediaManager;
    this.onStateChange = onStateChange;
    this.logger = logger;

    this.screenStream = null;
    this.activePreset = SCREEN_PRESETS.DETAIL;
    this.captureController = null;
    this.isScreenSharing = false;
    this.isPaused = false;

    this.cropTarget = null;
    this.restrictionTarget = null;
    this._listeners = new Map();

    this.capabilities = {
      captureController: typeof window !== 'undefined' && 'CaptureController' in window,
      cropTarget: typeof window !== 'undefined' && 'CropTarget' in window,
      restrictionTarget: typeof window !== 'undefined' && 'RestrictionTarget' in window,
      offscreenCanvas: typeof window !== 'undefined' && 'OffscreenCanvas' in window
    };
  }

  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  _emit(event, data) {
    this._listeners.get(event)?.forEach(cb => {
      try { cb(data); } catch (e) { this.logger.warn(`[ScreenShareController] Error in ${event} listener:`, e); }
    });
  }

  async startScreenShare(config = {}) {
    if (this.isScreenSharing) {
      this.logger.warn('[ScreenShareController] Partage déjà actif.');
      return this.screenStream;
    }

    const preset = SCREEN_PRESETS[config.preset?.toUpperCase()] || this.activePreset || SCREEN_PRESETS.DETAIL;
    this.activePreset = preset;

    const controller = this.capabilities.captureController ? new window.CaptureController() : null;
    this.captureController = controller;

    const constraints = {
      video: {
        cursor: config.cursor || 'always',
        displaySurface: config.displaySurface || 'monitor',
        width: { ideal: preset.idealWidth, max: 3840 },
        height: { ideal: preset.idealHeight, max: 2160 },
        frameRate: { ideal: preset.idealFps, max: preset.maxFps }
      },
      audio: config.withAudio !== false ? {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        suppressLocalAudioPlayback: true
      } : false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: config.withAudio !== false ? 'include' : 'exclude'
    };

    if (controller) {
      constraints.controller = controller;
    }

    try {
      this.logger.info(`[ScreenShareController] Demande getDisplayMedia (Preset: ${preset.name}, FPS: ${preset.maxFps})...`);
      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);

      if (controller && config.preventFocusChange !== false) {
        try {
          controller.setFocusBehavior('no-focus-change');
        } catch (focusErr) {
          this.logger.debug('[ScreenShareController] setFocusBehavior non supporté:', focusErr.message);
        }
      }

      this.screenStream = stream;
      this.isScreenSharing = true;
      this.isPaused = false;

      const videoTrack = stream.getVideoTracks()[0];
      const audioTracks = stream.getAudioTracks();

      if (!videoTrack) {
        throw new Error("Aucune piste vidéo obtenue dans le flux d'écran.");
      }

      videoTrack.contentHint = preset.contentHint;
      this._bindTrackEvents(videoTrack);

      if (audioTracks.length > 0) {
        this._handleScreenAudio(audioTracks[0]);
      }

      if (this.mesh && typeof this.mesh.replaceVideoTrack === 'function') {
        await this.mesh.replaceVideoTrack(videoTrack, preset.contentHint);
        await this._applyQoSToMesh(preset);
      }

      this._emit('screen_started', { stream, preset });
      if (this.onStateChange) this.onStateChange(true, stream, null);

      return stream;
    } catch (err) {
      this.logger.error('[ScreenShareController] Échec capture écran:', err);
      this._cleanup();
      if (this.onStateChange) this.onStateChange(false, null, err);
      throw err;
    }
  }

  _bindTrackEvents(track) {
    track.onended = () => {
      this.logger.info('[ScreenShareController] 🛑 Arrêt natif du partage détecté (track.onended)');
      this.stopScreenShare();
    };

    track.onmute = () => {
      this.logger.warn('[ScreenShareController] ⚠️ Piste écran passée en sourdine (onmute)');
      this.isPaused = true;
      this._emit('screen_muted', { isPaused: true });
    };

    track.onunmute = () => {
      this.logger.info('[ScreenShareController] 🟢 Piste écran rétablie (onunmute)');
      this.isPaused = false;
      this._emit('screen_unmuted', { isPaused: false });
    };
  }

  _handleScreenAudio(screenAudioTrack) {
    this.logger.info('[ScreenShareController] 🔊 Piste audio système/onglet détectée');
    screenAudioTrack.onended = () => {
      this.logger.info('[ScreenShareController] Piste audio système terminée');
    };
    this._emit('screen_audio_track', screenAudioTrack);
  }

  async _applyQoSToMesh(preset) {
    if (!this.mesh?.peers) return;
    for (const [, peer] of this.mesh.peers) {
      if (!peer.connection) continue;
      const senders = peer.connection.getSenders?.() || [];
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender && videoSender.getParameters) {
        try {
          const params = videoSender.getParameters();
          if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
          
          params.degradationPreference = preset.degradationPreference;
          params.encodings[0].maxFramerate = preset.maxFps;
          params.encodings[0].maxBitrate = preset.maxBitrate;
          params.encodings[0].scaleResolutionDownBy = preset.scaleResolutionDownBy;

          await videoSender.setParameters(params);
        } catch (e) {
          this.logger.debug('[ScreenShareController] Erreur setParameters QoS:', e.message);
        }
      }
    }
  }

  async cropToElement(domElement) {
    if (!this.capabilities.cropTarget || typeof window.CropTarget?.fromElement !== 'function') {
      this.logger.warn('[ScreenShareController] Region Capture (CropTarget) non supporté.');
      return false;
    }
    if (!this.screenStream) throw new Error("Aucun flux d'écran actif.");

    try {
      const cropTarget = await window.CropTarget.fromElement(domElement);
      const track = this.screenStream.getVideoTracks()[0];
      if (track && typeof track.cropTo === 'function') {
        await track.cropTo(cropTarget);
        this.cropTarget = cropTarget;
        this.logger.info('[ScreenShareController] ✂️ Rognage CropTarget appliqué avec succès.');
        this._emit('crop_changed', { mode: 'crop', target: domElement });
        return true;
      }
    } catch (err) {
      this.logger.error('[ScreenShareController] Échec cropToElement:', err);
      throw err;
    }
    return false;
  }

  async restrictToElement(domElement) {
    if (!this.capabilities.restrictionTarget || typeof window.RestrictionTarget?.fromElement !== 'function') {
      this.logger.warn('[ScreenShareController] Element Capture (RestrictionTarget) non supporté.');
      return false;
    }
    if (!this.screenStream) throw new Error("Aucun flux d'écran actif.");

    try {
      const restrictionTarget = await window.RestrictionTarget.fromElement(domElement);
      const track = this.screenStream.getVideoTracks()[0];
      if (track && typeof track.restrictTo === 'function') {
        await track.restrictTo(restrictionTarget);
        this.restrictionTarget = restrictionTarget;
        this.logger.info('[ScreenShareController] 🔒 RestrictionTarget appliqué.');
        this._emit('crop_changed', { mode: 'restrict', target: domElement });
        return true;
      }
    } catch (err) {
      this.logger.error('[ScreenShareController] Échec restrictToElement:', err);
      throw err;
    }
    return false;
  }

  async clearCropping() {
    if (!this.screenStream) return;
    const track = this.screenStream.getVideoTracks()[0];
    if (!track) return;

    try {
      if (this.cropTarget && typeof track.cropTo === 'function') {
        await track.cropTo(null);
        this.cropTarget = null;
      }
      if (this.restrictionTarget && typeof track.restrictTo === 'function') {
        await track.restrictTo(null);
        this.restrictionTarget = null;
      }
      this._emit('crop_changed', { mode: 'none' });
    } catch (err) {
      this.logger.warn('[ScreenShareController] Erreur clearCropping:', err);
    }
  }

  async stopScreenShare(restoreCamera = true) {
    if (!this.isScreenSharing && !this.screenStream) return;

    this.logger.info('[ScreenShareController] Arrêt du partage d\'écran.');
    this._cleanup();

    let restoredCamTrack = null;
    if (restoreCamera && this.mediaManager?.localStream) {
      const camTracks = this.mediaManager.localStream.getVideoTracks();
      if (camTracks.length > 0 && camTracks[0].readyState === 'live') {
        restoredCamTrack = camTracks[0];
      }
    }

    if (this.mesh && typeof this.mesh.replaceVideoTrack === 'function') {
      try {
        await this.mesh.replaceVideoTrack(restoredCamTrack, 'motion');
      } catch (err) {
        this.logger.warn('[ScreenShareController] Erreur restauration piste vidéo:', err);
      }
    }

    this._emit('screen_stopped', { restoredCamera: !!restoredCamTrack });
    if (this.onStateChange) this.onStateChange(false, null, null);
  }

  _cleanup() {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(track => {
        try { track.stop(); } catch {}
      });
      this.screenStream = null;
    }
    this.isScreenSharing = false;
    this.isPaused = false;
    this.cropTarget = null;
    this.restrictionTarget = null;
    this.captureController = null;
  }
}
