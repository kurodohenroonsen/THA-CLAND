import { logger } from './logger.js';
/**
 * Gestionnaire de Présence, Télémétrie & Battements de Cœur (Heartbeat) P2P (2025/2026)
 * Identicons vectoriels déterministes SVG, Détection d'usurpation / Changement de Clé Publique,
 * et Heartbeat avec Jitter aléatoire anti-fingerprinting.
 */

import { CONFIG } from './config.js';
import { CryptoVault } from './crypto-vault.js';

export class PresenceManager {
  constructor(meshNetwork) {
    this.mesh = meshNetwork;
    this.roster = new Map(); // peerId -> { id, name, pubkey, avatar, latencyMs, lastSeen, isAudioActive, isVideoActive, inCall, isKeyVerified }
    this.pingTimeout = null;
    this.listeners = [];

    this.initListeners();
  }

  onPresenceUpdate(callback) {
    this.listeners.push(callback);
  }

  notifyUpdate() {
    const peerList = Array.from(this.roster.values());
    this.listeners.forEach((cb) => cb(peerList));
  }

  initListeners() {
    this.mesh.on('peer-joined', (peer) => {
      logger.info('Presence', `➕ Nouveau membre détecté dans la présence: ${peer.id.substring(0, 10)}... (${peer.name || 'Membre'})`);
      this.roster.set(peer.id, {
        id: peer.id,
        name: peer.name || 'Membre P2P',
        pubkey: '',
        avatar: CryptoVault.generateVisualFingerprint(peer.id),
        latencyMs: 0,
        lastSeen: Date.now(),
        isAudioActive: false,
        isVideoActive: false,
        inCall: false,
        isKeyVerified: false,
        qos: { mos: 4.5, grade: 'Excellente', cls: 'q-excellent' }
      });
      this.notifyUpdate();
    });

    this.mesh.on('peer-left', ({ peerId }) => {
      logger.info('Presence', `➖ Membre parti de la présence: ${peerId.substring(0, 10)}...`);
      this.roster.delete(peerId);
      this.notifyUpdate();
    });

    this.mesh.on('message-received', ({ peerId, message }) => {
      this.handleControlMessage(peerId, message);
    });

    // Écoute de la télémétrie WebRTC native pour le vrai RTT et le score eMOS
    if (this.mesh.telemetry) {
      this.mesh.telemetry.on('stats-updated', ({ peerId, metrics }) => {
        const peer = this.roster.get(peerId);
        if (peer && metrics) {
          if (metrics.rttMs !== null) peer.latencyMs = metrics.rttMs;
          if (metrics.qos) peer.qos = metrics.qos;
          peer.lastSeen = Date.now();
          this.notifyUpdate();
        }
      });
    }
  }

  start() {
    if (this.pingTimeout) clearTimeout(this.pingTimeout);
    logger.info('Presence', '💓 Démarrage de la boucle de Heartbeat avec Jitter anti-analyse...');
    this.scheduleNextHeartbeat();
  }

  stop() {
    logger.info('Presence', '🛑 Arrêt du gestionnaire de présence');
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
    this.roster.clear();
  }

  scheduleNextHeartbeat() {
    const baseInterval = CONFIG.TIMINGS?.HEARTBEAT_INTERVAL || 5000;
    const jitterLimit = CONFIG.PRIVACY?.HEARTBEAT_JITTER_MS || 1500;
    const jitter = Math.floor(Math.random() * (jitterLimit * 2)) - jitterLimit;
    const nextDelay = Math.max(2000, baseInterval + jitter);

    this.pingTimeout = setTimeout(() => {
      this.sendHeartbeat();
      this.checkTimeouts();
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

  checkTimeouts() {
    const now = Date.now();
    this.roster.forEach((peer, peerId) => {
      if (now - peer.lastSeen > CONFIG.TIMINGS.PEER_TIMEOUT) {
        logger.warn('Presence', `⏰ Timeout pair inactif: ${peerId.substring(0, 10)}...`);
        this.mesh.removePeer(peerId);
      }
    });
  }

  handleControlMessage(peerId, msg) {
    if (!msg || !msg.type) return;

    let peer = this.roster.get(peerId);
    if (!peer) {
      peer = {
        id: peerId,
        name: 'Membre P2P',
        pubkey: '',
        avatar: CryptoVault.generateVisualFingerprint(peerId),
        latencyMs: 0,
        lastSeen: Date.now(),
        isAudioActive: false,
        isVideoActive: false,
        inCall: false,
        isKeyVerified: false
      };
      this.roster.set(peerId, peer);
    }

    peer.lastSeen = Date.now();

    switch (msg.type) {
      case 'PING': {
        const replyDelay = 30 + Math.floor(Math.random() * 70); // 30-100ms anti-fingerprint delay
        setTimeout(() => {
          this.mesh.sendToPeer(peerId, {
            type: 'PONG',
            t: msg.t,
            replyAt: Date.now()
          });
        }, replyDelay);
        break;
      }

      case 'PONG':
        if (msg.t) {
          const rtt = Math.max(1, Date.now() - msg.t);
          peer.latencyMs = Math.round(rtt / 2);
          this.notifyUpdate();
        }
        break;

      case 'PEER_HELLO':
        logger.info('Presence', `👋 Présentation reçue de ${peerId.substring(0, 10)}...: Nom="${msg.name}"`);
        if (msg.name) peer.name = msg.name;
        
        // Détection de substitution non autorisée de clé publique (Anti-Spoofing / Anti-MITM)
        if (msg.pubkey) {
          if (peer.pubkey && peer.pubkey !== msg.pubkey) {
            logger.error('Presence', `🚨 ALERTE SÉCURITÉ: Changement inattendu de clé publique pour le pair ${peerId}! Possible tentative d'usurpation MITM.`);
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

      case 'MEDIA_SIGNAL':
        if (msg.status) {
          peer.inCall = !!msg.status.inCall;
          peer.isAudioActive = !!msg.status.audio;
          peer.isVideoActive = !!msg.status.video;
          this.notifyUpdate();
        }
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
