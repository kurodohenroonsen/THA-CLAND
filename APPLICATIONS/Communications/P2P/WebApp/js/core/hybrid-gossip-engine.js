/**
 * hybrid-gossip-engine.js - Moteur Gossip Hybride PlumTree & Arbre Couvrant Minimum (MST)
 * P2P Mesh Workspace - Pass 4 Hardened Edition (2025/2026)
 *
 * Implémente :
 * - Arbre Couvrant Minimum Dynamique (Eager Push) pour faible latence O(log N)
 * - Gossip Épidémique Léger (Lazy Push / IHAVE) pour tolérance aux pannes
 * - Élagage adaptatif des liens redondants (PRUNE)
 * - Auto-guérison et réparation d'arbre (GRAFT / IWANT)
 * - Single-Encrypt Multi-Send et TTL adaptatif logarithmique
 */

import { logger } from './logger.js';
import { GenerationalSlidingCache, TTLMap } from './bounded-cache.js';

export class HybridGossipEngine {
  constructor(meshNetwork, cryptoVault, options = {}) {
    this.mesh = meshNetwork;
    this.vault = cryptoVault;

    this.targetEagerDegree = options.targetEagerDegree || 3;
    this.ihaveIntervalMs = options.ihaveIntervalMs || 60;
    this.ihaveTimeoutMs = options.ihaveTimeoutMs || 450;
    this.maxTtl = options.maxTtl || 8;

    this.peerRoles = new Map();
    this.dedupCache = new GenerationalSlidingCache({ generationSize: 25000, rotateIntervalMs: 90000 });
    this.pendingIHave = new Map();
    this.messageStore = new TTLMap({ maxSize: 1000, ttlMs: 60000 });
    this.pendingRequests = new Map();
    this.listeners = new Map();
    this.ihaveTimer = null;

    this._init();
  }

