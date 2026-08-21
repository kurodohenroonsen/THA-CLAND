/**
 * media-quality-manager.js - Contrôleur de Qualité Média & Adaptation Réseau en Boucle Fermée (Pass 4 Hardened)
 * P2P Mesh Workspace (2025/2026)
 * - Arbitrage de bande passante avec sanctuarisation audio (Audio Priority)
 * - Résilience active sous 20% de perte de paquets (FEC in-band + adaptation Jitter Buffer)
 * - Pilotage dynamique de RTCRtpSender.setParameters (maxBitrate, framerate, scaling)
 * - Pilotage dynamique de RTCRtpReceiver.jitterBufferTarget (40ms à 220ms)
 */

import { logger } from '../../core/logger.js';
import { CONFIG } from '../../core/config.js';

export class MediaQualityManager {
  constructor(meshNetwork) {
    this.mesh = meshNetwork;
    this.adaptationInterval = null;
    this.peerProfiles = new Map();
    this.currentMode = 'crystal';
  }

  start(intervalMs = 2000) {
    this.stop();
    logger.info('MediaQuality', `⚡ Démarrage du gestionnaire de qualité média (${intervalMs}ms)`);

    if (this.mesh.telemetry) {
      this.mesh.telemetry.on('stats-updated', ({ peerId, metrics }) => {
        this.evaluatePeerNetworkState(peerId, metrics);
      });

      this.mesh.telemetry.on('congestion-alert', ({ peerId, severity, metrics }) => {
        this.handleCongestionEmergency(peerId, severity, metrics);
      });
    }

    this.adaptationInterval = setInterval(() => {
      this.adaptAllPeers();
    }, intervalMs);
  }

  stop() {
    if (this.adaptationInterval) {
      clearInterval(this.adaptationInterval);
      this.adaptationInterval = null;
    }
    this.peerProfiles.clear();
  }

  evaluatePeerNetworkState(peerId, metrics) {
    if (!metrics) return;

    const lossPct = Math.max(metrics.audio?.lossPct || 0, metrics.video?.lossPct || 0);
    const rttMs = metrics.rttMs || 40;
    const jitterMs = Math.max(metrics.audio?.jitterMs || 0, metrics.video?.jitterMs || 0);

    let targetMode = 'crystal';
    if (lossPct >= 18 || rttMs > 350) {
      targetMode = 'extreme_loss';
    } else if (lossPct >= 8 || rttMs > 200 || jitterMs > 60) {
      targetMode = 'resilient';
    } else if (lossPct >= 2 || rttMs > 100 || jitterMs > 30) {
      targetMode = 'balanced';
    } else {
      targetMode = 'crystal';
    }

    const prevProfile = this.peerProfiles.get(peerId);
    if (!prevProfile || prevProfile.mode !== targetMode) {
      logger.info('MediaQuality', `📊 [${peerId}] Mode Réseau : ${prevProfile?.mode || 'init'} -> ${targetMode} (Perte: ${lossPct}%, RTT: ${rttMs}ms, Jitter: ${jitterMs}ms)`);
      this.peerProfiles.set(peerId, {
        mode: targetMode,
        lossPct,
        rttMs,
        jitterMs,
        lastAdjusted: Date.now()
      });
      this.applyQualityProfile(peerId, targetMode, lossPct);
    }
  }

