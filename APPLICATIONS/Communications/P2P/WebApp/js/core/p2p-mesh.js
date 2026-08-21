import { logger } from './logger.js';
import { CONFIG } from './config.js';
import { BoundedSet, TTLMap, GenerationalSlidingCache, GossipEnvelope } from './bounded-cache.js';
import { CryptoVault } from './crypto-vault.js';
import { WebRTCTelemetryEngine } from './webrtc-telemetry.js';
import { IceCandidateManager } from './ice-manager.js';
import { DataChannelFlowController } from './datachannel-flow-controller.js';
import { TopologyGovernor } from './topology-governor.js';
import { BinaryFrameRouter, FRAME_TYPES, FRAME_FLAGS } from './binary-frame-router.js';
import { SDPSecureSignaling } from './secure-signaling-e2ee.js';
import { SDPOptimizer } from '../modules/media/sdp-optimizer.js';
import { MediaQualityManager } from '../modules/media/media-quality-manager.js';

/**
 * Moteur Réseau P2P Mesh & Coordinateur de Swarm Décentralisé (Pass 4 Hardened 2026)
 * - W3C Perfect Negotiation (Rôle déterministe 0-RTT, Rollback W3C, Anti-Glare FSM)
 * - Ingress Rate Limiting & Anti-Fragment Bomb
 * - Trickle ICE & Candidate Queuing (IceCandidateManager)
 * - Contrôle de Flux BDP & Contre-Pression Événementielle (DataChannelFlowController)
 * - Gouvernance de Topologie & Churn Management (TopologyGovernor)
 * - Framing Binaire Zero-Copy (BinaryFrameRouter)
 * - Signalisation E2EE & SDP Identity Binding (SDPSecureSignaling)
 * - Reconnexion Full Jitter & Résilience Multi-Voies
 */

class InboundRateLimiter {
  constructor({ maxTokens = 60, refillRatePerSec = 30, maxBytesPerSec = 512 * 1024 } = {}) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRatePerSec;
    this.maxBytesPerSec = maxBytesPerSec;
    this.tokens = maxTokens;
    this.byteBucket = maxBytesPerSec;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsedSec * this.refillRate);
    this.byteBucket = Math.min(this.maxBytesPerSec, this.byteBucket + elapsedSec * this.maxBytesPerSec);
    this.lastRefill = now;
  }

  allowMessage(byteSize = 100) {
    this._refill();
    if (this.tokens < 1 || this.byteBucket < byteSize) {
      return false;
    }
    this.tokens -= 1;
    this.byteBucket -= byteSize;
    return true;
  }
}

export class PeerNegotiationState {
  constructor(peerId, localPeerIdHex, remotePubkeyHex = '') {
    this.peerId = peerId;
    this.localPeerIdHex = localPeerIdHex;
    this.remotePubkeyHex = remotePubkeyHex;

    const comparisonKey = remotePubkeyHex || peerId.replace(/^peer_/, '');
    this.isPolite = localPeerIdHex.localeCompare(comparisonKey) < 0;

    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;
    this.queuedNegotiation = false;

    this.metrics = {
      glareCollisions: 0,
      rollbacksExecuted: 0,
      offersCreated: 0,
      answersCreated: 0,
      lastNegotiationDurationMs: 0
    };
  }
}