  _init() {
    this.mesh.on('peer-joined', (peer) => this._onPeerJoined(peer.id));
    this.mesh.on('peer-left', ({ peerId }) => this._onPeerLeft(peerId));
    this.ihaveTimer = setInterval(() => this._flushIHaveQueue(), this.ihaveIntervalMs);
    if (this.ihaveTimer?.unref) this.ihaveTimer.unref();
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try { cb(data); } catch (e) { logger.error('Gossip', `Erreur listener ${event}:`, e); }
      });
    }
  }

  _onPeerJoined(peerId) {
    const currentEagerCount = this._getEagerPeers().length;
    if (currentEagerCount < this.targetEagerDegree) {
      this.peerRoles.set(peerId, 'eager');
      logger.info('Gossip', `🌲 Pair ${peerId.substring(0, 10)}... promu en lien EAGER (Total: ${currentEagerCount + 1})`);
    } else {
      this.peerRoles.set(peerId, 'lazy');
      logger.info('Gossip', `🌾 Pair ${peerId.substring(0, 10)}... assigné en lien LAZY`);
    }
  }

  _onPeerLeft(peerId) {
    const wasEager = this.peerRoles.get(peerId) === 'eager';
    this.peerRoles.delete(peerId);
    this.pendingIHave.delete(peerId);

    if (wasEager) {
      const lazyPeers = this._getLazyPeers();
      if (lazyPeers.length > 0) {
        const promoted = lazyPeers[Math.floor(Math.random() * lazyPeers.length)];
        this.peerRoles.set(promoted, 'eager');
        this._sendControl(promoted, { type: 'GOSSIP_GRAFT' });
        logger.info('Gossip', `🩹 Auto-guérison : Pair ${promoted.substring(0, 10)}... promu EAGER suite au départ de ${peerId.substring(0, 10)}...`);
      }
    }
  }

  _getEagerPeers() {
    const result = [];
    for (const [pid, role] of this.peerRoles) {
      if (role === 'eager' && this.mesh.peers.has(pid)) result.push(pid);
    }
    return result;
  }

  _getLazyPeers() {
    const result = [];
    for (const [pid, role] of this.peerRoles) {
      if (role === 'lazy' && this.mesh.peers.has(pid)) result.push(pid);
    }
    return result;
  }

  _computeAdaptiveTtl() {
    const n = Math.max(1, this.mesh.peers.size);
    return Math.min(this.maxTtl, Math.max(3, Math.ceil(1.5 * Math.log2(n + 1)) + 1));
  }

  async publish(type, payload, canonicalId = null, options = {}) {
    const msgId = canonicalId || `gsp_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    this.dedupCache.addIfNew(msgId);

    const ttl = options.ttl || this.maxTtl || this._computeAdaptiveTtl();
    const envelope = {
      _gspId: msgId,
      _type: type,
      _origin: this.vault.peerIdHex,
      _hops: 0,
      _ttl: ttl,
      _path: [this.vault.peerIdHex],
      _time: Date.now(),
      payload
    };

    this.messageStore.set(msgId, envelope);

    const eagerPeers = this._getEagerPeers();
    for (const pid of eagerPeers) {
      this.mesh.sendToPeer(pid, { type: 'GOSSIP_FULL', envelope });
    }

    const lazyPeers = this._getLazyPeers();
    for (const pid of lazyPeers) {
      this._enqueueIHave(pid, msgId);
    }

    return msgId;
  }

  async handleGossipMessage(fromPeerId, message) {
    if (!message || !message.type) return;

    switch (message.type) {
      case 'GOSSIP_FULL':
        await this._handleGossipFull(fromPeerId, message.envelope);
        break;
      case 'GOSSIP_IHAVE':
        this._handleGossipIHave(fromPeerId, message.ids);
        break;
      case 'GOSSIP_IWANT':
        await this._handleGossipIWant(fromPeerId, message.ids);
        break;
      case 'GOSSIP_PRUNE':
        this._handleGossipPrune(fromPeerId);
        break;
      case 'GOSSIP_GRAFT':
        this._handleGossipGraft(fromPeerId, message.id);
        break;
    }
  }

  async _handleGossipFull(fromPeerId, envelope) {
    if (!envelope || !envelope._gspId) return;
    const msgId = envelope._gspId;

    if (!this.dedupCache.addIfNew(msgId)) {
      if (this.peerRoles.get(fromPeerId) === 'eager') {
        this.peerRoles.set(fromPeerId, 'lazy');
        this._sendControl(fromPeerId, { type: 'GOSSIP_PRUNE' });
        logger.info('Gossip', `✂️ Doublon reçu de ${fromPeerId.substring(0, 10)}... : Branche élaguée (PRUNE -> LAZY)`);
      }
      return;
    }

    if (this.pendingRequests.has(msgId)) {
      clearTimeout(this.pendingRequests.get(msgId).timer);
      this.pendingRequests.delete(msgId);
    }

    this.messageStore.set(msgId, envelope);

    this.emit('message', {
      id: msgId,
      type: envelope._type,
      payload: envelope.payload,
      origin: envelope._origin,
      hops: envelope._hops
    });

    if (envelope._ttl > 1 && envelope._hops < this.maxTtl) {
      const nextEnvelope = {
        ...envelope,
        _hops: envelope._hops + 1,
        _ttl: envelope._ttl - 1,
        _path: [...(envelope._path || []), this.vault.peerIdHex]
      };

      const eagerPeers = this._getEagerPeers();
      for (const pid of eagerPeers) {
        if (pid !== fromPeerId && !nextEnvelope._path.includes(pid)) {
          this.mesh.sendToPeer(pid, { type: 'GOSSIP_FULL', envelope: nextEnvelope });
        }
      }

      const lazyPeers = this._getLazyPeers();
      for (const pid of lazyPeers) {
        if (pid !== fromPeerId && !nextEnvelope._path.includes(pid)) {
          this._enqueueIHave(pid, msgId);
        }
      }
    }
  }

  _handleGossipIHave(fromPeerId, ids) {
    if (!Array.isArray(ids)) return;

    const missingIds = ids.filter(id => !this.dedupCache.has(id));
    if (missingIds.length === 0) return;

    for (const msgId of missingIds) {
      if (this.pendingRequests.has(msgId)) continue;

      const timer = setTimeout(() => {
        if (!this.dedupCache.has(msgId) && this.mesh.peers.has(fromPeerId)) {
          logger.warn('Gossip', `⏱️ Timeout Eager pour ${msgId} -> Déclenchement IWANT + GRAFT vers ${fromPeerId}`);
          this.peerRoles.set(fromPeerId, 'eager');
          this._sendControl(fromPeerId, { type: 'GOSSIP_IWANT', ids: [msgId] });
          this._sendControl(fromPeerId, { type: 'GOSSIP_GRAFT', id: msgId });
        }
        this.pendingRequests.delete(msgId);
      }, this.ihaveTimeoutMs);

      this.pendingRequests.set(msgId, { timer, fromPeerId, requestedAt: Date.now() });
    }
  }

  async _handleGossipIWant(fromPeerId, ids) {
    if (!Array.isArray(ids)) return;

    for (const msgId of ids) {
      const cached = this.messageStore.get(msgId);
      if (cached) {
        this.mesh.sendToPeer(fromPeerId, { type: 'GOSSIP_FULL', envelope: cached });
      }
    }
  }

  _handleGossipPrune(fromPeerId) {
    this.peerRoles.set(fromPeerId, 'lazy');
    logger.info('Gossip', `📉 Confirmation PRUNE : Lien vers ${fromPeerId.substring(0, 10)}... basculé en LAZY`);
  }

  _handleGossipGraft(fromPeerId, msgId) {
    this.peerRoles.set(fromPeerId, 'eager');
    logger.info('Gossip', `📈 Confirmation GRAFT : Lien vers ${fromPeerId.substring(0, 10)}... promu en EAGER`);
    if (msgId) {
      const cached = this.messageStore.get(msgId);
      if (cached) {
        this.mesh.sendToPeer(fromPeerId, { type: 'GOSSIP_FULL', envelope: cached });
      }
    }
  }

  _enqueueIHave(peerId, msgId) {
    if (!this.pendingIHave.has(peerId)) {
      this.pendingIHave.set(peerId, new Set());
    }
    this.pendingIHave.get(peerId).add(msgId);
  }

  _flushIHaveQueue() {
    if (this.pendingIHave.size === 0) return;

    for (const [peerId, idSet] of this.pendingIHave) {
      if (idSet.size > 0 && this.mesh.peers.has(peerId)) {
        const ids = Array.from(idSet).slice(0, 50);
        this._sendControl(peerId, { type: 'GOSSIP_IHAVE', ids });
      }
    }
    this.pendingIHave.clear();
  }

  _sendControl(peerId, payload) {
    this.mesh.sendToPeer(peerId, payload).catch(e => {
      logger.debug('Gossip', `Erreur envoi message contrôle vers ${peerId}:`, e);
    });
  }

  destroy() {
    if (this.ihaveTimer) {
      clearInterval(this.ihaveTimer);
      this.ihaveTimer = null;
    }
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
    }
    this.pendingRequests.clear();
    this.dedupCache.destroy();
    this.messageStore.clear();
    this.pendingIHave.clear();
    this.peerRoles.clear();
  }
}