  async applyQualityProfile(peerId, mode, lossPct = 0) {
    const peer = this.mesh.peers?.get(peerId);
    if (!peer || !peer.connection || peer.connection.signalingState === 'closed') return;

    const pc = peer.connection;
    const senders = pc.getSenders ? pc.getSenders() : [];

    let audioTargetBitrate = 128000;
    let videoTargetBitrate = 1800000;
    let videoMaxFps = 30;
    let videoScaleDown = 1.0;
    let jitterTargetMs = 40;

    switch (mode) {
      case 'crystal':
        audioTargetBitrate = 128000;
        videoTargetBitrate = 2200000;
        videoMaxFps = 30;
        videoScaleDown = 1.0;
        jitterTargetMs = 40;
        break;

      case 'balanced':
        audioTargetBitrate = 96000;
        videoTargetBitrate = 1200000;
        videoMaxFps = 30;
        videoScaleDown = 1.0;
        jitterTargetMs = 70;
        break;

      case 'resilient':
        audioTargetBitrate = 64000;
        videoTargetBitrate = 450000;
        videoMaxFps = 20;
        videoScaleDown = 1.5;
        jitterTargetMs = 120;
        break;

      case 'extreme_loss':
        audioTargetBitrate = 56000;
        videoTargetBitrate = 180000;
        videoMaxFps = 15;
        videoScaleDown = 2.0;
        jitterTargetMs = Math.min(220, 100 + Math.round(lossPct * 6));
        break;
    }

    for (const sender of senders) {
      if (!sender.track || !sender.getParameters) continue;
      const kind = sender.track.kind;

      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }

        if (kind === 'audio') {
          params.encodings[0].maxBitrate = audioTargetBitrate;
          params.encodings[0].priority = 'high';
          params.encodings[0].networkPriority = 'high';
          await sender.setParameters(params);
        } else if (kind === 'video') {
          params.encodings[0].maxBitrate = videoTargetBitrate;
          params.encodings[0].maxFramerate = videoMaxFps;
          params.encodings[0].scaleResolutionDownBy = videoScaleDown;
          params.encodings[0].priority = mode === 'extreme_loss' ? 'very-low' : 'medium';
          params.encodings[0].networkPriority = mode === 'extreme_loss' ? 'low' : 'medium';
          params.degradationPreference = 'maintain-framerate';
          await sender.setParameters(params);
        }
      } catch (err) {
        logger.debug('MediaQuality', `Erreur sender parameters [${kind}] sur ${peerId}:`, err.message);
      }
    }

    this.applyJitterBufferTarget(pc, jitterTargetMs);
  }

  applyJitterBufferTarget(pc, targetMs) {
    if (!pc || typeof pc.getReceivers !== 'function') return;
    pc.getReceivers().forEach(receiver => {
      if ('jitterBufferTarget' in receiver) {
        receiver.jitterBufferTarget = targetMs;
      } else if ('playoutDelayHint' in receiver) {
        receiver.playoutDelayHint = targetMs / 1000;
      }
    });
  }

  resyncPeerJitterBuffers(pc, offsetMs) {
    if (!pc || typeof pc.getReceivers !== 'function') return;
    logger.info('MediaQuality', `🔄 Réalignement Jitter Buffers A/V (Offset: ${offsetMs}ms)...`);

    pc.getReceivers().forEach(receiver => {
      const kind = receiver.track ? receiver.track.kind : 'unknown';
      let currentTarget = ('jitterBufferTarget' in receiver) ? (receiver.jitterBufferTarget || 50) : 50;

      if (offsetMs > 0 && kind === 'video') {
        const adjusted = Math.min(250, currentTarget + Math.abs(offsetMs));
        if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = adjusted;
      } else if (offsetMs < 0 && kind === 'audio') {
        const adjusted = Math.min(250, currentTarget + Math.abs(offsetMs));
        if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = adjusted;
      }
    });
  }

  handleCongestionEmergency(peerId, severity, metrics) {
    if (severity === 'critical') {
      logger.warn('MediaQuality', `🚨 CONGESTION CRITIQUE avec ${peerId} -> Basculement d'urgence en mode extreme_loss`);
      this.applyQualityProfile(peerId, 'extreme_loss', metrics.audio?.lossPct || 20);
    }
  }

  adaptAllPeers() {
    this.peerProfiles.forEach((profile, peerId) => {
      if (Date.now() - profile.lastAdjusted > 15000) {
        this.applyQualityProfile(peerId, profile.mode, profile.lossPct);
        profile.lastAdjusted = Date.now();
      }
    });
  }
}