export class P2PMeshNetwork {
  constructor(cryptoVault) {
    this.vault = cryptoVault;
    this.signalingPeerId = CryptoVault.bufferToHex(crypto.getRandomValues(new Uint8Array(20)));
    this.peers = new Map();
    this.trackers = new Map();
    this._trackerBackoff = new Map();
    this._trackerAttempts = new Map();
    this.nostrRelays = new Map();
    this.eventListeners = new Map();

    // Moteurs spécialisés Pass 4
    this.telemetry = new WebRTCTelemetryEngine(this);
    this.flowController = new DataChannelFlowController();
    this.binaryRouter = new BinaryFrameRouter({ vault: this.vault });
    this.topology = new TopologyGovernor(this, null);
    this.qualityManager = new MediaQualityManager(this);

    this.peerGraceTimers = new Map();
    this.iceRestartInProgress = new Set();
    this.iceManagers = new Map();

    this.activeOffers = new TTLMap({
      maxSize: 256,
      ttlMs: CONFIG.TIMINGS?.OFFER_TTL || 45000,
      onEvict: (offerId, entry) => {
        try { entry?.pc?.close(); } catch (e) { logger.debug('P2P Mesh', 'Erreur fermeture RTCPeerConnection expirée:', e); }
      }
    });

    this.processedOfferIds = new BoundedSet(4000);
    this.processedGossipIds = new GenerationalSlidingCache({ generationSize: 20000, rotateIntervalMs: 90000 });

    this.announceInterval = null;
    this.maintenanceInterval = null;
    this.localMediaStream = null;
  }

  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
  }

  emit(event, data) {
    if (this.eventListeners.has(event)) {
      this.eventListeners.get(event).forEach(cb => {
        try { cb(data); } catch (e) { logger.error('P2P Mesh', `Erreur écouteur ${event}:`, e); }
      });
    }
  }

  isMediaActive() {
    return !!(this.localMediaStream && this.localMediaStream.active);
  }

  async start() {
    if (!this.vault.isInitialized) {
      throw new Error('Le coffre cryptographique doit être initialisé');
    }

    logger.info('P2P Mesh', `🚀 Démarrage du réseau Mesh pour Topic: ${this.vault.topicHex.substring(0, 10)}... (Pair: ${this.vault.peerIdHex.substring(0, 12)}...)`);
    this.emit('status-change', { status: 'connecting', message: 'Connexion aux relais de découverte...' });

    this.telemetry.start(2000);
    this.topology.start();
    this.qualityManager.start(2000);

    for (const trackerUrl of CONFIG.TRACKERS) {
      logger.info('P2P Mesh', `🌐 Connexion tracker: ${trackerUrl}`);
      this.connectToTracker(trackerUrl);
    }

    for (const nostrUrl of (CONFIG.NOSTR_RELAYS || [])) {
      logger.info('P2P Mesh', `⚡ Connexion relais Nostr: ${nostrUrl}`);
      this.connectToNostrRelay(nostrUrl);
    }

    const announcePeriod = CONFIG.TIMINGS?.DEFAULT_ANNOUNCE_INTERVAL || 25000;
    this.announceInterval = setInterval(() => {
      this.announceAllTrackers();
    }, announcePeriod);
    if (this.announceInterval?.unref) this.announceInterval.unref();

    this.maintenanceInterval = setInterval(() => {
      this.activeOffers.sweep();
    }, 10000);
    if (this.maintenanceInterval?.unref) this.maintenanceInterval.unref();

    return this;
  }

  async stop() {
    logger.info('P2P Mesh', '🛑 Arrêt gracieux du maillage P2P...');
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }

    this.telemetry.stop();
    this.topology.stop();
    this.qualityManager.stop();

    const departurePromises = [];
    this.trackers.forEach((ws, url) => {
      if (ws.readyState === WebSocket.OPEN) {
        departurePromises.push(this.announceToTracker(ws, url, 'stopped'));
      }
    });

    try {
      await Promise.race([
        Promise.all(departurePromises),
        new Promise(r => setTimeout(r, 600))
      ]);
    } catch (e) {}

    this.trackers.forEach((ws) => { try { ws.close(); } catch (e) {} });
    this.trackers.clear();

    this.nostrRelays.forEach((ws) => { try { ws.close(); } catch (e) {} });
    this.nostrRelays.clear();

    this.peers.forEach((peer) => {
      this._teardownPeerConnection(peer);
    });
    this.peers.clear();
    this.peerGraceTimers.clear();
    this.iceRestartInProgress.clear();
    this.iceManagers.clear();

    this.emit('status-change', { status: 'disconnected', message: 'Déconnecté du réseau P2P' });
  }

  // --- Rassemblement ICE WebRTC Adaptatif & Court-Circuit LAN ---

  async waitForIceGathering(pc, maxTimeoutMs = 1800, fastLanTimeoutMs = 120) {
    if (pc.iceGatheringState === 'complete') {
      return pc.localDescription;
    }

    return new Promise((resolve) => {
      let timer = null;
      let fastTimer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (fastTimer) clearTimeout(fastTimer);
        pc.removeEventListener('icegatheringstatechange', checkState);
        pc.removeEventListener('icecandidate', onCandidate);
      };

      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          cleanup();
          resolve(pc.localDescription);
        }
      };

      const onCandidate = (event) => {
        if (!event.candidate) return;

        const cType = event.candidate.type;
        if (cType === 'host') {
          if (!fastTimer && !CONFIG.PRIVACY?.FORCE_RELAY_ONLY) {
            fastTimer = setTimeout(() => {
              logger.debug('P2P Mesh', '⚡ Fast-Path LAN déclenché');
              cleanup();
              resolve(pc.localDescription);
            }, fastLanTimeoutMs);
          }
        } else if (cType === 'srflx' || cType === 'relay') {
          if (!fastTimer) {
            fastTimer = setTimeout(() => {
              cleanup();
              resolve(pc.localDescription);
            }, 250);
          }
        }
      };

      pc.addEventListener('icegatheringstatechange', checkState);
      pc.addEventListener('icecandidate', onCandidate);

      timer = setTimeout(() => {
        cleanup();
        resolve(pc.localDescription);
      }, maxTimeoutMs);
    });
  }

  // --- Signalement via Trackers WebTorrent WSS ---

  connectToTracker(trackerUrl) {
    try {
      const ws = new WebSocket(trackerUrl);
      this.trackers.set(trackerUrl, ws);

      const connectTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          logger.warn('P2P Mesh', `⏱️ Timeout handshake tracker (${trackerUrl})`);
          try { ws.close(); } catch (e) {}
        }
      }, CONFIG.TIMINGS?.TRACKER_CONNECT_TIMEOUT || 5000);

      ws.onopen = () => {
        clearTimeout(connectTimer);
        logger.info('P2P Mesh', `✅ Connecté au tracker: ${trackerUrl}`);
        this._trackerBackoff.set(trackerUrl, CONFIG.TIMINGS?.RECONNECT_DELAY || 1500);
        this._trackerAttempts.delete(trackerUrl);
        this.announceToTracker(ws, trackerUrl, 'started');
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          await this.handleTrackerMessage(data, ws);
        } catch (err) {
          logger.warn('P2P Mesh', 'Erreur lecture message tracker:', err);
        }
      };

      ws.onerror = (err) => {
        logger.warn('P2P Mesh', `Erreur tracker ${trackerUrl}:`, err);
      };

      ws.onclose = () => {
        clearTimeout(connectTimer);
        this.trackers.delete(trackerUrl);
        if (this.announceInterval) {
          this._scheduleTrackerReconnect(trackerUrl);
        }
      };
    } catch (e) {
      logger.warn('P2P Mesh', `Exception connexion tracker ${trackerUrl}:`, e);
    }
  }

  _scheduleTrackerReconnect(trackerUrl) {
    if (!this.announceInterval || !navigator.onLine) return;

    const baseDelay = CONFIG.NOSTR?.BACKOFF?.INITIAL_DELAY_MS || 1000;
    const maxDelay = CONFIG.NOSTR?.BACKOFF?.MAX_DELAY_MS || 30000;
    
    const attempts = (this._trackerAttempts?.get(trackerUrl) || 0) + 1;
    this._trackerAttempts.set(trackerUrl, attempts);

    const exponentialCap = Math.min(maxDelay, baseDelay * Math.pow(2, Math.min(attempts, 6)));
    const jitteredDelay = Math.floor(Math.random() * exponentialCap);

    logger.info('P2P Mesh', `🔄 Reconnexion Tracker [Tentative ${attempts}, ${jitteredDelay}ms] : ${trackerUrl}`);

    setTimeout(() => {
      if (this.announceInterval && navigator.onLine) {
        this.connectToTracker(trackerUrl);
      }
    }, jitteredDelay);
  }

  async announceAllTrackers() {
    this.trackers.forEach((ws, url) => {
      if (ws.readyState === WebSocket.OPEN) {
        this.announceToTracker(ws, url, 'update');
      }
    });
  }

  async announceToTracker(ws, trackerUrl, eventType = 'update') {
    if (ws.readyState !== WebSocket.OPEN) return;

    const maxPeers = CONFIG.LIMITS?.MAX_ACTIVE_PEERS || 8;
    const shouldMakeOffers = (eventType !== 'stopped') &&
                             (this.peers.size < maxPeers) &&
                             (this.activeOffers.size < 4);
    const numOffers = shouldMakeOffers ? 2 : 0;

    let offers = [];
    if (numOffers > 0) {
      const offerTasks = Array.from({ length: numOffers }, async () => {
        const offerId = `off_${Math.random().toString(36).substr(2, 9)}`;
        const pc = this.createPeerConnection(null, { poolSize: 0 });

        const controlChannel = pc.createDataChannel('p2p-control', {
          ordered: true,
          priority: 'high'
        });
        const dataChannel = pc.createDataChannel('p2p-data', {
          ordered: true,
          priority: 'low'
        });

        const rawOffer = await pc.createOffer();
        await pc.setLocalDescription(rawOffer);

        const completeOffer = await this.waitForIceGathering(pc, 1800, 120);
        const sanitizedOffer = this._sanitizeAndPadSDP(completeOffer.sdp);

        // Binding cryptographique signé anti-MitM
        const binding = await SDPSecureSignaling.createSignedBinding(
          this.vault,
          sanitizedOffer.sdp,
          completeOffer.type
        );

        const encryptedOffer = await this.vault.encrypt({
          type: completeOffer.type,
          sdp: sanitizedOffer.sdp,
          binding,
          _pad: sanitizedOffer._pad
        }, true);

        this.activeOffers.set(offerId, {
          pc,
          controlChannel,
          dataChannel,
          createdAt: Date.now()
        });

        return {
          offer_id: offerId,
          offer: {
            type: 'offer',
            sdp: JSON.stringify(encryptedOffer)
          }
        };
      });

      offers = await Promise.all(offerTasks);
    }

    const announceMsg = {
      action: 'announce',
      info_hash: this.vault.topicHex.substring(0, 40),
      peer_id: this.signalingPeerId,
      numwant: eventType === 'stopped' ? 0 : 10,
      uploaded: 0,
      downloaded: 0,
      left: 0
    };

    if (eventType && eventType !== 'update') announceMsg.event = eventType;
    if (offers.length > 0) announceMsg.offers = offers;

    try {
      ws.send(JSON.stringify(announceMsg));
      logger.info('P2P Mesh', `📤 Annonce envoyée [Event: ${eventType}, Offers: ${offers.length}] vers ${trackerUrl}`);
    } catch (err) {
      logger.warn('P2P Mesh', `Échec envoi announce vers ${trackerUrl}:`, err);
    }
  }

  _sanitizeAndPadSDP(sdp) {
    let cleaned = sdp || '';
    if (CONFIG.PRIVACY?.STRIP_HOST_CANDIDATES) {
      cleaned = cleaned
        .split('\r\n')
        .filter((line) => {
          if (!line.startsWith('a=candidate:')) return true;
          if (line.includes('typ host') && line.includes('.local')) return true;
          return !line.includes('typ host');
        })
        .join('\r\n');
    }
    cleaned = SDPOptimizer.optimizeSDP(cleaned);
    const blockSize = CONFIG.PRIVACY?.SDP_PADDING_BLOCK_SIZE || 2048;
    const padLength = (blockSize - (cleaned.length % blockSize)) % blockSize;
    return {
      sdp: cleaned,
      _pad: '0'.repeat(padLength)
    };
  }

  async handleTrackerMessage(data, ws) {
    if (!data) return;

    if (data['failure reason']) {
      logger.warn('P2P Mesh', `⚠️ Erreur tracker: ${data['failure reason']}`);
      return;
    }

    if (data.action === 'announce') {
      const senderPeerIdHex = data.peer_id ? String(data.peer_id) : '';

      if (senderPeerIdHex === this.signalingPeerId || senderPeerIdHex === this.vault.peerIdHex) {
        return;
      }

      if (data.to_peer_id && String(data.to_peer_id) !== this.signalingPeerId) {
        return;
      }

      const remotePeerId = `peer_${senderPeerIdHex.substring(0, 16)}`;
      if (this.peers.has(remotePeerId)) {
        return;
      }

      // Contrôle d'admission via TopologyGovernor
      if (data.offer && data.offer_id) {
        if (!this.processedOfferIds.addIfNew(data.offer_id)) return;

        const decision = this.topology ? this.topology.evaluateIncomingOffer(remotePeerId) : { accept: true };
        if (!decision.accept) {
          logger.warn('P2P Mesh', `✋ Offre rejetée de ${remotePeerId} (Raison: ${decision.reason})`);
          return;
        }

        if (decision.evictPeerId) {
          await this.topology.evictPeerGracefully(decision.evictPeerId, 'slot_preempted');
        }

        logger.info('P2P Mesh', `🤝 Offre WebRTC entrante de ${remotePeerId} [OfferID: ${data.offer_id}] !`);

        try {
          let cipherPayload = data.offer;
          if (data.offer && typeof data.offer === 'object' && data.offer.sdp) {
            try { cipherPayload = JSON.parse(data.offer.sdp); } catch (e) { cipherPayload = data.offer.sdp; }
          }

          const decryptedOffer = await this.vault.decrypt(cipherPayload, true);
          if (!decryptedOffer || !decryptedOffer.sdp) {
            throw new Error('SDP manquant dans l\'offre déchiffrée');
          }

          // Validation du Binding E2EE
          if (decryptedOffer.binding) {
            const verifyResult = await SDPSecureSignaling.verifySignedBinding(
              decryptedOffer.binding,
              decryptedOffer.sdp
            );
            if (!verifyResult.valid) {
              logger.error('P2P Mesh', `❌ Rejet Offre SDP : Échec Binding Anti-MitM (${verifyResult.reason})`);
              return;
            }
          }

          const pc = this.createPeerConnection(remotePeerId);
          await pc.setRemoteDescription(new RTCSessionDescription({
            type: decryptedOffer.type || 'offer',
            sdp: decryptedOffer.sdp
          }));

          const iceMgr = this.iceManagers.get(remotePeerId);
          if (iceMgr) await iceMgr.onRemoteDescriptionSet();

          const rawAnswer = await pc.createAnswer();
          await pc.setLocalDescription(rawAnswer);

          const completeAnswer = await this.waitForIceGathering(pc, 1800, 120);
          const sanitizedAnswer = this._sanitizeAndPadSDP(completeAnswer.sdp);

          const bindingAnswer = await SDPSecureSignaling.createSignedBinding(
            this.vault,
            sanitizedAnswer.sdp,
            completeAnswer.type,
            remotePeerId
          );

          const encryptedAnswer = await this.vault.encrypt({
            type: completeAnswer.type,
            sdp: sanitizedAnswer.sdp,
            binding: bindingAnswer,
            _pad: sanitizedAnswer._pad
          }, true);

          const answerMsg = {
            action: 'announce',
            info_hash: this.vault.topicHex.substring(0, 40),
            peer_id: this.signalingPeerId,
            to_peer_id: data.peer_id,
            answer: {
              type: 'answer',
              sdp: JSON.stringify(encryptedAnswer)
            },
            offer_id: data.offer_id
          };

          ws.send(JSON.stringify(answerMsg));
        } catch (err) {
          logger.warn('P2P Mesh', 'Rejet offre reçue:', err.message);
        }
      }

      if (data.answer && data.offer_id) {
        const pending = this.activeOffers.get(data.offer_id);
        if (pending && pending.pc) {
          try {
            let cipherAnswerPayload = data.answer;
            if (data.answer && typeof data.answer === 'object' && data.answer.sdp) {
              try { cipherAnswerPayload = JSON.parse(data.answer.sdp); } catch (e) { cipherAnswerPayload = data.answer.sdp; }
            }

            const decryptedAnswer = await this.vault.decrypt(cipherAnswerPayload, true);
            pending.pc._remotePeerId = remotePeerId;

            if (decryptedAnswer.binding) {
              const verifyResult = await SDPSecureSignaling.verifySignedBinding(
                decryptedAnswer.binding,
                decryptedAnswer.sdp
              );
              if (!verifyResult.valid) {
                logger.error('P2P Mesh', `❌ Rejet Réponse SDP : Échec Binding Anti-MitM (${verifyResult.reason})`);
                return;
              }
            }

            await pending.pc.setRemoteDescription(new RTCSessionDescription({
              type: decryptedAnswer.type || 'answer',
              sdp: decryptedAnswer.sdp
            }));

            const iceMgr = this.iceManagers.get(remotePeerId);
            if (iceMgr) await iceMgr.onRemoteDescriptionSet();

            this.setupConnectedPeer(remotePeerId, pending.pc, pending.controlChannel, pending.dataChannel);
            this.activeOffers.delete(data.offer_id);
          } catch (err) {
            logger.warn('P2P Mesh', '❌ Échec traitement réponse SDP:', err.message);
          }
        }
      }
    }
  }

  // --- Signalement via Relais Nostr ---

  connectToNostrRelay(relayUrl) {
    try {
      const ws = new WebSocket(relayUrl);
      this.nostrRelays.set(relayUrl, ws);

      ws.onopen = () => {
        logger.info('P2P Mesh', `⚡ Connecté relais Nostr: ${relayUrl}`);
        const subId = `sub_${Math.random().toString(36).substr(2, 6)}`;
        const req = ['REQ', subId, {
          kinds: [CONFIG.NOSTR?.KIND_SIGNALING || 29000, CONFIG.NOSTR?.KIND_SIGNALING_ASYNC || 29001],
          '#t': [this.vault.topicHex]
        }];
        ws.send(JSON.stringify(req));
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg[0] !== 'EVENT' || !msg[2]) return;
          const nostrEvent = msg[2];

          if (!nostrEvent || typeof nostrEvent.content !== 'string' ||
              !nostrEvent.id || !nostrEvent.pubkey) return;

          if (!this.processedOfferIds.addIfNew(`nostr_${nostrEvent.id}`)) return;

          let payload;
          try { payload = JSON.parse(nostrEvent.content); } catch (e) { return; }
          if (!payload || payload.action !== 'announce') return;
          if (payload.peer_id && payload.peer_id === this.signalingPeerId) return;

          await this.handleTrackerMessage(payload, ws);
        } catch (e) {
          logger.warn('P2P Mesh', 'Erreur traitement Nostr:', e);
        }
      };

      ws.onerror = (err) => { logger.warn('P2P Mesh', `Erreur WebSocket Nostr (${relayUrl}):`, err); };
      ws.onclose = () => { this.nostrRelays.delete(relayUrl); };
    } catch (e) {
      logger.warn('P2P Mesh', `Exception Nostr (${relayUrl}):`, e);
    }
  }

  // --- Gestion des Connexions WebRTC & Lifecycle ---

  createPeerConnection(remotePeerId, options = {}) {
    const forceRelay = CONFIG.PRIVACY?.FORCE_RELAY_ONLY === true;
    const poolSize = options.poolSize !== undefined 
      ? options.poolSize 
      : (forceRelay ? 0 : (CONFIG.ICE_CONFIG?.CANDIDATE_POOL_SIZE || 2));

    const pc = new RTCPeerConnection({
      iceServers: CONFIG.ICE_SERVERS,
      iceTransportPolicy: forceRelay ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: poolSize
    });

    pc._remotePeerId = remotePeerId || null;

    const iceMgr = new IceCandidateManager(pc, remotePeerId || 'pending');
    if (remotePeerId) {
      this.iceManagers.set(remotePeerId, iceMgr);
    }
    pc._iceManager = iceMgr;

    let controlChannel = null;
    let dataChannel = null;

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      const pid = pc._remotePeerId;
      logger.info('P2P Mesh', `📦 Canal reçu [${pid || 'nouveau'}]: "${channel.label}"`);
      if (channel.label === 'p2p-control') {
        controlChannel = channel;
        this.setupControlChannel(channel, pid);
      } else if (channel.label === 'p2p-data') {
        dataChannel = channel;
        this.setupDataChannel(channel, pid);
      }

      if (controlChannel && dataChannel && pc._remotePeerId) {
        this.setupConnectedPeer(pc._remotePeerId, pc, controlChannel, dataChannel);
      }
    };

    pc.ontrack = (event) => {
      const pid = pc._remotePeerId;
      logger.info('P2P Mesh', `🎥 Piste reçue [Kind: ${event.track.kind}] de ${pid}`);
      this.applyReceiverJitterTarget(pc, CONFIG.MEDIA?.DEFAULT_JITTER_TARGET_MS || 50);
      this.emit('track-received', {
        peerId: pid,
        track: event.track,
        streams: event.streams
      });
    };

    pc.oniceconnectionstatechange = () => {
      const pid = pc._remotePeerId;
      const state = pc.iceConnectionState;
      logger.info('P2P Mesh', `🌐 État ICE [${pid || 'nouveau'}] : ${state}`);

      if (state === 'connected' || state === 'completed') {
        this._clearGraceTimer(pid);
      } else if (state === 'disconnected') {
        this._handlePeerDisconnected(pid, pc);
      } else if (state === 'failed') {
        this._handlePeerFailed(pid, pc);
      } else if (state === 'closed') {
        this._clearGraceTimer(pid);
        if (pid) this.removePeer(pid);
      }
    };

    pc.onconnectionstatechange = () => {
      const pid = pc._remotePeerId;
      const state = pc.connectionState;
      if (state === 'connected') {
        this._clearGraceTimer(pid);
      } else if (state === 'failed') {
        this._handlePeerFailed(pid, pc);
      }
    };

    return pc;
  }

  _handlePeerDisconnected(peerId, pc) {
    if (!peerId) return;
    const graceMs = CONFIG.TIMINGS?.ICE_DISCONNECT_GRACE_MS || 2000;
    logger.warn('P2P Mesh', `⚠️ Liaison instable avec ${peerId}. Grâce (${graceMs} ms)...`);

    this._clearGraceTimer(peerId);
    const timer = setTimeout(async () => {
      if (pc.iceConnectionState === 'disconnected') {
        logger.warn('P2P Mesh', `⏰ Expiration grâce pour ${peerId} -> ICE Restart...`);
        await this.triggerResilientRecovery(peerId);
      }
    }, graceMs);

    this.peerGraceTimers.set(peerId, timer);
  }

  _handlePeerFailed(peerId, pc) {
    this._clearGraceTimer(peerId);
    if (!peerId) return;
    logger.warn('P2P Mesh', `❌ Échec ICE avec ${peerId}, récupération résiliente...`);
    this.triggerResilientRecovery(peerId).catch(() => this.removePeer(peerId));
  }

  _clearGraceTimer(peerId) {
    if (peerId && this.peerGraceTimers.has(peerId)) {
      clearTimeout(this.peerGraceTimers.get(peerId));
      this.peerGraceTimers.delete(peerId);
    }
  }

  async triggerResilientRecovery(peerId) {
    if (!peerId || this.iceRestartInProgress.has(peerId)) return;
    this.iceRestartInProgress.add(peerId);

    const peer = this.peers.get(peerId);
    logger.warn('P2P Mesh', `⚡ Récupération résiliente pour ${peerId}...`);

    try {
      if (peer && peer.connection && peer.connection.signalingState !== 'closed') {
        if (typeof peer.connection.restartIce === 'function') {
          peer.connection.restartIce();
        }
        if (peer.controlChannel && peer.controlChannel.readyState === 'open') {
          await this.renegotiatePeer(peerId);
          this.iceRestartInProgress.delete(peerId);
          return;
        }
      }

      await this.announceAllTrackers();
    } catch (err) {
      logger.error('P2P Mesh', `Échec récupération résiliente pour ${peerId}:`, err);
    } finally {
      setTimeout(() => {
        this.iceRestartInProgress.delete(peerId);
      }, 3000);
    }
  }

  setupControlChannel(channel, peerId) {
    const incomingFragments = new Map();
    const rateLimiter = new InboundRateLimiter({ maxTokens: 60, refillRatePerSec: 30 });

    channel.onopen = () => this._handleControlChannelOpen(peerId);

    channel.onmessage = async (event) => {
      try {
        if (!rateLimiter.allowMessage(event.data?.length || 100)) {
          logger.warn('P2P Mesh', `⚠️ Ingress Rate Limit dépassé pour ${peerId}`);
          return;
        }

        let fullPayloadStr = event.data;
        const parsed = JSON.parse(event.data);

        if (parsed && parsed._isFrag) {
          const { _fragId, _part, _total, _data } = parsed;
          const MAX_PARTS = CONFIG.LIMITS.MAX_FRAGMENT_PARTS;
          const MAX_ASSEMBLED = CONFIG.LIMITS.MAX_ASSEMBLED_CONTROL_BYTES;
          if (typeof _fragId !== 'string' ||
              !Number.isInteger(_total) || _total < 1 || _total > MAX_PARTS ||
              !Number.isInteger(_part) || _part < 0 || _part >= _total ||
              typeof _data !== 'string') {
            return;
          }

          let item = incomingFragments.get(_fragId);
          if (!item) {
            const now = Date.now();
            for (const [fid, it] of incomingFragments) {
              if (now - it.createdAt > 30000) incomingFragments.delete(fid);
            }
            item = { parts: new Map(), total: _total, bytes: 0, createdAt: now };
            incomingFragments.set(_fragId, item);
          }
          if (item.total !== _total) return;
          if (!item.parts.has(_part)) {
            item.parts.set(_part, _data);
            item.bytes += _data.length;
            if (item.bytes > MAX_ASSEMBLED) {
              incomingFragments.delete(_fragId);
              return;
            }
          }

          if (item.parts.size === item.total) {
            let assembled = '';
            for (let i = 0; i < item.total; i++) assembled += item.parts.get(i) || '';
            fullPayloadStr = assembled;
            incomingFragments.delete(_fragId);
          } else {
            return;
          }
        }

        const rawCipher = typeof fullPayloadStr === 'string' ? JSON.parse(fullPayloadStr) : fullPayloadStr;
        const message = await this.vault.decrypt(rawCipher, false);

        if (message.type === 'SDP_OFFER' || message.type === 'MEDIA_RENEGOTIATE_OFFER') {
          await this.handleRemoteDescription(peerId, message.description || message.offer);
          return;
        } else if (message.type === 'SDP_ANSWER' || message.type === 'MEDIA_RENEGOTIATE_ANSWER') {
          await this.handleRemoteDescription(peerId, message.description || message.answer);
          return;
        }

        if (message && message._gspId) {
          if (!this.processedGossipIds.addIfNew(message._gspId)) return;
          this.emit('message-received', { peerId: message._origin || peerId, message: message.payload });

          if (message._ttl > 1) {
            const forwarded = GossipEnvelope.advance(message, this.vault.peerIdHex);
            this.broadcast(forwarded, peerId);
          }
          return;
        }

        this.emit('message-received', { peerId, message });
      } catch (e) {
        logger.warn('P2P Mesh', `Message de contrôle indéchiffrable de ${peerId}:`, e.message);
      }
    };
  }

  _handleControlChannelOpen(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || peer._controlReady) return;
    peer._controlReady = true;

    logger.info('P2P Mesh', `🟢 Canal 'p2p-control' OUVERT avec ${peerId}`);

    this.sendToPeer(peerId, {
      type: 'PEER_HELLO',
      name: this.vault.userName,
      pubkey: this.vault.publicKeyHex
    });

    if (this.localMediaStream) {
      this.attachLocalMediaStream(this.localMediaStream);
    }

    this.emit('peer-ready', peer);
  }

  setupDataChannel(channel, peerId) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = CONFIG.DRIVE?.BUFFERED_AMOUNT_LOW_THRESHOLD || (64 * 1024);

    channel.onopen = () => {
      logger.info('P2P Mesh', `🟢 Canal binaire 'p2p-data' OUVERT avec ${peerId}`);
    };

    channel.onmessage = async (event) => {
      try {
        const raw = event.data;
        if (raw instanceof ArrayBuffer && new Uint8Array(raw)[0] === 0x50) {
          await this.binaryRouter.decodeAndRoute(raw, peerId);
        } else {
          this.emit('chunk-received', {
            peerId,
            buffer: raw
          });
        }
      } catch (err) {
        logger.debug('P2P Mesh', 'Erreur réception binaire:', err);
      }
    };
  }

  setupConnectedPeer(peerId, pc, controlChannel, dataChannel) {
    if (!peerId || this.peers.has(peerId)) return;

    this.setupControlChannel(controlChannel, peerId);
    this.setupDataChannel(dataChannel, peerId);

    const peerData = {
      id: peerId,
      name: 'Membre en connexion...',
      connection: pc,
      controlChannel,
      dataChannel,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      latencyMs: 0
    };

    this.peers.set(peerId, peerData);
    logger.info('P2P Mesh', `🚀 PAIR ENREGISTRÉ DANS LE MAILLAGE : ${peerId} (Total: ${this.peers.size})`);
    
    this.emit('peer-joined', peerData);
    this.emit('status-change', {
      status: 'connected',
      peersCount: this.peers.size,
      message: `${this.peers.size} pair(s) connecté(s)`
    });

    if (controlChannel.readyState === 'open') {
      this._handleControlChannelOpen(peerId);
    }
  }

  _teardownPeerConnection(peer) {
    if (!peer) return;
    try {
      ['controlChannel', 'dataChannel'].forEach(key => {
        const ch = peer[key];
        if (ch) {
          ch.onopen = null;
          ch.onmessage = null;
          ch.onerror = null;
          ch.onclose = null;
          if (ch.readyState !== 'closed') ch.close();
        }
      });

      if (peer.connection) {
        const senders = peer.connection.getSenders?.() || [];
        senders.forEach(s => {
          try { s.track?.stop(); } catch (_) {}
        });

        peer.connection.ontrack = null;
        peer.connection.ondatachannel = null;
        peer.connection.onicecandidate = null;
        peer.connection.oniceconnectionstatechange = null;
        peer.connection.onconnectionstatechange = null;

        if (peer.connection.signalingState !== 'closed') {
          peer.connection.close();
        }
      }
    } catch (err) {
      logger.warn('P2P Mesh', `Erreur teardown pair ${peer.id}:`, err);
    }
  }

  removePeer(peerId) {
    if (!peerId) return;
    this._clearGraceTimer(peerId);
    const peer = this.peers.get(peerId);
    if (peer) {
      this._teardownPeerConnection(peer);
      this.peers.delete(peerId);
      this.iceManagers.delete(peerId);
      logger.info('P2P Mesh', `🔴 Pair retiré : ${peerId} (Restants: ${this.peers.size})`);
      this.emit('peer-left', { peerId, info: peer });
      this.emit('status-change', { 
        status: this.peers.size > 0 ? 'connected' : 'idle', 
        peersCount: this.peers.size,
        message: `${this.peers.size} pair(s) connecté(s)` 
      });
    }
  }

  // --- Automate Perfect Negotiation W3C & Rollbacks ---

  _getOrCreateNegotiationState(peerId, remotePubkeyHex = '') {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    if (!peer._negotiation) {
      peer._negotiation = new PeerNegotiationState(peerId, this.signalingPeerId, remotePubkeyHex);
      logger.info('P2P Mesh', `🎭 Rôle Perfect Negotiation pour ${peerId} : [${peer._negotiation.isPolite ? 'POLI' : 'IMPOLI'}]`);
    }
    return peer._negotiation;
  }

  async renegotiatePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.connection || peer.connection.signalingState === 'closed') return;

    const neg = this._getOrCreateNegotiationState(peerId);
    if (!neg) return;

    if (neg.makingOffer) {
      neg.queuedNegotiation = true;
      return;
    }

    const pc = peer.connection;
    const startTime = Date.now();

    try {
      neg.makingOffer = true;
      logger.info('P2P Mesh', `🔄 [${peerId}] Début de renégociation Perfect Negotiation...`);

      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;

      await pc.setLocalDescription(offer);
      neg.metrics.offersCreated++;

      await this.sendToPeer(peerId, {
        type: 'SDP_OFFER',
        description: {
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp
        }
      });
    } catch (err) {
      logger.error('P2P Mesh', `❌ [${peerId}] Échec renegotiatePeer:`, err);
    } finally {
      neg.makingOffer = false;
      neg.metrics.lastNegotiationDurationMs = Date.now() - startTime;

      if (neg.queuedNegotiation) {
        neg.queuedNegotiation = false;
        setTimeout(() => this.renegotiatePeer(peerId), 50);
      }
    }
  }

  async handleRemoteDescription(peerId, description) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.connection || peer.connection.signalingState === 'closed') return;

    const neg = this._getOrCreateNegotiationState(peerId);
    const pc = peer.connection;
    const isOffer = description.type === 'offer';

    const readyForOffer = !neg.makingOffer && (pc.signalingState === 'stable' || neg.isSettingRemoteAnswerPending);
    const offerCollision = isOffer && !readyForOffer;

    neg.ignoreOffer = !neg.isPolite && offerCollision;

    if (neg.ignoreOffer) {
      neg.metrics.glareCollisions++;
      logger.warn('P2P Mesh', `🛡️ [Impolite] Glare détecté avec ${peerId}. Offre concurrente ignorée.`);
      return;
    }

    if (offerCollision && neg.isPolite) {
      neg.metrics.glareCollisions++;
      neg.metrics.rollbacksExecuted++;
      logger.info('P2P Mesh', `🙇 [Polite] Glare détecté avec ${peerId}. Exécution rollback W3C...`);
      await pc.setLocalDescription({ type: 'rollback' });
    }

    neg.isSettingRemoteAnswerPending = !isOffer;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(description));
    } catch (err) {
      logger.error('P2P Mesh', `❌ Erreur setRemoteDescription (${description.type}) de ${peerId}:`, err);
      return;
    } finally {
      neg.isSettingRemoteAnswerPending = false;
    }

    if (isOffer) {
      try {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        neg.metrics.answersCreated++;

        await this.sendToPeer(peerId, {
          type: 'SDP_ANSWER',
          description: {
            type: pc.localDescription.type,
            sdp: pc.localDescription.sdp
          }
        });
      } catch (err) {
        logger.error('P2P Mesh', `❌ Erreur création réponse ${peerId}:`, err);
      }
    }
  }

  // --- Envoi de Données & Contre-Pression Événementielle ---

  async sendToPeer(peerId, payload) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.controlChannel || peer.controlChannel.readyState !== 'open') {
      return false;
    }

    const encrypted = await this.vault.encrypt(payload, false);
    const jsonStr = JSON.stringify(encrypted);
    const MAX_CHUNK_SIZE = CONFIG.LIMITS?.MAX_DATACHANNEL_CHUNK || 15000;
    const HIGH_WATERMARK = 64 * 1024;

    const drainBuffer = async () => {
      if (peer.controlChannel.bufferedAmount <= HIGH_WATERMARK) return;
      return new Promise((resolve) => {
        const handler = () => {
          peer.controlChannel.removeEventListener('bufferedamountlow', handler);
          resolve();
        };
        peer.controlChannel.addEventListener('bufferedamountlow', handler);
        setTimeout(handler, 1000);
      });
    };

    if (jsonStr.length <= MAX_CHUNK_SIZE) {
      await drainBuffer();
      peer.controlChannel.send(jsonStr);
    } else {
      const fragId = `frag_${Math.random().toString(36).substr(2, 8)}`;
      const totalParts = Math.ceil(jsonStr.length / MAX_CHUNK_SIZE);

      for (let i = 0; i < totalParts; i++) {
        await drainBuffer();
        const slice = jsonStr.substring(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE);
        const packet = {
          _isFrag: true,
          _fragId: fragId,
          _part: i,
          _total: totalParts,
          _data: slice
        };
        peer.controlChannel.send(JSON.stringify(packet));
      }
    }

    return true;
  }

  async broadcast(payload, excludePeerId = null) {
    if (this.peers.size === 0) return 0;

    const encrypted = await this.vault.encrypt(payload, false);
    const jsonStr = JSON.stringify(encrypted);
    const MAX_CHUNK_SIZE = CONFIG.LIMITS?.MAX_DATACHANNEL_CHUNK || 15000;

    const sendPromises = [];

    for (const [peerId, peer] of this.peers) {
      if (excludePeerId && peerId === excludePeerId) continue;
      if (peer.controlChannel?.readyState === 'open') {
        sendPromises.push((async () => {
          if (jsonStr.length <= MAX_CHUNK_SIZE) {
            peer.controlChannel.send(jsonStr);
          } else {
            const fragId = `frag_${Math.random().toString(36).substr(2, 8)}`;
            const totalParts = Math.ceil(jsonStr.length / MAX_CHUNK_SIZE);
            for (let i = 0; i < totalParts; i++) {
              const slice = jsonStr.substring(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE);
              peer.controlChannel.send(JSON.stringify({
                _isFrag: true, _fragId: fragId, _part: i, _total: totalParts, _data: slice
              }));
            }
          }
          return true;
        })());
      }
    }

    const results = await Promise.allSettled(sendPromises);
    return results.filter(r => r.status === 'fulfilled' && r.value).length;
  }

  async sendBinaryChunkSliced(peerId, hashHex, arrayBuffer) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') return false;

    return this.flowController.sendBinaryChunkPaced(peer.dataChannel, hashHex, arrayBuffer, {
      rttMs: peer.latencyMs || 30,
      isMediaActive: this.isMediaActive()
    });
  }

  // --- Gestion des Pistes Média (Audio/Vidéo) & QoS ---

  _configureTransceiverCodecs(transceiver, kind) {
    SDPOptimizer.applyCodecPreferences(transceiver, kind);
  }

  async attachLocalMediaStream(stream) {
    logger.info('P2P Mesh', '🎙️ Injection MediaStream local avec codecs optimisés et QoS...');
    this.localMediaStream = stream;

    for (const [peerId, peer] of this.peers) {
      if (peer.connection) {
        let needsRenegotiation = false;
        for (const track of stream.getTracks()) {
          if (track.kind === 'audio') {
            track.contentHint = 'speech';
          } else if (track.kind === 'video') {
            track.contentHint = 'motion';
          }

          const transceivers = peer.connection.getTransceivers();
          const target = transceivers.find(t => t.sender && t.sender.track && t.sender.track.kind === track.kind) ||
                         transceivers.find(t => !t.sender.track && t.receiver && t.receiver.track && t.receiver.track.kind === track.kind);

          if (target && target.sender) {
            this._configureTransceiverCodecs(target, track.kind);
            await target.sender.replaceTrack(track);
            if (typeof target.sender.setStreams === 'function') {
              try { target.sender.setStreams(stream); } catch (e) {}
            }
            await this._applySenderQoS(target.sender, track.kind);
          } else {
            const senders = peer.connection.getSenders();
            const exists = senders.some(s => s.track && s.track.id === track.id);
            if (!exists) {
              const sender = peer.connection.addTrack(track, stream);
              if (typeof sender.setStreams === 'function') {
                try { sender.setStreams(stream); } catch (e) {}
              }
              const associatedTransceiver = transceivers.find(t => t.sender === sender);
              if (associatedTransceiver) {
                this._configureTransceiverCodecs(associatedTransceiver, track.kind);
              }
              await this._applySenderQoS(sender, track.kind);
              needsRenegotiation = true;
            }
          }
        }

        if (needsRenegotiation) {
          await this.renegotiatePeer(peerId);
        }
      }
    }
  }

  async replaceAudioTrack(track) {
    if (track) track.contentHint = 'speech';

    for (const [peerId, peer] of this.peers) {
      if (!peer.connection) continue;
      const senders = peer.connection.getSenders();
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio') ||
        senders.find(s => !s.track && peer.connection.getTransceivers().some(t => t.sender === s));

      if (audioSender) {
        try {
          await audioSender.replaceTrack(track);
          await this._applySenderQoS(audioSender, 'audio');
          logger.info('P2P Mesh', `🎙️ [Hot-Swap] replaceAudioTrack réussi pour ${peerId}`);
        } catch (err) {
          logger.warn('P2P Mesh', `Erreur replaceAudioTrack pour ${peerId}:`, err);
        }
      }
    }
  }

  async replaceVideoTrack(track, hint = 'motion') {
    if (track) track.contentHint = hint;
    const isScreenShare = hint === 'detail';

    for (const [peerId, peer] of this.peers) {
      if (!peer.connection) continue;
      const senders = peer.connection.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video') ||
        senders.find(s => !s.track && peer.connection.getTransceivers().some(t => t.sender === s));

      if (videoSender) {
        try {
          await videoSender.replaceTrack(track);
          await this._applySenderQoS(videoSender, 'video', isScreenShare);
        } catch (err) {
          logger.warn('P2P Mesh', `Erreur replaceVideoTrack pour ${peerId}:`, err);
        }
      }
    }
  }

  applyVideoBitrate(peerId, rttMs, isScreenShare = false) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.connection) return;
    const senders = peer.connection.getSenders ? peer.connection.getSenders() : [];
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    if (!videoSender || !videoSender.getParameters) return;

    try {
      const params = videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      
      let targetBitrate = isScreenShare ? 2800000 : 1800000;
      if (rttMs > 250) targetBitrate = Math.round(targetBitrate * 0.4);
      else if (rttMs > 120) targetBitrate = Math.round(targetBitrate * 0.7);

      params.encodings[0].maxBitrate = targetBitrate;
      videoSender.setParameters(params).catch(() => {});
    } catch (e) {}
  }

  resyncPeerJitterBuffers(pc, offsetMs) {
    if (this.qualityManager) {
      this.qualityManager.resyncPeerJitterBuffers(pc, offsetMs);
    }
  }

  async _applySenderQoS(sender, kind, isScreenShare = false) {
    if (!sender || !sender.getParameters) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];

      if (kind === 'audio') {
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].maxBitrate = CONFIG.MEDIA?.AUDIO?.MAX_BITRATE || 128000;
      } else if (kind === 'video') {
        if (isScreenShare) {
          params.encodings[0].priority = 'medium';
          params.encodings[0].networkPriority = 'medium';
          params.degradationPreference = 'maintain-resolution';
          params.encodings[0].scaleResolutionDownBy = 1.0;
          params.encodings[0].maxFramerate = 15;
        } else {
          params.encodings[0].priority = 'low';
          params.encodings[0].networkPriority = 'medium';
          params.degradationPreference = 'maintain-framerate';
        }
      }

      await sender.setParameters(params);
    } catch (err) {
      logger.debug('P2P Mesh', 'Avertissement QoS sender:', err.message);
    }
  }

  applyReceiverJitterTarget(pc, targetMs = 50) {
    if (!pc || typeof pc.getReceivers !== 'function') return;
    pc.getReceivers().forEach(receiver => {
      if ('jitterBufferTarget' in receiver) {
        receiver.jitterBufferTarget = targetMs;
      } else if ('playoutDelayHint' in receiver) {
        receiver.playoutDelayHint = targetMs / 1000;
      }
    });
  }

  removeLocalMediaStream() {
    if (this.localMediaStream) {
      logger.info('P2P Mesh', '⏹️ Arrêt MediaStream local');
      this.localMediaStream.getTracks().forEach(t => t.stop());
      this.localMediaStream = null;
    }
    this.peers.forEach((peer) => {
      if (peer.connection) {
        peer.connection.getSenders().forEach(sender => {
          try { sender.replaceTrack(null); } catch (e) {}
        });
      }
    });
  }

  async detachVideoTracks() {
    for (const [peerId, peer] of this.peers) {
      if (!peer.connection) continue;
      let changed = false;
      const transceivers = peer.connection.getTransceivers ? peer.connection.getTransceivers() : [];
      for (const t of transceivers) {
        if (t.sender && t.sender.track && t.sender.track.kind === 'video') {
          try {
            await t.sender.replaceTrack(null);
            t.direction = t.receiver && t.receiver.track ? 'recvonly' : 'inactive';
            changed = true;
          } catch (e) {}
        }
      }
      if (changed) {
        try { await this.renegotiatePeer(peerId); } catch (e) {}
      }
    }
  }

  handleNetworkOnline() {
    logger.info('P2P Mesh', '🌐 Rétablissement connexion réseau : réactivation proactive...');
    for (const trackerUrl of CONFIG.TRACKERS) {
      const existing = this.trackers.get(trackerUrl);
      if (!existing || existing.readyState !== WebSocket.OPEN) {
        this.connectToTracker(trackerUrl);
      }
    }
    for (const nostrUrl of (CONFIG.NOSTR_RELAYS || [])) {
      const existing = this.nostrRelays.get(nostrUrl);
      if (!existing || existing.readyState !== WebSocket.OPEN) {
        this.connectToNostrRelay(nostrUrl);
      }
    }
    setTimeout(() => this.announceAllTrackers(), 500);
  }

  handleNetworkOffline() {
    logger.warn('P2P Mesh', '🔌 Perte de connectivité Internet.');
  }
}
