import { logger } from './logger.js';
/**
 * Moteur Réseau P2P Mesh & Coordinateur de Swarm Décentralisé (2025/2026)
 * Signalement multi-canaux (WebTorrent + Nostr), négociation WebRTC avec transceivers,
 * contre-pression événementielle sans polling, framing MTU 16 Ko et télémétrie eMOS.
 */

import { CONFIG } from './config.js';
import { BoundedSet, TTLMap, GenerationalSlidingCache, GossipEnvelope } from './bounded-cache.js';
import { CryptoVault } from './crypto-vault.js';
import { WebRTCTelemetryEngine } from './webrtc-telemetry.js';

export class P2PMeshNetwork {
  constructor(cryptoVault) {
    this.vault = cryptoVault;
    this.signalingPeerId = CryptoVault.bufferToHex(crypto.getRandomValues(new Uint8Array(20)));
    this.peers = new Map(); // peerId -> { id, name, connection, controlChannel, dataChannel, connectedAt, lastSeen, latencyMs, incomingFragments: Map }
    this.trackers = new Map(); // trackerUrl -> WebSocket
    this._trackerBackoff = new Map(); // trackerUrl -> delayMs
    this.nostrRelays = new Map(); // relayUrl -> WebSocket
    this.eventListeners = new Map();

    // Moteur de Télémétrie getStats() 2026
    this.telemetry = new WebRTCTelemetryEngine(this);

    // Timers de grâce de déconnexion et verrous d'ICE Restart
    this.peerGraceTimers = new Map(); // peerId -> timer
    this.iceRestartInProgress = new Set(); // peerId

    // Offres SDP en attente de réponse : bornées + TTL
    this.activeOffers = new TTLMap({
      maxSize: 256,
      ttlMs: CONFIG.TIMINGS.OFFER_TTL || 45000,
      onEvict: (offerId, entry) => {
        try { entry?.pc?.close(); } catch (e) { logger.debug('P2P Mesh', 'Erreur fermeture RTCPeerConnection expirée:', e); }
      }
    });

    // Anti-doublon des offres et messages de diffusion Gossip
    this.processedOfferIds = new BoundedSet(4000);
    this.processedGossipIds = new GenerationalSlidingCache({ generationSize: 20000, rotateIntervalMs: 90000 });

    this.announceInterval = null;
    this.maintenanceInterval = null;
    this.localMediaStream = null;
  }

  // --- Gestionnaire d'Événements ---

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

  /**
   * Démarre la connexion au réseau P2P pour le Topic dérivé du code papier
   */
  async start() {
    if (!this.vault.isInitialized) {
      throw new Error('Le coffre cryptographique doit être initialisé');
    }

    logger.info('P2P Mesh', `🚀 Démarrage du réseau Mesh pour Topic: ${this.vault.topicHex.substring(0, 10)}... (Pair: ${this.vault.peerIdHex.substring(0, 12)}...)`);
    this.emit('status-change', { status: 'connecting', message: 'Connexion aux relais de découverte...' });

    // Démarrage de la télémétrie périodique (2s)
    this.telemetry.start(2000);

    // 1. Connexion aux trackers WebTorrent WSS
    for (const trackerUrl of CONFIG.TRACKERS) {
      logger.info('P2P Mesh', `🌐 Connexion au tracker WebTorrent: ${trackerUrl}`);
      this.connectToTracker(trackerUrl);
    }

    // 2. Connexion aux relais Nostr (Signalement décentralisé complémentaire)
    for (const nostrUrl of (CONFIG.NOSTR_RELAYS || [])) {
      logger.info('P2P Mesh', `⚡ Connexion au relais Nostr: ${nostrUrl}`);
      this.connectToNostrRelay(nostrUrl);
    }

    // Boucle d'annonce périodique (30s)
    const announcePeriod = CONFIG.TIMINGS.DEFAULT_ANNOUNCE_INTERVAL || 30000;
    this.announceInterval = setInterval(() => {
      logger.debug('P2P Mesh', '🔄 Déclenchement de l\'annonce périodique sur les trackers...');
      this.announceAllTrackers();
    }, announcePeriod);

    // Boucle de maintenance : purge des offres SDP expirées
    this.maintenanceInterval = setInterval(() => {
      this.activeOffers.sweep();
    }, 10000);

    return this;
  }

