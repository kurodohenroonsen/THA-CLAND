import { logger } from './logger.js';
import { CONFIG } from './config.js';

/**
 * Gouverneur de Topologie Maillée & Gestionnaire de Churn (2025/2026)
 * Implémentation conforme HyParView / CYCLON / Peer Sampling Service.
 * - Degré optimal k ∈ [CONFIG.TOPOLOGY.MIN_PEERS (3), CONFIG.TOPOLOGY.MAX_PEERS (6)]
 * - Vue bi-couche (Active View WebRTC + Passive View Standby)
 * - Éviction gracieuse avec redirection de candidats
 * - Score d'utilité eMOS/RTT avec immunité d'appel (Call Shield)
 * - Shuffle épidémique anti-partitionnement
 */
export class TopologyGovernor {
  constructor(meshNetwork, presenceManager) {
    this.mesh = meshNetwork;
    this.presence = presenceManager;

    this.minDegree = CONFIG.TOPOLOGY?.MIN_PEERS || 3;
    this.maxDegree = CONFIG.TOPOLOGY?.MAX_PEERS || 6;
    this.targetDegree = CONFIG.TOPOLOGY?.TARGET_PEERS || 4;
    this.maxPassiveSize = CONFIG.TOPOLOGY?.MAX_PASSIVE_PEERS || 32;

    this.passiveView = new Map();
    this.evictionCooldowns = new Map();
    this.shuffleInterval = null;
    this.autoTuneInterval = null;
  }

  start() {
    logger.info('Topology', `🌐 Démarrage du Gouverneur de Topologie (Cible k=${this.targetDegree}, Plage [${this.minDegree}-${this.maxDegree}])`);
    
    this.autoTuneInterval = setInterval(() => {
      this.autoTuneTopology();
    }, CONFIG.TOPOLOGY?.TUNE_INTERVAL_MS || 8000);
    if (this.autoTuneInterval?.unref) this.autoTuneInterval.unref();

    this.scheduleNextShuffle();
  }

  stop() {
    if (this.autoTuneInterval) {
      clearInterval(this.autoTuneInterval);
      this.autoTuneInterval = null;
    }
    if (this.shuffleInterval) {
      clearTimeout(this.shuffleInterval);
      this.shuffleInterval = null;
    }
    this.passiveView.clear();
    this.evictionCooldowns.clear();
    logger.info('Topology', '🛑 Arrêt du Gouverneur de Topologie');
  }

  recordPassivePeer(peerId, meta = {}) {
    if (!peerId || peerId === this.mesh.signalingPeerId || this.mesh.peers.has(peerId)) {
      return;
    }

    const existing = this.passiveView.get(peerId);
    if (existing) {
      existing.lastSeen = Date.now();
      if (meta.pubkey) existing.pubkey = meta.pubkey;
      return;
    }

    if (this.passiveView.size >= this.maxPassiveSize) {
      const oldestKey = this.passiveView.keys().next().value;
      this.passiveView.delete(oldestKey);
    }

    this.passiveView.set(peerId, {
      id: peerId,
      pubkey: meta.pubkey || '',
      source: meta.source || 'discovery',
      lastSeen: Date.now(),
      failCount: 0
    });
    logger.debug('Topology', `➕ Pair ajouté à la Passive View: ${peerId.substring(0, 10)}... (Total: ${this.passiveView.size})`);
  }

  removePassivePeer(peerId) {
    this.passiveView.delete(peerId);
  }

  getPassiveCandidates(count = 3, excludeIds = []) {
    const excludeSet = new Set(excludeIds);
    const candidates = [];
    for (const [id, info] of this.passiveView) {
      if (!excludeSet.has(id) && !this.mesh.peers.has(id)) {
        candidates.push(info);
        if (candidates.length >= count) break;
      }
    }
    return candidates;
  }

  computePeerUtility(peerId) {
    const peer = this.mesh.peers.get(peerId);
    if (!peer) return -Infinity;

    const rosterPeer = this.presence?.roster?.get(peerId);

    // 1. Immunité Absolue : Pair en appel vocal/vidéo actif
    if (rosterPeer && (rosterPeer.inCall || rosterPeer.isAudioActive || rosterPeer.isVideoActive)) {
      return 10000;
    }

    // 2. Score eMOS Télémétrie (40%)
    const mosScore = (rosterPeer?.qos?.mos || 4.0) / 4.5;

    // 3. Score RTT Latence (30%)
    const rtt = rosterPeer?.latencyMs || 50;
    const rttScore = Math.max(0, 1 - (rtt / 400));

    // 4. Stabilité / Ancienneté (20%)
    const uptimeSec = Math.min(3600, (Date.now() - (peer.connectedAt || Date.now())) / 1000);
    const uptimeScore = uptimeSec / 3600;

    // 5. Fraîcheur des battements (10%)
    const silenceSec = Math.max(0, (Date.now() - (peer.lastSeen || Date.now())) / 1000);
    const freshnessScore = Math.max(0, 1 - (silenceSec / 20));

    const totalUtility = (mosScore * 40) + (rttScore * 30) + (uptimeScore * 20) + (freshnessScore * 10);
    return parseFloat(totalUtility.toFixed(2));
  }

