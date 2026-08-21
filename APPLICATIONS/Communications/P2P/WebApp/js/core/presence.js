import { logger } from './logger.js';
/**
 * Gestionnaire de Présence, Télémétrie & Battements de Cœur (Heartbeat) P2P
 * Maintient le statut actif des membres, calcule la latence (RTT) et gère le roster.
 */

import { CONFIG } from './config.js';

export class PresenceManager {
  constructor(meshNetwork) {
    this.mesh = meshNetwork;
    this.roster = new Map(); // peerId -> { id, name, pubkey, avatar, latencyMs, lastSeen, isAudioActive, isVideoActive }
    this.pingInterval = null;
    this.listeners = [];

    this.initListeners();
  }

  onPresenceUpdate(callback) {
    this.listeners.push(callback);
  }

  notifyUpdate() {
    const peerList = Array.from(this.roster.values());
    logger.debug('Presence', `👥 Mise à jour du Roster des membres (${peerList.length} en ligne)`);
    this.listeners.forEach(cb => cb(peerList));
  }

  initListeners() {
    this.mesh.on('peer-joined', (peer) => {
      logger.info('Presence', `➕ Nouveau membre détecté dans la présence: ${peer.id.substring(0, 10)}... (${peer.name || 'Membre'})`);
      this.roster.set(peer.id, {
        id: peer.id,
        name: peer.name || 'Membre P2P',
        pubkey: '',
        avatar: this.generateAvatar(peer.id),
        latencyMs: 0,
        lastSeen: Date.now(),
        isAudioActive: false,
        isVideoActive: false,
        inCall: false
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
  }

  start() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    logger.info('Presence', '💓 Démarrage de la boucle de Heartbeat (5s)...');

    this.pingInterval = setInterval(() => {
      this.sendHeartbeat();
      this.checkTimeouts();
    }, CONFIG.TIMINGS.HEARTBEAT_INTERVAL);
  }

  stop() {
    logger.info('Presence', '🛑 Arrêt du gestionnaire de présence');
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.roster.clear();
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
        logger.warn('Presence', `⏰ Timeout pair inactif: ${peerId.substring(0, 10)}... (Dernier contact il y a ${Math.round((now - peer.lastSeen) / 1000)}s)`);
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
        avatar: this.generateAvatar(peerId),
        latencyMs: 0,
        lastSeen: Date.now(),
        isAudioActive: false,
        isVideoActive: false,
        inCall: false
      };
      this.roster.set(peerId, peer);
    }

    peer.lastSeen = Date.now();

    switch (msg.type) {
      case 'PING':
        this.mesh.sendToPeer(peerId, {
          type: 'PONG',
          t: msg.t,
          replyAt: Date.now()
        });
        break;

      case 'PONG':
        if (msg.t) {
          const rtt = Math.max(1, Date.now() - msg.t);
          peer.latencyMs = Math.round(rtt / 2);
          logger.debug('Presence', `⚡ Latence mesurée avec ${peerId.substring(0, 10)}...: ${peer.latencyMs} ms (RTT: ${rtt} ms)`);
          this.notifyUpdate();
        }
        break;

      case 'PEER_HELLO':
        logger.info('Presence', `👋 Présentation reçue de ${peerId.substring(0, 10)}...: Nom="${msg.name}"`);
        if (msg.name) peer.name = msg.name;
        if (msg.pubkey) peer.pubkey = msg.pubkey;
        this.notifyUpdate();
        break;

      case 'MEDIA_SIGNAL':
        logger.debug('Presence', `🎙️ Statut média de ${peerId.substring(0, 10)}...: EnAppel=${msg.inCall}, Audio=${msg.isAudioActive}, Vidéo=${msg.isVideoActive}`);
        if (msg.inCall !== undefined) peer.inCall = msg.inCall;
        if (msg.isAudioActive !== undefined) peer.isAudioActive = msg.isAudioActive;
        if (msg.isVideoActive !== undefined) peer.isVideoActive = msg.isVideoActive;
        this.notifyUpdate();
        break;
    }
  }

  broadcastMediaStatus(inCall, isAudioActive, isVideoActive) {
    logger.debug('Presence', `📢 Diffusion de notre statut média: EnAppel=${inCall}, Audio=${isAudioActive}, Vidéo=${isVideoActive}`);
    this.mesh.broadcast({
      type: 'MEDIA_SIGNAL',
      inCall,
      isAudioActive,
      isVideoActive
    });
  }

  generateAvatar(seedStr) {
    let hash = 0;
    for (let i = 0; i < seedStr.length; i++) {
      hash = seedStr.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h1 = Math.abs(hash % 360);
    const h2 = (h1 + 60) % 360;
    
    return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="hsl(${h1}, 80%, 55%)"/><stop offset="100%" stop-color="hsl(${h2}, 85%, 45%)"/></linearGradient></defs><rect width="64" height="64" rx="32" fill="url(%23g)"/><circle cx="32" cy="24" r="12" fill="rgba(255,255,255,0.85)"/><path d="M12 56 C12 42, 22 38, 32 38 C42 38, 52 42, 52 56 Z" fill="rgba(255,255,255,0.85)"/></svg>`;
  }
}
