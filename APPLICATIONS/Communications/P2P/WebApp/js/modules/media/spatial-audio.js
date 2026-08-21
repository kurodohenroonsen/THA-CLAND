import { logger } from '../../core/logger.js';

/**
 * Moteur de Spatialisation Audio 3D & Positionnement Sonore de la Grille Vidéo (Web Audio API)
 * - Nœuds PannerNode dédiés par flux distant
 * - Modèles de rendu acoustique HRTF (Casque binaural) et Equalpower (Haut-parleurs)
 * - Projection géométrique dynamique de la mosaïque vidéo en coordonnées 3D (X, Y, Z)
 * - Transitions douces setTargetAtTime (anti-zipper noise)
 * - Rétention de références fortes contre le Garbage Collection Chromium
 */
export class SpatialAudioEngine {
  constructor() {
    this.audioContext = null;
    this.spatialEnabled = true;
    this.panningModel = 'HRTF'; // 'HRTF' ou 'equalpower'

    // Références fortes persistantes (protection anti-GC)
    this._sources = new Map(); // peerId -> MediaStreamAudioSourceNode
    this._panners = new Map(); // peerId -> PannerNode
    this._gains = new Map();   // peerId -> GainNode
    this._streams = new Map(); // peerId -> MediaStream
  }

  /**
   * Initialise ou réveille le contexte audio dédié à la spatialisation
   */
  async ensureContext() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx({ latencyHint: 'interactive' });

      // Position de l'auditeur au centre virtuel (0, 0, 0), orienté vers l'écran (-Z)
      const listener = this.audioContext.listener;
      if (listener.positionX) {
        listener.positionX.value = 0;
        listener.positionY.value = 0;
        listener.positionZ.value = 0;
        listener.forwardX.value = 0;
        listener.forwardY.value = 0;
        listener.forwardZ.value = -1;
        listener.upX.value = 0;
        listener.upY.value = 1;
        listener.upZ.value = 0;
      } else if (typeof listener.setPosition === 'function') {
        listener.setPosition(0, 0, 0);
        listener.setOrientation(0, 0, -1, 0, 1, 0);
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

  /**
   * Attache un flux audio distant au graphe de spatialisation
   */
  async attachRemoteStream(peerId, mediaStream) {
    if (!mediaStream || mediaStream.getAudioTracks().length === 0) return;

    await this.ensureContext();
    this.detachRemoteStream(peerId);

    try {
      const source = this.audioContext.createMediaStreamSource(mediaStream);
      const panner = new PannerNode(this.audioContext, {
        panningModel: this.spatialEnabled ? this.panningModel : 'equalpower',
        distanceModel: 'inverse',
        refDistance: 1,
        maxDistance: 100,
        rolloffFactor: 1,
        positionX: 0,
        positionY: 0,
        positionZ: -1.5
      });

      const gain = this.audioContext.createGain();
      gain.gain.value = 1.0;

      source.connect(panner);
      panner.connect(gain);
      gain.connect(this.audioContext.destination);

      this._sources.set(peerId, source);
      this._panners.set(peerId, panner);
      this._gains.set(peerId, gain);
      this._streams.set(peerId, mediaStream);

      logger.info('Media', `🎧 [SpatialAudio] Flux spatialisé attaché pour ${peerId} (Mode: ${this.panningModel})`);
    } catch (err) {
      logger.warn('Media', `[SpatialAudio] Erreur attachement spatial pour ${peerId}:`, err);
    }
  }

  /**
   * Met à jour la position 3D d'un pair avec interpolation temporelle douce
   */
  updatePeerPosition(peerId, x, y, z) {
    const panner = this._panners.get(peerId);
    if (!panner || !this.audioContext) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const SMOOTH_TAU = 0.08; // Constante de lissage tau (80ms anti-zipper noise)

    const targetX = this.spatialEnabled ? x : 0;
    const targetY = this.spatialEnabled ? y : 0;
    const targetZ = this.spatialEnabled ? z : -1.5;

    if (panner.positionX && panner.positionX.setTargetAtTime) {
      panner.positionX.setTargetAtTime(targetX, now, SMOOTH_TAU);
      panner.positionY.setTargetAtTime(targetY, now, SMOOTH_TAU);
      panner.positionZ.setTargetAtTime(targetZ, now, SMOOTH_TAU);
    } else if (typeof panner.setPosition === 'function') {
      panner.setPosition(targetX, targetY, targetZ);
    }
  }

  /**
   * Recalcule les coordonnées 3D de tous les flux distants d'après la géométrie de la grille DOM
   */
  updatePositionsFromGrid(videoGridElement, activePeerIds = []) {
    if (!videoGridElement || !this.spatialEnabled) return;

    const gridRect = videoGridElement.getBoundingClientRect();
    if (gridRect.width === 0 || gridRect.height === 0) return;

    const gridCenterX = gridRect.left + gridRect.width / 2;
    const gridCenterY = gridRect.top + gridRect.height / 2;

    const SPREAD_X = 2.4; // Déviation latérale max (-2.4m gauche, +2.4m droite)
    const SPREAD_Y = 0.7; // Déviation verticale max (-0.7m bas, +0.7m haut)
    const PLANE_Z = -1.5; // Distance focale de l'écran

    for (const peerId of activePeerIds) {
      const tile = document.getElementById(`video-tile-${peerId}`);
      if (!tile) continue;

      const tileRect = tile.getBoundingClientRect();
      const tileCenterX = tileRect.left + tileRect.width / 2;
      const tileCenterY = tileRect.top + tileRect.height / 2;

      const normX = (tileCenterX - gridCenterX) / (gridRect.width / 2);
      const normY = -(tileCenterY - gridCenterY) / (gridRect.height / 2); // Inversion Y CSS vs Web Audio

      const targetX = Math.max(-1, Math.min(1, normX)) * SPREAD_X;
      const targetY = Math.max(-1, Math.min(1, normY)) * SPREAD_Y;

      this.updatePeerPosition(peerId, targetX, targetY, PLANE_Z);
    }
  }

  /**
   * Configure l'activation du son spatialisé et le modèle acoustique
   */
  setSpatialConfig(enabled, model = 'HRTF') {
    this.spatialEnabled = !!enabled;
    this.panningModel = model === 'equalpower' ? 'equalpower' : 'HRTF';

    this._panners.forEach((panner, peerId) => {
      try {
        panner.panningModel = this.spatialEnabled ? this.panningModel : 'equalpower';
        if (!this.spatialEnabled) {
          this.updatePeerPosition(peerId, 0, 0, -1.5);
        }
      } catch (e) {}
    });

    logger.info('Media', `🎧 [SpatialAudio] Configuration: enabled=${this.spatialEnabled}, model=${this.panningModel}`);
  }

  /**
   * Détache un flux distant et libère ses nœuds audio
   */
  detachRemoteStream(peerId) {
    const source = this._sources.get(peerId);
    const panner = this._panners.get(peerId);
    const gain = this._gains.get(peerId);

    if (source) { try { source.disconnect(); } catch (e) {} }
    if (panner) { try { panner.disconnect(); } catch (e) {} }
    if (gain) { try { gain.disconnect(); } catch (e) {} }

    this._sources.delete(peerId);
    this._panners.delete(peerId);
    this._gains.delete(peerId);
    this._streams.delete(peerId);
  }

  /**
   * Ferme l'ensemble du moteur spatial
   */
  destroy() {
    for (const peerId of Array.from(this._sources.keys())) {
      this.detachRemoteStream(peerId);
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }
  }
}
