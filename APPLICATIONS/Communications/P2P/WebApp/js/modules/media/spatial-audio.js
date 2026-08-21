/**
 * spatial-audio.js - Moteur Audio Spatial 3D & Rendu Binaural HRTF (Pass 4 Hardened)
 * P2P Mesh Workspace (2025/2026)
 * - PannerNode HRTF (casque) et Equalpower (enceintes)
 * - Bus Master avec Compresseur Limiteur Anti-Clipping (-1.5 dBFS)
 * - Table Ronde Virtuelle équidistante (R=1.6m) éliminant les chutes de volume
 * - Fade-In 50ms et Fade-Out 30ms anti-clic
 * - Routage de périphérique de sortie audio (setSinkId) & Head-Tracking readiness
 */

import { logger } from '../../core/logger.js';

export class SpatialAudioEngine {
  constructor(options = {}) {
    this.audioContext = null;
    this.spatialEnabled = true;
    this.panningModel = options.panningModel || 'HRTF';
    this.salonRadius = options.radius || 1.6;
    this.rampDuration = options.rampDuration || 0.08;

    // Nœuds du Master Bus
    this._masterGain = null;
    this._limiter = null;

    // Tables de rétention forte (protection anti-GC Chromium)
    this._sources = new Map(); // peerId -> MediaStreamAudioSourceNode
    this._panners = new Map(); // peerId -> PannerNode
    this._gains = new Map();   // peerId -> GainNode
    this._streams = new Map(); // peerId -> MediaStream
    this._positions = new Map(); // peerId -> { x, y, z }
    this._volumes = new Map(); // peerId -> float [0.0 - 2.0]

    this._currentSinkId = '';
  }

  async ensureContext() {
    if (!this.audioContext) {
      const AudioCtx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
      if (!AudioCtx) return null;

      this.audioContext = new AudioCtx({
        latencyHint: 'interactive',
        sampleRate: 48000
      });

      // 1. Limiteur de dynamique Master (Anti-Clipping / Headroom Protection)
      this._limiter = this.audioContext.createDynamicsCompressor();
      if (this._limiter.threshold && typeof this._limiter.threshold.setValueAtTime === 'function') {
        this._limiter.threshold.setValueAtTime(-1.5, this.audioContext.currentTime); // -1.5 dBFS
        this._limiter.knee.setValueAtTime(3.0, this.audioContext.currentTime);
        this._limiter.ratio.setValueAtTime(20.0, this.audioContext.currentTime);     // Limiteur dur
        this._limiter.attack.setValueAtTime(0.003, this.audioContext.currentTime);   // 3 ms
        this._limiter.release.setValueAtTime(0.100, this.audioContext.currentTime);  // 100 ms
      }

      // 2. Gain Master
      this._masterGain = this.audioContext.createGain();
      if (this._masterGain.gain && typeof this._masterGain.gain.setValueAtTime === 'function') {
        this._masterGain.gain.setValueAtTime(1.0, this.audioContext.currentTime);
      }

      this._limiter.connect(this._masterGain);
      this._masterGain.connect(this.audioContext.destination);

      // 3. Configuration de l'auditeur au centre (0, 0, 0)
      this._setupListener();

      // 4. Application du sinkId si défini
      if (this._currentSinkId && typeof this.audioContext.setSinkId === 'function') {
        try {
          await this.audioContext.setSinkId(this._currentSinkId);
        } catch (err) {
          logger.warn('Media', `[SpatialAudio] Échec application sinkId:`, err);
        }
      }
    }

    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch (e) {
        logger.warn('Media', '[SpatialAudio] Échec reprise AudioContext:', e);
      }
    }

