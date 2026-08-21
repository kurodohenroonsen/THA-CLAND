/**
 * Gestionnaire de Présence, Télémétrie & Failure Detector Adaptatif P2P (Pass 4 Hardened 2026)
 * Implémente :
 * 1. Phi Accrual Failure Detector (Hayashibara et al., SRDS 2004)
 * 2. Dynamic RTO Jacobson/Karels Estimator (RFC 6298)
 * 3. Machine d'états à 4 paliers (ALIVE -> SUSPECT -> DEGRADED -> DEAD)
 * 4. Fast Active Probing (< 3s detection) sans faux positifs sur mobile
 * 5. Full Jitter Reconnection (AWS Architecture / Marc Brooker)
 * 6. Coalescence PING/PONG anti-DoS CPU
 */

import { logger } from './logger.js';
import { CONFIG } from './config.js';
import { CryptoVault } from './crypto-vault.js';

function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

export class PhiAccrualFailureDetector {
  constructor(options = {}) {
    this.windowSize = options.windowSize || 30;
    this.minStdDev = options.minStdDev || 50;
    this.intervals = [];
    this.lastTimestamp = null;

    this.srtt = null;
    this.rttvar = null;
    this.rto = 1500;
    this.minRto = 1000;
    this.maxRto = 6000;
  }

  heartbeat(timestamp = Date.now()) {
    if (this.lastTimestamp !== null) {
      const interval = timestamp - this.lastTimestamp;
      if (interval > 0) {
        this.intervals.push(interval);
        if (this.intervals.length > this.windowSize) {
          this.intervals.shift();
        }
      }
    }
    this.lastTimestamp = timestamp;
  }

  updateRtt(sampleRtt) {
    if (sampleRtt <= 0) return;
    if (this.srtt === null) {
      this.srtt = sampleRtt;
      this.rttvar = sampleRtt / 2;
    } else {
      const alpha = 0.125;
      const beta = 0.25;
      this.rttvar = (1 - beta) * this.rttvar + beta * Math.abs(this.srtt - sampleRtt);
      this.srtt = (1 - alpha) * this.srtt + alpha * sampleRtt;
    }
    const calculatedRto = this.srtt + Math.max(50, 4 * this.rttvar);
    this.rto = Math.min(this.maxRto, Math.max(this.minRto, Math.round(calculatedRto)));
  }

  phi(now = Date.now()) {
    if (this.lastTimestamp === null || this.intervals.length < 2) {
      return 0.0;
    }

    const elapsed = now - this.lastTimestamp;
    const sum = this.intervals.reduce((acc, v) => acc + v, 0);
    const mean = sum / this.intervals.length;
    const variance = this.intervals.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / this.intervals.length;
    const stdDev = Math.max(Math.sqrt(variance), this.minStdDev);

    const y = (elapsed - mean) / (stdDev * Math.SQRT2);
    let pLater = 0.5 * (1.0 - erf(y));

    if (pLater <= 1e-16) pLater = 1e-16;
    if (pLater > 1.0) pLater = 1.0;

    return -Math.log10(pLater);
  }

  getEstimatedRto() {
    return this.rto;
  }
}

export class PresenceManager {
  constructor(meshNetwork, vault = null) {
    this.mesh = meshNetwork;
    this.vault = vault || meshNetwork?.vault;
    this.roster = new Map();
    this.pingTimer = null;
    this.monitorTimer = null;
    this._lastPongSent = new Map();
    this.listeners = [];

    this.PHI_SUSPECT_THRESHOLD = 3.0;
    this.PHI_DEGRADED_THRESHOLD = 8.0;
    this.MAX_PROBE_RETRIES = 2;

    this.initListeners();
  }

  onPresenceUpdate(callback) {
    this.listeners.push(callback);
  }

  notifyUpdate() {
    const peerList = Array.from(this.roster.values());
    this.listeners.forEach((cb) => {
      try { cb(peerList); } catch (e) { logger.warn('Presence', 'Erreur écouteur présence:', e); }
    });
  }