  evaluateIncomingOffer(senderPeerId) {
    const currentActive = this.mesh.peers.size;

    if (currentActive < this.maxDegree) {
      return { accept: true, evictPeerId: null, reason: 'capacity_available' };
    }

    logger.info('Topology', `⚖️ Active View saturée (${currentActive}/${this.maxDegree}). Évaluation d'une éviction...`);

    let lowestUtility = Infinity;
    let candidateToEvict = null;

    for (const [peerId] of this.mesh.peers) {
      const peerData = this.mesh.peers.get(peerId);
      if (Date.now() - (peerData.connectedAt || 0) < 10000) continue;

      const utility = this.computePeerUtility(peerId);
      if (utility < lowestUtility) {
        lowestUtility = utility;
        candidateToEvict = peerId;
      }
    }

    if (!candidateToEvict || lowestUtility >= 5000) {
      logger.warn('Topology', `🚫 Rejet de l'offre entrante de ${senderPeerId} : tous les pairs actifs sont protégés`);
      this.recordPassivePeer(senderPeerId, { source: 'rejected_offer' });
      return { accept: false, evictPeerId: null, reason: 'all_peers_protected' };
    }

    return {
      accept: true,
      evictPeerId: candidateToEvict,
      reason: `evict_lowest_utility_${lowestUtility}`
    };
  }

  async evictPeerGracefully(peerId, reason = 'topology_rebalance') {
    const peer = this.mesh.peers.get(peerId);
    if (!peer) return;

    logger.info('Topology', `👋 Éviction gracieuse du pair ${peerId.substring(0, 10)}... (Raison: ${reason})`);
    const redirectCandidates = this.getPassiveCandidates(3, [peerId]);

    try {
      if (peer.controlChannel && peer.controlChannel.readyState === 'open') {
        await this.mesh.sendToPeer(peerId, {
          type: 'TOPOLOGY_EVICT_REDIRECT',
          reason,
          suggestedPeers: redirectCandidates.map(c => ({ id: c.id, pubkey: c.pubkey }))
        });
      }
    } catch (e) {
      logger.debug('Topology', 'Avertissement envoi EVICT_REDIRECT:', e.message);
    }

    this.recordPassivePeer(peerId, { pubkey: peer.pubkey, source: 'evicted_active' });
    this.mesh.removePeer(peerId);
  }

  autoTuneTopology() {
    const currentActive = this.mesh.peers.size;

    if (currentActive < this.minDegree) {
      logger.warn('Topology', `⚠️ Sous-connectivité (${currentActive}/${this.minDegree} pairs). Sollicitation découverte...`);
      this.mesh.announceAllTrackers();
      return;
    }

    if (currentActive > this.maxDegree) {
      logger.info('Topology', `✂️ Sur-connectivité (${currentActive}/${this.maxDegree} pairs). Rééquilibrage...`);
      let lowestScore = Infinity;
      let worstPeerId = null;

      for (const [peerId] of this.mesh.peers) {
        const score = this.computePeerUtility(peerId);
        if (score < lowestScore) {
          lowestScore = score;
          worstPeerId = peerId;
        }
      }

      if (worstPeerId && lowestScore < 5000) {
        this.evictPeerGracefully(worstPeerId, 'degree_over_capacity');
      }
    }
  }

  scheduleNextShuffle() {
    const baseInterval = CONFIG.TOPOLOGY?.SHUFFLE_INTERVAL_MS || 25000;
    const jitter = Math.floor(Math.random() * 6000) - 3000;
    const delay = Math.max(10000, baseInterval + jitter);

    this.shuffleInterval = setTimeout(async () => {
      await this.performEpidemicShuffle();
      this.scheduleNextShuffle();
    }, delay);
  }

  async performEpidemicShuffle() {
    if (this.mesh.peers.size === 0) return;

    const activePeerIds = Array.from(this.mesh.peers.keys());
    const randomPeerId = activePeerIds[Math.floor(Math.random() * activePeerIds.length)];

    const passiveSample = this.getPassiveCandidates(3, [randomPeerId]).map(p => ({
      id: p.id,
      pubkey: p.pubkey
    }));

    passiveSample.push({
      id: this.mesh.signalingPeerId,
      pubkey: this.mesh.vault.publicKeyHex
    });

    try {
      await this.mesh.sendToPeer(randomPeerId, {
        type: 'TOPOLOGY_SHUFFLE_REQ',
        sample: passiveSample
      });
      logger.debug('Topology', `🔀 Shuffle envoyé à ${randomPeerId.substring(0, 10)}...`);
    } catch (err) {
      logger.debug('Topology', 'Échec envoi TOPOLOGY_SHUFFLE_REQ:', err.message);
    }
  }

  handleShuffleRequest(fromPeerId, remoteSample) {
    if (!Array.isArray(remoteSample)) return;

    remoteSample.forEach(peerInfo => {
      if (peerInfo && peerInfo.id && peerInfo.id !== this.mesh.signalingPeerId) {
        this.recordPassivePeer(peerInfo.id, { pubkey: peerInfo.pubkey, source: 'shuffle' });
      }
    });

    const mySample = this.getPassiveCandidates(3, [fromPeerId]).map(p => ({
      id: p.id,
      pubkey: p.pubkey
    }));

    this.mesh.sendToPeer(fromPeerId, {
      type: 'TOPOLOGY_SHUFFLE_RESP',
      sample: mySample
    }).catch(() => {});
  }

  handleShuffleResponse(fromPeerId, remoteSample) {
    if (!Array.isArray(remoteSample)) return;
    remoteSample.forEach(peerInfo => {
      if (peerInfo && peerInfo.id && peerInfo.id !== this.mesh.signalingPeerId) {
        this.recordPassivePeer(peerInfo.id, { pubkey: peerInfo.pubkey, source: 'shuffle_resp' });
      }
    });
  }
}