  /**
   * Arrêt gracieux avec notification 'stopped' vers tous les trackers
   */
  async stop() {
    logger.info('P2P Mesh', '🛑 Arrêt gracieux du maillage P2P et libération des ressources...');
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }

    this.telemetry.stop();

    // Envoi de l'annonce de départ "stopped" vers tous les trackers ouverts
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

    this.emit('status-change', { status: 'disconnected', message: 'Déconnecté du réseau P2P' });
  }

  // --- Rassemblement ICE WebRTC Adaptatif & Court-Circuit ---

  async waitForIceGathering(pc, maxTimeoutMs = 2000, earlyExitMs = 300) {
    if (pc.iceGatheringState === 'complete') {
      return pc.localDescription;
    }
    return new Promise((resolve) => {
      let timer = null;
      let earlyTimer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (earlyTimer) clearTimeout(earlyTimer);
        pc.removeEventListener('icegatheringstatechange', checkState);
        pc.removeEventListener('icecandidate', onCandidate);
      };

      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          cleanup();
          resolve(pc.localDescription);
        }
      };

      // Court-circuit dès la découverte d'un candidat STUN (srflx) ou TURN (relay)
      const onCandidate = (event) => {
        if (event.candidate && (event.candidate.type === 'srflx' || event.candidate.type === 'relay')) {
          if (!earlyTimer) {
            earlyTimer = setTimeout(() => {
              cleanup();
              resolve(pc.localDescription);
            }, earlyExitMs);
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

      // Handshake timeout de 6s pour éviter les sockets zombies
      const connectTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          logger.warn('P2P Mesh', `⏱️ Timeout handshake tracker (${trackerUrl}), abandon`);
          try { ws.close(); } catch (e) {}
        }
      }, CONFIG.TIMINGS.TRACKER_CONNECT_TIMEOUT || 6000);

      ws.onopen = () => {
        clearTimeout(connectTimer);
        logger.info('P2P Mesh', `✅ Connecté au tracker: ${trackerUrl}`);
        this._trackerBackoff.set(trackerUrl, CONFIG.TIMINGS.RECONNECT_DELAY || 5000);
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
        logger.warn('P2P Mesh', `Erreur sur le tracker ${trackerUrl}:`, err);
      };

      ws.onclose = () => {
        clearTimeout(connectTimer);
        logger.info('P2P Mesh', `🔌 Connexion fermée avec tracker ${trackerUrl}`);
        this.trackers.delete(trackerUrl);

        if (!this.announceInterval) return; // Arrêt volontaire

        // Reconnexion avec Backoff Exponentiel + Full Jitter
        const currentDelay = this._trackerBackoff.get(trackerUrl) || (CONFIG.TIMINGS.RECONNECT_DELAY || 5000);
        const nextDelay = Math.min(currentDelay * 1.5, CONFIG.TIMINGS.MAX_RECONNECT_DELAY || 60000);
        const jitter = nextDelay * (0.8 + Math.random() * 0.4);
        this._trackerBackoff.set(trackerUrl, nextDelay);

        setTimeout(() => {
          if (this.announceInterval && navigator.onLine) {
            logger.info('P2P Mesh', `🔄 Reconnexion planifiée tracker (${Math.round(jitter / 1000)}s): ${trackerUrl}`);
            this.connectToTracker(trackerUrl);
          }
        }, jitter);
      };
    } catch (e) {
      logger.warn('P2P Mesh', `❌ Exception connexion tracker ${trackerUrl}:`, e);
    }
  }

  async announceAllTrackers() {
    this.trackers.forEach((ws, url) => {
      if (ws.readyState === WebSocket.OPEN) {
        this.announceToTracker(ws, url, 'update');
      }
    });
  }

  /**
   * Envoie une annonce au tracker avec offres WebRTC parallèles
   */
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
          ordered: false,
          priority: 'very-low',
          maxRetransmits: 0
        });

        const rawOffer = await pc.createOffer();
        await pc.setLocalDescription(rawOffer);

        const completeOffer = await this.waitForIceGathering(pc, 2000, 300);
        const sanitizedOffer = this._sanitizeAndPadSDP(completeOffer.sdp);

        const encryptedOffer = await this.vault.encrypt({
          type: completeOffer.type,
          sdp: sanitizedOffer.sdp,
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

    const infoHashHex = this.vault.topicHex.substring(0, 40);
    const peerIdHex = this.signalingPeerId;

    const announceMsg = {
      action: 'announce',
      info_hash: infoHashHex,
      peer_id: peerIdHex,
      numwant: eventType === 'stopped' ? 0 : 10,
      uploaded: 0,
      downloaded: 0,
      left: 0
    };

    if (eventType && eventType !== 'update') {
      announceMsg.event = eventType;
    }
    if (offers.length > 0) {
      announceMsg.offers = offers;
    }

    try {
      ws.send(JSON.stringify(announceMsg));
      logger.info('P2P Mesh', `📤 Annonce envoyée [Event: ${eventType}, Offers: ${offers.length}] vers ${trackerUrl}`);
    } catch (err) {
      logger.warn('P2P Mesh', `Échec envoi announce vers ${trackerUrl}:`, err);
    }
  }

  /**
   * Nettoie les candidats du SDP tout en préservant le LAN (.local mDNS)
   */
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
    const blockSize = CONFIG.PRIVACY?.SDP_PADDING_BLOCK_SIZE || 2048;
    const padLength = (blockSize - (cleaned.length % blockSize)) % blockSize;
    return {
      sdp: cleaned,
      _pad: '0'.repeat(padLength)
    };
  }

  /**
   * Traite les messages entrants des trackers
   */
  async handleTrackerMessage(data, ws) {
    if (!data) return;

    if (data['failure reason']) {
      logger.warn('P2P Mesh', `⚠️ Erreur signalée par le tracker: ${data['failure reason']}`);
      return;
    }

    if (data.action === 'announce') {
      const senderPeerIdHex = data.peer_id ? String(data.peer_id) : '';

      // Ignore nos propres annonces
      if (senderPeerIdHex === this.signalingPeerId || senderPeerIdHex === this.vault.peerIdHex) {
        return;
      }

      // Contrôle de routage : ignore les messages explicitement destinés à un tiers
      if (data.to_peer_id && String(data.to_peer_id) !== this.signalingPeerId) {
        return;
      }

      const remotePeerId = `peer_${senderPeerIdHex.substring(0, 16)}`;
      if (this.peers.has(remotePeerId)) {
        return;
      }

      // 1. Réception d'une offre WebRTC
      if (data.offer && data.offer_id) {
        if (!this.processedOfferIds.addIfNew(data.offer_id)) return;

        logger.info('P2P Mesh', `🤝 Offre WebRTC entrante de ${remotePeerId} [OfferID: ${data.offer_id}] !`);

        try {
          let cipherPayload = data.offer;
          if (data.offer && typeof data.offer === 'object' && data.offer.sdp) {
            try {
              cipherPayload = JSON.parse(data.offer.sdp);
            } catch (e) {
              cipherPayload = data.offer.sdp;
            }
          }

          const decryptedOffer = await this.vault.decrypt(cipherPayload, true);
          if (!decryptedOffer || !decryptedOffer.sdp) {
            throw new Error('SDP manquant dans l\'offre déchiffrée');
          }

          const pc = this.createPeerConnection(remotePeerId);

          await pc.setRemoteDescription(new RTCSessionDescription({
            type: decryptedOffer.type || 'offer',
            sdp: decryptedOffer.sdp
          }));

          const rawAnswer = await pc.createAnswer();
          await pc.setLocalDescription(rawAnswer);

          const completeAnswer = await this.waitForIceGathering(pc, 2000, 300);
          const sanitizedAnswer = this._sanitizeAndPadSDP(completeAnswer.sdp);

          const encryptedAnswer = await this.vault.encrypt({
            type: completeAnswer.type,
            sdp: sanitizedAnswer.sdp,
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

          logger.info('P2P Mesh', `📤 Envoi de la réponse SDP chiffrée vers ${remotePeerId}...`);
          ws.send(JSON.stringify(answerMsg));
        } catch (err) {
          logger.warn('P2P Mesh', 'Rejet offre reçue:', err.message);
        }
      }

      // 2. Réception d'une réponse à une offre existante
      if (data.answer && data.offer_id) {
        logger.info('P2P Mesh', `📥 Réponse SDP reçue pour l'offre ${data.offer_id}...`);
        const pending = this.activeOffers.get(data.offer_id);
        if (pending && pending.pc) {
          try {
            let cipherAnswerPayload = data.answer;
            if (data.answer && typeof data.answer === 'object' && data.answer.sdp) {
              try {
                cipherAnswerPayload = JSON.parse(data.answer.sdp);
              } catch (e) {
                cipherAnswerPayload = data.answer.sdp;
              }
            }

            const decryptedAnswer = await this.vault.decrypt(cipherAnswerPayload, true);
            pending.pc._remotePeerId = remotePeerId;
            await pending.pc.setRemoteDescription(new RTCSessionDescription({
              type: decryptedAnswer.type || 'answer',
              sdp: decryptedAnswer.sdp
            }));

            this.setupConnectedPeer(remotePeerId, pending.pc, pending.controlChannel, pending.dataChannel);
            this.activeOffers.delete(data.offer_id);
          } catch (err) {
            logger.warn('P2P Mesh', '❌ Échec traitement réponse SDP:', err.message);
          }
        }
      }
    }
  }

  // --- Signalement via Relais Nostr (NIP-01 / NIP-40) ---

  connectToNostrRelay(relayUrl) {
    try {
      const ws = new WebSocket(relayUrl);
      this.nostrRelays.set(relayUrl, ws);

      ws.onopen = () => {
        logger.info('P2P Mesh', `⚡ Connecté au relais Nostr: ${relayUrl}`);
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
          logger.warn('P2P Mesh', 'Erreur traitement événement Nostr:', e);
        }
      };

      ws.onerror = (err) => { logger.warn('P2P Mesh', `Erreur WebSocket relais Nostr (${relayUrl}):`, err); };
      ws.onclose = () => {
        this.nostrRelays.delete(relayUrl);
      };
    } catch (e) {
      logger.warn('P2P Mesh', `Exception connexion relais Nostr (${relayUrl}):`, e);
    }
  }

  // --- Gestion des Connexions WebRTC & Lifecycle ---

  createPeerConnection(remotePeerId, options = {}) {
    const forceRelay = CONFIG.PRIVACY?.FORCE_RELAY_ONLY === true;
    const poolSize = options.poolSize !== undefined ? options.poolSize : (forceRelay ? 0 : 2);

    const pc = new RTCPeerConnection({
      iceServers: CONFIG.ICE_SERVERS,
      iceTransportPolicy: forceRelay ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: poolSize
    });

    pc._remotePeerId = remotePeerId || null;

    let controlChannel = null;
    let dataChannel = null;

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      const pid = pc._remotePeerId;
      logger.info('P2P Mesh', `📦 Canal de données reçu du pair [${pid || 'nouveau'}]: "${channel.label}"`);
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
      logger.info('P2P Mesh', `🎥 Piste média reçue [Kind: ${event.track.kind}, TrackID: ${event.track.id}] de ${pid}`);
      this.applyReceiverJitterTarget(pc, CONFIG.MEDIA?.DEFAULT_JITTER_TARGET_MS || 50);
      this.emit('track-received', {
        peerId: pid,
        track: event.track,
        streams: event.streams
      });
    };

    // Gestion du cycle de vie de connexion avec période de grâce anti-coupure Wi-Fi/4G
    pc.oniceconnectionstatechange = () => {
      const pid = pc._remotePeerId;
      const state = pc.iceConnectionState;
      logger.info('P2P Mesh', `🌐 État ICE [${pid || 'nouveau'}] : ${state}`);

      if (state === 'connected' || state === 'completed') {
        this._clearGraceTimer(pid);
        logger.info('P2P Mesh', `🌟 Connexion directe WebRTC P2P ÉTABLIE avec ${pid || 'pair distant'} !`);
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
      logger.info('P2P Mesh', `🌐 connectionState [${pid || 'nouveau'}] : ${state}`);
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
    const graceMs = CONFIG.TIMINGS?.ICE_DISCONNECT_GRACE_MS || 4000;
    logger.warn('P2P Mesh', `⚠️ Liaison instable avec ${peerId}. Délai de grâce (${graceMs} ms)...`);

    this._clearGraceTimer(peerId);
    const timer = setTimeout(async () => {
      if (pc.iceConnectionState === 'disconnected') {
        logger.warn('P2P Mesh', `⏰ Expiration grâce pour ${peerId} -> déclenchement ICE Restart...`);
        await this.triggerIceRestart(peerId);
      }
    }, graceMs);

    this.peerGraceTimers.set(peerId, timer);
  }

  _handlePeerFailed(peerId, pc) {
    this._clearGraceTimer(peerId);
    if (!peerId) return;
    logger.warn('P2P Mesh', `❌ Échec ICE avec ${peerId}, tentative ultime de récupération...`);
    this.triggerIceRestart(peerId).catch(() => this.removePeer(peerId));
  }

  _clearGraceTimer(peerId) {
    if (peerId && this.peerGraceTimers.has(peerId)) {
      clearTimeout(this.peerGraceTimers.get(peerId));
      this.peerGraceTimers.delete(peerId);
    }
  }

  async triggerIceRestart(peerId) {
    if (!peerId || this.iceRestartInProgress.has(peerId)) return;
    this.iceRestartInProgress.add(peerId);

    const peer = this.peers.get(peerId);
    if (!peer || !peer.connection) {
      this.iceRestartInProgress.delete(peerId);
      return;
    }

    try {
      logger.info('P2P Mesh', `🔄 Déclenchement d'un ICE Restart in-place pour ${peerId}...`);
      if (typeof peer.connection.restartIce === 'function') {
        peer.connection.restartIce();
      }
      if (peer.controlChannel && peer.controlChannel.readyState === 'open') {
        await this.renegotiatePeer(peerId);
      }
    } catch (err) {
      logger.warn('P2P Mesh', `Échec ICE restart vers ${peerId}:`, err);
      this.removePeer(peerId);
    } finally {
      this.iceRestartInProgress.delete(peerId);
    }
  }

  setupControlChannel(channel, peerId) {
    const incomingFragments = new Map();

    channel.onopen = () => this._handleControlChannelOpen(peerId);

    channel.onmessage = async (event) => {
      try {
        let fullPayloadStr = event.data;
        const parsed = JSON.parse(event.data);

        // Réassemblage des messages fragmentés
        if (parsed && parsed._isFrag) {
          const { _fragId, _part, _total, _data } = parsed;

          const MAX_PARTS = CONFIG.LIMITS.MAX_FRAGMENT_PARTS;
          const MAX_ASSEMBLED = CONFIG.LIMITS.MAX_ASSEMBLED_CONTROL_BYTES;
          if (typeof _fragId !== 'string' ||
              !Number.isInteger(_total) || _total < 1 || _total > MAX_PARTS ||
              !Number.isInteger(_part) || _part < 0 || _part >= _total ||
              typeof _data !== 'string') {
            logger.warn('P2P Mesh', `Fragment invalide rejeté de ${peerId}`);
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
              logger.warn('P2P Mesh', `Message fragmenté trop grand de ${peerId} — abandon`);
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

        // Traitement de la renégociation SDP in-band
        if (message.type === 'MEDIA_RENEGOTIATE_OFFER') {
          await this.handleRenegotiateOffer(peerId, message.offer);
          return;
        } else if (message.type === 'MEDIA_RENEGOTIATE_ANSWER') {
          await this.handleRenegotiateAnswer(peerId, message.answer);
          return;
        }

        // Traitement de diffusion Gossip enveloppée
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

    channel.onmessage = (event) => {
      this.emit('chunk-received', {
        peerId,
        buffer: event.data
      });
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
      logger.info('P2P Mesh', `🔴 Pair retiré : ${peerId} (Restants: ${this.peers.size})`);
      this.emit('peer-left', { peerId, info: peer });
      this.emit('status-change', { 
        status: this.peers.size > 0 ? 'connected' : 'idle', 
        peersCount: this.peers.size,
        message: `${this.peers.size} pair(s) connecté(s)` 
      });
    }
  }

  // --- Renégociation WebRTC In-Band ---

  async renegotiatePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.connection || !peer.controlChannel || peer.controlChannel.readyState !== 'open') return;

    try {
      logger.info('P2P Mesh', `🔄 Renégociation WebRTC in-band vers ${peerId}...`);
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      const completeOffer = await this.waitForIceGathering(peer.connection, 1500, 200);

      await this.sendToPeer(peerId, {
        type: 'MEDIA_RENEGOTIATE_OFFER',
        offer: {
          type: completeOffer.type,
          sdp: completeOffer.sdp
        }
      });
    } catch (e) {
      logger.warn('P2P Mesh', `Échec renégociation vers ${peerId}:`, e);
    }
  }

  async handleRenegotiateOffer(peerId, offer) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.connection) return;

    try {
      logger.info('P2P Mesh', `📥 Traitement offre de renégociation média de ${peerId}...`);
      await peer.connection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      const completeAnswer = await this.waitForIceGathering(peer.connection, 1500, 200);

      await this.sendToPeer(peerId, {
        type: 'MEDIA_RENEGOTIATE_ANSWER',
        answer: {
          type: completeAnswer.type,
          sdp: completeAnswer.sdp
        }
      });
    } catch (e) {
      logger.warn('P2P Mesh', `Erreur réponse renégociation ${peerId}:`, e);
    }
  }

  async handleRenegotiateAnswer(peerId, answer) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.connection) return;

    try {
      logger.info('P2P Mesh', `✅ Renégociation média complétée avec ${peerId} !`);
      await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) {
      logger.warn('P2P Mesh', `Erreur finalisation renégociation ${peerId}:`, e);
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
    const MAX_CHUNK_SIZE = CONFIG.LIMITS.MAX_DATACHANNEL_CHUNK || 15000;
    const HIGH_WATERMARK = 64 * 1024; // 64 Ko

    const drainBuffer = async () => {
      if (peer.controlChannel.bufferedAmount <= HIGH_WATERMARK) return;
      return new Promise((resolve) => {
        const handler = () => {
          peer.controlChannel.removeEventListener('bufferedamountlow', handler);
          resolve();
        };
        peer.controlChannel.addEventListener('bufferedamountlow', handler);
        setTimeout(handler, 1000); // Garde-fou
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

  /**
   * Broadcast avec chiffrement unique (Single-Encrypt Multi-Send)
   */
  async broadcast(payload, excludePeerId = null) {
    if (this.peers.size === 0) return 0;

    const encrypted = await this.vault.encrypt(payload, false);
    const jsonStr = JSON.stringify(encrypted);
    const MAX_CHUNK_SIZE = CONFIG.LIMITS.MAX_DATACHANNEL_CHUNK || 15000;

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

  /**
   * Envoi de blocs binaires découpés (16 Ko MTU Safe & En-tête Compact 41 octets)
   */
  async sendBinaryChunkSliced(peerId, hashHex, arrayBuffer) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') return false;

    const dc = peer.dataChannel;
    const HEADER_SIZE = 41;
    const TOTAL_PACKET_SIZE = 16384; // 16 Ko pile
    const SLICE_PAYLOAD_SIZE = TOTAL_PACKET_SIZE - HEADER_SIZE; // 16343 octets
    const totalSlices = Math.ceil(arrayBuffer.byteLength / SLICE_PAYLOAD_SIZE);
    const rawHashBytes = new Uint8Array(CryptoVault.hexToBuffer(hashHex));

    // Seuil de réveil et de suspension adaptatif (64 Ko en appel, 256 Ko au repos)
    const lowThreshold = this.isMediaActive() ? 64 * 1024 : 128 * 1024;
    dc.bufferedAmountLowThreshold = lowThreshold;

    for (let sliceIdx = 0; sliceIdx < totalSlices; sliceIdx++) {
      if (dc.readyState !== 'open') return false;

      // Attente événementielle pure sans boucle setTimeout
      if (dc.bufferedAmount > lowThreshold) {
        await new Promise((resolve) => {
          const handler = () => {
            dc.removeEventListener('bufferedamountlow', handler);
            resolve();
          };
          dc.addEventListener('bufferedamountlow', handler);
          setTimeout(handler, 2000); // Garde-fou
        });
      }

      const start = sliceIdx * SLICE_PAYLOAD_SIZE;
      const end = Math.min(start + SLICE_PAYLOAD_SIZE, arrayBuffer.byteLength);
      const sliceLength = end - start;

      const packet = new Uint8Array(HEADER_SIZE + sliceLength);
      packet[0] = 0xFD; // Magic byte bloc Drive
      packet.set(rawHashBytes, 1);

      const view = new DataView(packet.buffer);
      view.setUint16(33, sliceIdx, false);
      view.setUint16(35, totalSlices, false);
      view.setUint32(37, arrayBuffer.byteLength, false);

      // Zéro-Copie : vue directe sur le buffer source
      packet.set(new Uint8Array(arrayBuffer, start, sliceLength), HEADER_SIZE);

      try {
        dc.send(packet.buffer);
      } catch (err) {
        logger.error('P2P Mesh', `Erreur send() binaire vers ${peerId}:`, err);
        return false;
      }
    }
    return true;
  }

  // --- Gestion des Pistes Média (Audio/Vidéo), Codecs & QoS (Personas 5.4, 5.5, 5.9) ---

  _configureTransceiverCodecs(transceiver, kind) {
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;

    if (kind === 'audio') {
      const caps = RTCRtpSender.getCapabilities ? RTCRtpSender.getCapabilities('audio') : null;
      if (!caps || !caps.codecs) return;
      const opus = caps.codecs.find(c => c.mimeType.toLowerCase() === 'audio/opus');
      if (opus) {
        const fmtp = CONFIG.MEDIA?.AUDIO?.OPUS_FMTP || 'minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxplaybackrate=48000;maxaveragebitrate=32000;cbr=0';
        const enhancedOpus = { ...opus, sdpFmtpLine: fmtp };
        const others = caps.codecs.filter(c => c !== opus);
        try {
          transceiver.setCodecPreferences([enhancedOpus, ...others]);
        } catch (e) {
          logger.debug('P2P Mesh', 'Avertissement setCodecPreferences audio:', e);
        }
      }
    } else if (kind === 'video') {
      const caps = RTCRtpSender.getCapabilities ? RTCRtpSender.getCapabilities('video') : null;
      if (!caps || !caps.codecs) return;
      const preferredOrder = CONFIG.MEDIA?.VIDEO?.PREFERRED_CODECS || ['video/VP9', 'video/H264', 'video/VP8', 'video/AV1'];
      const sortedCodecs = caps.codecs.slice().sort((a, b) => {
        const idxA = preferredOrder.findIndex(m => a.mimeType.toLowerCase() === m.toLowerCase());
        const idxB = preferredOrder.findIndex(m => b.mimeType.toLowerCase() === m.toLowerCase());
        return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
      });
      try {
        transceiver.setCodecPreferences(sortedCodecs);
      } catch (e) {
        logger.debug('P2P Mesh', 'Avertissement setCodecPreferences vidéo:', e);
      }
    }
  }

  async attachLocalMediaStream(stream) {
    logger.info('P2P Mesh', '🎙️ Injection du MediaStream local avec codecs optimisés et QoS dans les connexions Mesh...');
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

  async replaceVideoTrack(track, hint = 'motion') {
    if (track) {
      track.contentHint = hint;
    }
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

  async _applySenderQoS(sender, kind, isScreenShare = false) {
    if (!sender || !sender.getParameters) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      if (kind === 'audio') {
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].maxBitrate = CONFIG.MEDIA?.AUDIO?.MAX_BITRATE || 32000;
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
      logger.debug('P2P Mesh', 'Avertissement configuration QoS sender:', err.message);
    }
  }

  async applyVideoBitrate(peerId, effectiveRttMs, isScreenShare = false) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.connection) return;

    const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender || !sender.getParameters) return;

    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];

      if (isScreenShare) {
        const screenCfg = CONFIG.VIDEO_BITRATE?.SCREEN_SHARE || {};
        params.encodings[0].maxBitrate = screenCfg.maxBitrate || 1800000;
        params.encodings[0].scaleResolutionDownBy = 1.0;
        params.encodings[0].maxFramerate = screenCfg.maxFramerate || 15;
        params.degradationPreference = 'maintain-resolution';
      } else {
        // Quota d'upload partagé par pair (Mesh Uplink Budgeting)
        const activeVideoPeers = Array.from(this.peers.values()).filter(p =>
          p.connection && p.connection.getSenders().some(s => s.track && s.track.kind === 'video')
        ).length || 1;

        const totalUplinkCap = CONFIG.VIDEO_BITRATE?.TOTAL_UPLINK_CAP_BPS || 3500000;
        const perPeerCap = Math.floor(totalUplinkCap / activeVideoPeers);

        let step = CONFIG.VIDEO_BITRATE.LADDER[CONFIG.VIDEO_BITRATE.LADDER.length - 1];
        for (const candidate of CONFIG.VIDEO_BITRATE.LADDER) {
          if (effectiveRttMs <= candidate.maxRtt) {
            step = candidate;
            break;
          }
        }

        const targetBitrate = Math.min(step.maxBitrate, perPeerCap);
        params.encodings[0].maxBitrate = targetBitrate;
        params.encodings[0].scaleResolutionDownBy = step.scaleResolutionDownBy || 1.0;
        params.encodings[0].maxFramerate = step.maxFramerate || 30;
        params.degradationPreference = 'maintain-framerate';
      }

      await sender.setParameters(params);
    } catch (e) {
      logger.debug('P2P Mesh', 'Avertissement setParameters adaptatif:', e.message);
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

  resyncPeerJitterBuffers(pc, offsetMs) {
    if (!pc || typeof pc.getReceivers !== 'function') return;
    const baseTarget = CONFIG.MEDIA?.DEFAULT_JITTER_TARGET_MS || 50;
    // Si dérive A/V, applique temporairement un léger ajustement
    const adjustedTarget = Math.max(30, Math.min(180, baseTarget + Math.abs(offsetMs)));
    this.applyReceiverJitterTarget(pc, adjustedTarget);
    setTimeout(() => {
      this.applyReceiverJitterTarget(pc, baseTarget);
    }, 4000);
  }

  removeLocalMediaStream() {
    if (this.localMediaStream) {
      logger.info('P2P Mesh', '⏹️ Arrêt du MediaStream local');
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

  // --- Gestion du Cycle de Vie Réseau Système (Online/Offline) ---

  handleNetworkOnline() {
    logger.info('P2P Mesh', '🌐 Rétablissement de la connexion réseau : réactivation proactive...');
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
    logger.warn('P2P Mesh', '🔌 Perte de connectivité Internet détectée.');
  }
}