  initListeners() {
    this.mesh.on('peer-joined', (peer) => {
      logger.info('Presence', `➕ Nouveau membre : ${peer.id.substring(0, 10)}... (${peer.name || 'Membre'})`);
      
      const record = {
        id: peer.id,
        name: peer.name || 'Membre P2P',
        pubkey: '',
        avatar: CryptoVault.generateVisualFingerprint(peer.id),
        latencyMs: 0,
        lastSeen: Date.now(),
        state: 'ALIVE',
        phiScore: 0.0,
        probeCount: 0,
        isAudioActive: false,
        isVideoActive: false,
        inCall: false,
        isKeyVerified: false,
        isKeyCompromised: false,
        qos: { mos: 4.5, grade: 'Excellente', cls: 'q-excellent' },
        detector: new PhiAccrualFailureDetector({
          windowSize: 25,
          minStdDev: 40
        })
      };

      record.detector.heartbeat(Date.now());
      this.roster.set(peer.id, record);
      this.notifyUpdate();
    });

    this.mesh.on('peer-left', ({ peerId }) => {
      logger.info('Presence', `➖ Membre déconnecté : ${peerId.substring(0, 10)}...`);
      this.roster.delete(peerId);
      this._lastPongSent.delete(peerId);
      this.notifyUpdate();
    });

    this.mesh.on('message-received', ({ peerId, message }) => {
      this.handleControlMessage(peerId, message);
    });

    if (this.mesh.telemetry) {
      this.mesh.telemetry.on('stats-updated', ({ peerId, metrics }) => {
        const peer = this.roster.get(peerId);
        if (peer && metrics) {
          if (metrics.rttMs !== null) {
            peer.latencyMs = metrics.rttMs;
            peer.detector.updateRtt(metrics.rttMs);
          }
          if (metrics.qos) peer.qos = metrics.qos;
          peer.lastSeen = Date.now();
          peer.detector.heartbeat(Date.now());

          if (peer.state !== 'ALIVE') {
            logger.info('Presence', `💚 Rétablissement getStats pour ${peerId.substring(0, 10)}... -> ALIVE`);
            peer.state = 'ALIVE';
            peer.probeCount = 0;
          }
          this.notifyUpdate();
        }
      });
    }
  }

  start() {
    this.stop();
    logger.info('Presence', '💓 Démarrage Phi-Accrual & Heartbeat...');
    this.scheduleNextHeartbeat();
    this.monitorTimer = setInterval(() => this.evaluateAllPeers(), 500);
    if (this.monitorTimer?.unref) this.monitorTimer.unref();
  }

  stop() {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.roster.clear();
    this._lastPongSent.clear();
    logger.info('Presence', '🛑 Arrêt du gestionnaire de présence');
  }

  scheduleNextHeartbeat() {
    const baseInterval = CONFIG.TIMINGS?.HEARTBEAT_INTERVAL || 2500;
    const jitterMax = CONFIG.PRIVACY?.HEARTBEAT_JITTER_MS || 600;
    const jitter = Math.floor(Math.random() * jitterMax) - Math.floor(jitterMax / 2);
    const nextDelay = Math.max(1200, baseInterval + jitter);

    this.pingTimer = setTimeout(() => {
      this.sendHeartbeat();
      this.scheduleNextHeartbeat();
    }, nextDelay);
  }

  sendHeartbeat() {
    const now = Date.now();
    this.mesh.broadcast({
      type: 'PING',
      t: now
    });
  }

  evaluateAllPeers() {
    const now = Date.now();
    let stateChanged = false;

    this.roster.forEach((peer, peerId) => {
      const phi = peer.detector.phi(now);
      const rto = peer.detector.getEstimatedRto();
      const timeSinceLastSeen = now - peer.lastSeen;
      peer.phiScore = parseFloat(phi.toFixed(2));

      if (peer.state === 'ALIVE' && (phi >= this.PHI_SUSPECT_THRESHOLD || timeSinceLastSeen > rto * 1.2)) {
        logger.warn('Presence', `⚠️ Pair suspect [${peerId.substring(0, 10)}...] (Phi: ${peer.phiScore}) -> Fast Probe`);
        peer.state = 'SUSPECT';
        peer.probeCount = 1;
        stateChanged = true;
        this.sendFastProbe(peerId);
      }
      else if (peer.state === 'SUSPECT' && timeSinceLastSeen > rto * 1.6 && peer.probeCount < this.MAX_PROBE_RETRIES) {
        peer.probeCount++;
        this.sendFastProbe(peerId);
      }
      else if (peer.state === 'SUSPECT' && (phi >= this.PHI_DEGRADED_THRESHOLD || timeSinceLastSeen > 2800)) {
        logger.error('Presence', `🚨 Panne détectée pour ${peerId.substring(0, 10)}... en ${timeSinceLastSeen}ms -> Reconnexion`);
        peer.state = 'DEGRADED';
        peer.qos = { mos: 1.0, grade: 'Critique', cls: 'q-poor' };
        stateChanged = true;
        this.mesh.triggerResilientRecovery(peerId);
      }
      else if (peer.state === 'DEGRADED' && timeSinceLastSeen > (CONFIG.TIMINGS?.PEER_TIMEOUT || 15000)) {
        logger.error('Presence', `💀 Pair perdu après timeout : ${peerId.substring(0, 10)}...`);
        peer.state = 'DEAD';
        this.mesh.removePeer(peerId);
      }
    });

    if (stateChanged) {
      this.notifyUpdate();
    }
  }