    return this.audioContext;
  }

  _setupListener() {
    const listener = this.audioContext?.listener;
    if (!listener) return;
    const now = this.audioContext.currentTime || 0;

    if (listener.positionX && typeof listener.positionX.setValueAtTime === 'function') {
      listener.positionX.setValueAtTime(0, now);
      if (listener.positionY?.setValueAtTime) listener.positionY.setValueAtTime(0, now);
      if (listener.positionZ?.setValueAtTime) listener.positionZ.setValueAtTime(0, now);
      if (listener.forwardX?.setValueAtTime) listener.forwardX.setValueAtTime(0, now);
      if (listener.forwardY?.setValueAtTime) listener.forwardY.setValueAtTime(0, now);
      if (listener.forwardZ?.setValueAtTime) listener.forwardZ.setValueAtTime(-1, now);
      if (listener.upX?.setValueAtTime) listener.upX.setValueAtTime(0, now);
      if (listener.upY?.setValueAtTime) listener.upY.setValueAtTime(1, now);
      if (listener.upZ?.setValueAtTime) listener.upZ.setValueAtTime(0, now);
    } else if (typeof listener.setPosition === 'function') {
      listener.setPosition(0, 0, 0);
      if (typeof listener.setOrientation === 'function') {
        listener.setOrientation(0, 0, -1, 0, 1, 0);
      }
    }
  }

  async attachRemoteStream(peerId, mediaStream, initialCoords = null) {
    if (!mediaStream || typeof mediaStream.getAudioTracks !== 'function' || mediaStream.getAudioTracks().length === 0) return;

    await this.ensureContext();
    if (!this.audioContext) return;

    this.detachRemoteStream(peerId);

    try {
      const now = this.audioContext.currentTime;
      const x = initialCoords?.x ?? 0;
      const y = initialCoords?.y ?? 0;
      const z = initialCoords?.z ?? -this.salonRadius;

      const source = this.audioContext.createMediaStreamSource(mediaStream);
      const panner = new PannerNode(this.audioContext, {
        panningModel: this.spatialEnabled ? this.panningModel : 'equalpower',
        distanceModel: 'inverse',
        refDistance: 1.5,
        maxDistance: 50,
        rolloffFactor: 0.5,
        coneInnerAngle: 360,
        coneOuterAngle: 360,
        coneOuterGain: 0,
        positionX: this.spatialEnabled ? x : 0,
        positionY: this.spatialEnabled ? y : 0,
        positionZ: this.spatialEnabled ? z : -this.salonRadius,
        orientationX: 0,
        orientationY: 0,
        orientationZ: 1
      });

      const gain = this.audioContext.createGain();
      const userVolume = this._volumes.get(peerId) ?? 1.0;
      if (gain.gain && typeof gain.gain.setValueAtTime === 'function') {
        gain.gain.setValueAtTime(0.0001, now);
        if (typeof gain.gain.exponentialRampToValueAtTime === 'function') {
          gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, userVolume), now + 0.05); // Fade-in 50ms
        } else if (typeof gain.gain.linearRampToValueAtTime === 'function') {
          gain.gain.linearRampToValueAtTime(userVolume, now + 0.05);
        } else {
          gain.gain.setValueAtTime(userVolume, now);
        }
      }

      source.connect(panner);
      panner.connect(gain);
      gain.connect(this._limiter);

      this._sources.set(peerId, source);
      this._panners.set(peerId, panner);
      this._gains.set(peerId, gain);
      this._streams.set(peerId, mediaStream);
      this._positions.set(peerId, { x, y, z });

      logger.info('Media', `🎧 [SpatialAudio] Flux spatialisé attaché pour ${peerId} (Pos: [${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}], Mode: ${this.panningModel})`);
    } catch (err) {
      logger.error('Media', `[SpatialAudio] Erreur attachement spatial pour ${peerId}:`, err);
    }
  }

  setPeerVolume(peerId, volume) {
    const clampedVol = Math.max(0.0, Math.min(2.0, volume));
    this._volumes.set(peerId, clampedVol);

    const gain = this._gains.get(peerId);
    if (gain && this.audioContext) {
      const now = this.audioContext.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(clampedVol, now + 0.03);
    }
  }

  updatePeerPosition(peerId, x, y, z) {
    const panner = this._panners.get(peerId);
    if (!panner || !this.audioContext) return;

    this._positions.set(peerId, { x, y, z });

    const targetX = this.spatialEnabled ? x : 0;
    const targetY = this.spatialEnabled ? y : 0;
    const targetZ = this.spatialEnabled ? z : -this.salonRadius;

    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const duration = this.rampDuration;

    if (panner.positionX && panner.positionX.linearRampToValueAtTime) {
      panner.positionX.cancelScheduledValues(now);
      panner.positionY.cancelScheduledValues(now);
      panner.positionZ.cancelScheduledValues(now);

      panner.positionX.setValueAtTime(panner.positionX.value, now);
      panner.positionY.setValueAtTime(panner.positionY.value, now);
      panner.positionZ.setValueAtTime(panner.positionZ.value, now);

      panner.positionX.linearRampToValueAtTime(targetX, now + duration);
      panner.positionY.linearRampToValueAtTime(targetY, now + duration);
      panner.positionZ.linearRampToValueAtTime(targetZ, now + duration);
    } else if (panner.positionX && panner.positionX.setTargetAtTime) {
      panner.positionX.setTargetAtTime(targetX, now, duration * 0.5);
      panner.positionY.setTargetAtTime(targetY, now, duration * 0.5);
      panner.positionZ.setTargetAtTime(targetZ, now, duration * 0.5);
    } else if (typeof panner.setPosition === 'function') {
      panner.setPosition(targetX, targetY, targetZ);
    }
  }

  updatePositionsRoundTable(activePeerIds = [], arcSpanDegrees = 110) {
    if (!this.spatialEnabled || activePeerIds.length === 0) return;

    const N = activePeerIds.length;
    const R = this.salonRadius;
    const spanRad = (arcSpanDegrees * Math.PI) / 180;

    activePeerIds.forEach((peerId, index) => {
      let theta = 0;
      if (N > 1) {
        theta = -spanRad / 2 + (index * spanRad) / (N - 1);
      }

      const x = R * Math.sin(theta);
      const y = 0;
      const z = -R * Math.cos(theta);

      this.updatePeerPosition(peerId, x, y, z);
    });
  }

  updatePositionsFromGrid(videoGridElement, activePeerIds = []) {
    if (!videoGridElement || !this.spatialEnabled || activePeerIds.length === 0 || typeof document === 'undefined') return;

    const gridRect = videoGridElement.getBoundingClientRect();
    if (gridRect.width === 0 || gridRect.height === 0) return;

    const gridCenterX = gridRect.left + gridRect.width / 2;
    const gridCenterY = gridRect.top + gridRect.height / 2;

    const R = this.salonRadius;
    const MAX_AZIMUTH = (55 * Math.PI) / 180;
    const MAX_ELEVATION = 0.35;

    for (const peerId of activePeerIds) {
      const tile = document.getElementById(`video-tile-${peerId}`);
      if (!tile) continue;

      const tileRect = tile.getBoundingClientRect();
      const tileCenterX = tileRect.left + tileRect.width / 2;
      const tileCenterY = tileRect.top + tileRect.height / 2;

      const normX = Math.max(-1, Math.min(1, (tileCenterX - gridCenterX) / (gridRect.width / 2)));
      const normY = Math.max(-1, Math.min(1, -(tileCenterY - gridCenterY) / (gridRect.height / 2)));

      const theta = normX * MAX_AZIMUTH;
      const targetX = R * Math.sin(theta);
      const targetZ = -R * Math.cos(theta);
      const targetY = normY * MAX_ELEVATION;

      this.updatePeerPosition(peerId, targetX, targetY, targetZ);
    }
  }

  async setSinkId(sinkId) {
    this._currentSinkId = sinkId || '';
    if (this.audioContext && typeof this.audioContext.setSinkId === 'function') {
      try {
        await this.audioContext.setSinkId(this._currentSinkId);
        logger.info('Media', `🎧 [SpatialAudio] Sortie audio définie sur: ${this._currentSinkId || 'default'}`);
      } catch (err) {
        logger.warn('Media', `[SpatialAudio] Échec setSinkId:`, err);
      }
    }
  }

  setSpatialConfig(enabled, model = 'HRTF') {
    this.spatialEnabled = !!enabled;
    this.panningModel = model === 'equalpower' ? 'equalpower' : 'HRTF';

    this._panners.forEach((panner, peerId) => {
      try {
        panner.panningModel = this.spatialEnabled ? this.panningModel : 'equalpower';
        if (!this.spatialEnabled) {
          this.updatePeerPosition(peerId, 0, 0, -this.salonRadius);
        } else {
          const pos = this._positions.get(peerId);
          if (pos) this.updatePeerPosition(peerId, pos.x, pos.y, pos.z);
        }
      } catch (e) {}
    });

    logger.info('Media', `🎧 [SpatialAudio] Config: enabled=${this.spatialEnabled}, model=${this.panningModel}`);
  }

  detachRemoteStream(peerId) {
    const source = this._sources.get(peerId);
    const panner = this._panners.get(peerId);
    const gain = this._gains.get(peerId);

    if (gain && this.audioContext) {
      try {
        const now = this.audioContext.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0.0001, now + 0.03); // Fade out 30ms anti-pop

        setTimeout(() => {
          if (source) { try { source.disconnect(); } catch (e) {} }
          if (panner) { try { panner.disconnect(); } catch (e) {} }
          if (gain) { try { gain.disconnect(); } catch (e) {} }
        }, 35);
      } catch (e) {
        if (source) { try { source.disconnect(); } catch (_) {} }
        if (panner) { try { panner.disconnect(); } catch (_) {} }
        if (gain) { try { gain.disconnect(); } catch (_) {} }
      }
    } else {
      if (source) { try { source.disconnect(); } catch (e) {} }
      if (panner) { try { panner.disconnect(); } catch (e) {} }
      if (gain) { try { gain.disconnect(); } catch (e) {} }
    }

    this._sources.delete(peerId);
    this._panners.delete(peerId);
    this._gains.delete(peerId);
    this._streams.delete(peerId);
    this._positions.delete(peerId);
  }

  destroy() {
    for (const peerId of Array.from(this._sources.keys())) {
      this.detachRemoteStream(peerId);
    }
    if (this._limiter) { try { this._limiter.disconnect(); } catch (e) {} }
    if (this._masterGain) { try { this._masterGain.disconnect(); } catch (e) {} }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }
    this._volumes.clear();
  }
}
