/**
 * Moteur de Télémétrie WebRTC, Monitoring QoS & Contrôle de Congestion (2025/2026)
 * Conforme W3C WebRTC Stats Identifier Registry & ITU-T G.107 E-Model (eMOS).
 */

import { logger } from './logger.js';

export class WebRTCTelemetryEngine {
  constructor(meshNetwork) {
    this.mesh = meshNetwork;
    this.peerStatsHistory = new Map(); // peerId -> { prevStats: Map, lastPollTime: number }
    this.pollInterval = null;
    this.listeners = new Map(); // event -> callbacks[]
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try { cb(data); } catch (e) { logger.warn('Telemetry', `Erreur écouteur ${event}:`, e); }
      });
    }
  }

  start(intervalMs = 2000) {
    if (this.pollInterval) clearInterval(this.pollInterval);
    logger.info('Telemetry', `📊 Démarrage monitoring getStats() périodique (${intervalMs}ms)`);
    this.pollInterval = setInterval(() => this.pollAllPeers(), intervalMs);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.peerStatsHistory.clear();
    logger.info('Telemetry', '🛑 Arrêt du moteur de télémétrie WebRTC');
  }

  async pollAllPeers() {
    if (!this.mesh || !this.mesh.peers || this.mesh.peers.size === 0) return;

    for (const [peerId, peer] of this.mesh.peers) {
      if (!peer.connection || peer.connection.iceConnectionState !== 'connected') continue;
      try {
        const metrics = await this.samplePeerStats(peerId, peer.connection);
        if (metrics) {
          this.emit('stats-updated', { peerId, metrics });
          this.evaluateCongestion(peerId, metrics);
        }
      } catch (err) {
        logger.debug('Telemetry', `Erreur échantillonnage stats pour ${peerId}:`, err.message);
      }
    }
  }

  async samplePeerStats(peerId, pc) {
    if (!pc || typeof pc.getStats !== 'function') return null;
    const rawReport = await pc.getStats();
    const now = Date.now();
    const history = this.peerStatsHistory.get(peerId) || { prevStats: new Map(), lastPollTime: now };

    let candidatePairStats = null;
    let audioInbound = null;
    let videoInbound = null;
    let videoOutbound = null;
    let localCandidate = null;
    let remoteCandidate = null;
    const candidates = new Map();

    rawReport.forEach(report => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) {
        candidatePairStats = report;
      } else if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
        candidates.set(report.id, report);
      } else if (report.type === 'inbound-rtp') {
        if (report.kind === 'audio') audioInbound = report;
        else if (report.kind === 'video') videoInbound = report;
      } else if (report.type === 'outbound-rtp' && report.kind === 'video') {
        videoOutbound = report;
      }
    });

    if (candidatePairStats) {
      localCandidate = candidates.get(candidatePairStats.localCandidateId);
      remoteCandidate = candidates.get(candidatePairStats.remoteCandidateId);
    }

    const prevReportMap = history.prevStats;
    const deltaSec = Math.max(0.5, (now - history.lastPollTime) / 1000);

    // 1. RTT Réseau Transport Réel
    const rttMs = candidatePairStats && candidatePairStats.currentRoundTripTime !== undefined
      ? Math.round(candidatePairStats.currentRoundTripTime * 1000)
      : null;
    const availableOutgoingBitrate = candidatePairStats?.availableOutgoingBitrate || null;

    // 2. Métriques Audio Entrantes
    let audioMetrics = { jitterMs: 0, lossPct: 0, bitrateKbps: 0, concealedRatio: 0 };
    if (audioInbound) {
      const prev = prevReportMap.get(audioInbound.id);
      if (prev) {
        const dLost = Math.max(0, audioInbound.packetsLost - prev.packetsLost);
        const dRecv = Math.max(0, audioInbound.packetsReceived - prev.packetsReceived);
        const dTotal = dLost + dRecv;
        const lossPct = dTotal > 0 ? (dLost / dTotal) * 100 : 0;
        const dBytes = Math.max(0, audioInbound.bytesReceived - prev.bytesReceived);
        const bitrateKbps = Math.round((dBytes * 8) / (deltaSec * 1000));
        const dConcealed = Math.max(0, (audioInbound.concealedSamples || 0) - (prev.concealedSamples || 0));
        const dSamples = Math.max(1, (audioInbound.totalSamplesReceived || 1) - (prev.totalSamplesReceived || 0));

        audioMetrics = {
          jitterMs: Math.round((audioInbound.jitter || 0) * 1000),
          lossPct: parseFloat(lossPct.toFixed(1)),
          bitrateKbps,
          concealedRatio: parseFloat((dConcealed / dSamples).toFixed(2))
        };
      }
      prevReportMap.set(audioInbound.id, audioInbound);
    }

    // 3. Métriques Vidéo Entrantes
    let videoMetrics = { jitterMs: 0, lossPct: 0, bitrateKbps: 0, framesDropped: 0 };
    if (videoInbound) {
      const prev = prevReportMap.get(videoInbound.id);
      if (prev) {
        const dLost = Math.max(0, videoInbound.packetsLost - prev.packetsLost);
        const dRecv = Math.max(0, videoInbound.packetsReceived - prev.packetsReceived);
        const dTotal = dLost + dRecv;
        const lossPct = dTotal > 0 ? (dLost / dTotal) * 100 : 0;
        const dBytes = Math.max(0, videoInbound.bytesReceived - prev.bytesReceived);
        const bitrateKbps = Math.round((dBytes * 8) / (deltaSec * 1000));

        videoMetrics = {
          jitterMs: Math.round((videoInbound.jitter || 0) * 1000),
          lossPct: parseFloat(lossPct.toFixed(1)),
          bitrateKbps,
          framesDropped: Math.max(0, (videoInbound.framesDropped || 0) - (prev.framesDropped || 0))
        };
      }
      prevReportMap.set(videoInbound.id, videoInbound);
    }

    // 4. Calcul de la Synchronisation A/V & Lip-Sync (Persona 5.9 ITU-R BT.1359-1)
    let avSyncOffsetMs = null;
    if (audioInbound?.estimatedPlayoutTimestamp && videoInbound?.estimatedPlayoutTimestamp) {
      avSyncOffsetMs = Math.round(audioInbound.estimatedPlayoutTimestamp - videoInbound.estimatedPlayoutTimestamp);
      if (Math.abs(avSyncOffsetMs) > 80) {
        this.emit('av-desync-detected', { peerId, offsetMs: avSyncOffsetMs });
      }
    }

    // 5. Calcul Score QoS eMOS
    const effectiveRtt = rttMs !== null ? rttMs : 30;
    const effectiveJitter = Math.max(audioMetrics.jitterMs, videoMetrics.jitterMs);
    const effectiveLoss = Math.max(audioMetrics.lossPct, videoMetrics.lossPct);
    const qos = this.computeEMOS(effectiveRtt, effectiveJitter, effectiveLoss);

    // Mise à jour de l'historique
    history.lastPollTime = now;
    this.peerStatsHistory.set(peerId, history);

    return {
      timestamp: now,
      rttMs: effectiveRtt,
      avSyncOffsetMs,
      availableOutgoingBitrate,
      qualityLimitationReason: videoOutbound?.qualityLimitationReason || 'none',
      audio: audioMetrics,
      video: videoMetrics,
      qos,
      connectionPath: {
        localType: localCandidate?.candidateType || 'unknown',
        remoteType: remoteCandidate?.candidateType || 'unknown',
        isRelayed: localCandidate?.candidateType === 'relay' || remoteCandidate?.candidateType === 'relay',
        isDirectLAN: localCandidate?.candidateType === 'host' && remoteCandidate?.candidateType === 'host'
      }
    };
  }

  computeEMOS(rttMs, jitterMs, packetLossPct) {
    const d = (rttMs || 20) + ((jitterMs || 2) * 2) + 10;
    let r = d < 160 ? 93.2 - (d / 40) : 93.2 - ((d - 120) / 10);
    r = Math.max(0, r - ((packetLossPct || 0) * 2.5));

    let mos = 1.0;
    if (r >= 100) mos = 4.5;
    else if (r > 0) {
      mos = 1 + (0.035 * r) + (0.000007 * r * (r - 60) * (100 - r));
      mos = Math.min(4.5, Math.max(1.0, mos));
    }

    let grade = 'Critique', cls = 'q-poor';
    if (mos >= 4.1) { grade = 'Excellente'; cls = 'q-excellent'; }
    else if (mos >= 3.6) { grade = 'Bonne'; cls = 'q-good'; }
    else if (mos >= 2.8) { grade = 'Dégradée'; cls = 'q-medium'; }

    return { mos: parseFloat(mos.toFixed(2)), rFactor: parseFloat(r.toFixed(1)), grade, cls };
  }

  evaluateCongestion(peerId, metrics) {
    if (metrics.qos.mos < 2.8 || metrics.audio.lossPct > 6.0 || metrics.rttMs > 350) {
      this.emit('congestion-alert', {
        peerId,
        severity: metrics.qos.mos < 2.0 ? 'critical' : 'warning',
        metrics
      });
    }
  }
}