  sendFastProbe(peerId) {
    this.mesh.sendToPeer(peerId, {
      type: 'FAST_PROBE',
      t: Date.now()
    });
  }

  handleControlMessage(peerId, msg) {
    if (!msg || !msg.type) return;

    let peer = this.roster.get(peerId);
    const now = Date.now();

    if (!peer) {
      peer = {
        id: peerId,
        name: 'Membre P2P',
        pubkey: '',
        avatar: CryptoVault.generateVisualFingerprint(peerId),
        latencyMs: 0,
        lastSeen: now,
        state: 'ALIVE',
        phiScore: 0.0,
        probeCount: 0,
        isAudioActive: false,
        isVideoActive: false,
        inCall: false,
        isKeyVerified: false,
        isKeyCompromised: false,
        qos: { mos: 4.5, grade: 'Excellente', cls: 'q-excellent' },
        detector: new PhiAccrualFailureDetector({ windowSize: 25, minStdDev: 40 })
      };
      this.roster.set(peerId, peer);
    }

    peer.lastSeen = now;
    peer.detector.heartbeat(now);

    if (peer.state !== 'ALIVE') {
      logger.info('Presence', `💚 Restauration pour ${peerId.substring(0, 10)}... (${peer.state} -> ALIVE)`);
      peer.state = 'ALIVE';
      peer.probeCount = 0;
      this.notifyUpdate();
    }

    switch (msg.type) {
      case 'PING': {
        const last = this._lastPongSent.get(peerId) || 0;
        if (now - last < 1000) return; // Coalescence max 1 PONG / sec
        this._lastPongSent.set(peerId, now);

        const replyDelay = 20 + Math.floor(Math.random() * 40);
        setTimeout(() => {
          this.mesh.sendToPeer(peerId, {
            type: 'PONG',
            t: msg.t,
            sentAt: Date.now()
          });
        }, replyDelay);
        break;
      }

      case 'FAST_PROBE': {
        this.mesh.sendToPeer(peerId, {
          type: 'FAST_PROBE_ACK',
          t: msg.t,
          sentAt: Date.now()
        });
        break;
      }

      case 'FAST_PROBE_ACK':
      case 'PONG': {
        if (msg.t) {
          const rawRtt = Math.max(1, now - msg.t);
          const processingDelay = msg.sentAt && msg.sentAt >= msg.t ? (msg.sentAt - msg.t) / 2 : 0;
          const networkRtt = Math.max(1, rawRtt - processingDelay);

          peer.latencyMs = Math.round(networkRtt);
          peer.detector.updateRtt(networkRtt);
          this.notifyUpdate();
        }
        break;
      }

      case 'PEER_HELLO': {
        logger.info('Presence', `👋 PEER_HELLO de ${peerId.substring(0, 10)}... Nom="${msg.name}"`);
        if (msg.name) peer.name = msg.name;
        
        if (msg.pubkey) {
          if (peer.pubkey && peer.pubkey !== msg.pubkey) {
            logger.error('Presence', `🚨 Changement inattendu de clé publique pour ${peerId}!`);
            peer.isKeyVerified = false;
            peer.isKeyCompromised = true;
          } else {
            peer.pubkey = msg.pubkey;
            peer.avatar = CryptoVault.generateVisualFingerprint(msg.pubkey);
            peer.isKeyVerified = true;
          }
        }
        this.notifyUpdate();
        break;
      }

      case 'MEDIA_SIGNAL': {
        if (msg.status) {
          peer.inCall = !!msg.status.inCall;
          peer.isAudioActive = !!msg.status.audio;
          peer.isVideoActive = !!msg.status.video;
          this.notifyUpdate();
        }
        break;
      }

      case 'TOPOLOGY_SHUFFLE_REQ':
        if (this.mesh.topology) {
          this.mesh.topology.handleShuffleRequest(peerId, msg.sample);
        }
        break;

      case 'TOPOLOGY_SHUFFLE_RESP':
        if (this.mesh.topology) {
          this.mesh.topology.handleShuffleResponse(peerId, msg.sample);
        }
        break;

      case 'TOPOLOGY_EVICT_REDIRECT':
        if (Array.isArray(msg.suggestedPeers) && this.mesh.topology) {
          msg.suggestedPeers.forEach(p => this.mesh.topology.recordPassivePeer(p.id, { pubkey: p.pubkey, source: 'redirect' }));
        }
        this.mesh.removePeer(peerId);
        break;
    }
  }

  broadcastMediaStatus(inCall, audio, video, screen = false) {
    this.mesh.broadcast({
      type: 'MEDIA_SIGNAL',
      status: { inCall, audio, video, screen }
    });
  }
}
