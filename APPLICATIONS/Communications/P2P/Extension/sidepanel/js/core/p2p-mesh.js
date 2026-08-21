import { logger } from './logger.js';
/**
 * Moteur Réseau P2P Mesh & Coordinateur de Swarm Décentralisé
 * Signalement multi-canaux, négociation WebRTC audio/vidéo avec transceivers et renégociation in-band ultra-rapide.
 */

import { CONFIG } from './config.js';
import { BoundedSet, TTLMap } from './bounded-cache.js';

export class P2PMeshNetwork {
  constructor(cryptoVault) {
    this.vault = cryptoVault;
    this.peers = new Map(); // peerId -> { id, name, connection, controlChannel, dataChannel, connectedAt, lastSeen, latencyMs, incomingFragments: Map }
    this.trackers = new Map(); // trackerUrl -> WebSocket
    this.nostrRelays = new Map(); // relayUrl -> WebSocket
    this.eventListeners = new Map();

    // Offres SDP en attente de réponse : bornées + TTL (les offres jamais
    // répondues sont automatiquement fermées et purgées, cf. audit §fuites mémoire).
    this.activeOffers = new TTLMap({
      maxSize: 256,
      ttlMs: CONFIG.TIMINGS.OFFER_TTL || 45000,
      onEvict: (offerId, entry) => {
        try { entry?.pc?.close(); } catch (e) { logger.debug('P2P Mesh', 'Erreur fermeture RTCPeerConnection:', e); }
      }
    });
    // Anti-doublon / anti-rejeu des offres traitées : ensemble borné (FIFO).
    this.processedOfferIds = new BoundedSet(4000);

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

  /**
   * Démarre la connexion au réseau P2P pour le Topic dérivé du code papier
   */
  async start() {
    if (!this.vault.isInitialized) {
      throw new Error('Le coffre cryptographique doit être initialisé');
    }

    logger.info('P2P Mesh', `🚀 Démarrage du réseau Mesh pour Topic: ${this.vault.topicHex.substring(0, 10)}... (Pair local: ${this.vault.peerIdHex.substring(0, 12)}...)`);
    this.emit('status-change', { status: 'connecting', message: 'Connexion aux relais de découverte...' });

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

    // Boucle d'annonce périodique toutes les 15 secondes
    this.announceInterval = setInterval(() => {
      logger.debug('P2P Mesh', '🔄 Déclenchement de l\'annonce périodique sur les trackers...');
      this.announceAllTrackers();
    }, 15000);

    // Boucle de maintenance : purge des offres SDP expirées (anti-fuite mémoire).
    this.maintenanceInterval = setInterval(() => {
      this.activeOffers.sweep();
    }, 10000);

    return this;
  }

  /**
   * Arrête toutes les connexions
   */
  stop() {
    logger.info('P2P Mesh', '🛑 Arrêt du maillage P2P et libération des ressources...');
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }

    this.trackers.forEach((ws) => {
      try { ws.close(); } catch (e) { logger.debug('P2P Mesh', 'Erreur fermeture WebSocket:', e); }
    });
    this.trackers.clear();

    this.nostrRelays.forEach((ws) => {
      try { ws.close(); } catch (e) { logger.debug('P2P Mesh', 'Erreur fermeture WebSocket:', e); }
    });
    this.nostrRelays.clear();

    this.peers.forEach((peer) => {
      try { peer.connection.close(); } catch (e) { logger.debug('P2P Mesh', 'Erreur fermeture connexion pair:', e); }
    });
    this.peers.clear();

    this.emit('status-change', { status: 'disconnected', message: 'Déconnecté du réseau P2P' });
  }

  // --- Rassemblement ICE WebRTC ---

  async waitForIceGathering(pc, timeoutMs = 2500) {
    if (pc.iceGatheringState === 'complete') {
      return pc.localDescription;
    }
    return new Promise((resolve) => {
      let timer = null;
      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          if (timer) clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', checkState);
          resolve(pc.localDescription);
        }
      };
      pc.addEventListener('icegatheringstatechange', checkState);
      timer = setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve(pc.localDescription);
      }, timeoutMs);
    });
  }

  // --- Signalement via Trackers WebTorrent WSS ---

  connectToTracker(trackerUrl) {
    try {
      const ws = new WebSocket(trackerUrl);
      this.trackers.set(trackerUrl, ws);

      ws.onopen = () => {
        logger.info('P2P Mesh', `✅ Connecté au tracker: ${trackerUrl}`);
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

      ws.onerror = () => {
        logger.warn('P2P Mesh', `Erreur sur le tracker ${trackerUrl}`);
      };

      ws.onclose = () => {
        logger.info('P2P Mesh', `🔌 Connexion fermée avec tracker ${trackerUrl}`);
        this.trackers.delete(trackerUrl);
        setTimeout(() => {
          if (this.announceInterval) {
            logger.info('P2P Mesh', `🔄 Reconnexion au tracker: ${trackerUrl}`);
            this.connectToTracker(trackerUrl);
          }
        }, CONFIG.TIMINGS.RECONNECT_DELAY);
      };
    } catch (e) {
      logger.warn('P2P Mesh', `❌ Impossible de joindre le tracker ${trackerUrl}:`, e);
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
   * Envoie une annonce au tracker avec offres WebRTC
   */
  async announceToTracker(ws, trackerUrl, eventType = 'update') {
    if (ws.readyState !== WebSocket.OPEN) return;

    logger.info('P2P Mesh', `📡 Préparation de l'annonce sur ${trackerUrl}...`);

    const offers = [];
    const NUM_OFFERS = 2;

    for (let i = 0; i < NUM_OFFERS; i++) {
      const offerId = `off_${Math.random().toString(36).substr(2, 9)}`;
      const pc = this.createPeerConnection(null);

      const controlChannel = pc.createDataChannel('p2p-control', { ordered: true });
      const dataChannel = pc.createDataChannel('p2p-data', { ordered: false });

      const rawOffer = await pc.createOffer();
      await pc.setLocalDescription(rawOffer);

      // Attend que les candidats ICE soient insérés dans la description locale
      const completeOffer = await this.waitForIceGathering(pc);

      // Chiffre la description SDP réelle avec la clé de signalement E2EE
      const encryptedOffer = await this.vault.encrypt({
        type: completeOffer.type,
        sdp: completeOffer.sdp
      }, true);

      this.activeOffers.set(offerId, {
        pc,
        controlChannel,
        dataChannel,
        createdAt: Date.now()
      });

      offers.push({
        offer_id: offerId,
        offer: {
          type: 'offer',
          sdp: JSON.stringify(encryptedOffer)
        }
      });
    }

    const infoHashHex = this.vault.topicHex.substring(0, 40);
    const peerIdHex = this.vault.peerIdHex.substring(0, 40);

    const announceMsg = {
      action: 'announce',
      info_hash: infoHashHex,
      peer_id: peerIdHex,
      numwant: 10,
      offers: offers
    };

    logger.info('P2P Mesh', `📤 Envoi announce (${offers.length} offres chiffrées avec ICE complets) vers ${trackerUrl}`);
    ws.send(JSON.stringify(announceMsg));
  }

  /**
   * Traite les messages entrants des trackers
   */
  async handleTrackerMessage(data, ws) {
    if (data.action === 'announce') {
      const senderPeerIdHex = data.peer_id ? String(data.peer_id) : '';

      if (senderPeerIdHex === this.vault.peerIdHex) {
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
              logger.debug('P2P Mesh', 'SDP offer non JSON, format chaîne brute conservé');
              cipherPayload = data.offer.sdp;
            }
          }

          const decryptedOffer = await this.vault.decrypt(cipherPayload, true);
          if (!decryptedOffer || !decryptedOffer.sdp) {
            throw new Error('SDP manquant dans l\'offre déchiffrée');
          }

          logger.info('P2P Mesh', '🔓 Offre SDP déchiffrée avec succès ! Création de la réponse WebRTC...');
          const pc = this.createPeerConnection(remotePeerId);

          await pc.setRemoteDescription(new RTCSessionDescription({
            type: decryptedOffer.type || 'offer',
            sdp: decryptedOffer.sdp
          }));

          const rawAnswer = await pc.createAnswer();
          await pc.setLocalDescription(rawAnswer);

          const completeAnswer = await this.waitForIceGathering(pc);
          const encryptedAnswer = await this.vault.encrypt({
            type: completeAnswer.type,
            sdp: completeAnswer.sdp
          }, true);

          const answerMsg = {
            action: 'announce',
            info_hash: this.vault.topicHex.substring(0, 40),
            peer_id: this.vault.peerIdHex.substring(0, 40),
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
                logger.debug('P2P Mesh', 'SDP answer non JSON, format chaîne brute conservé');
                cipherAnswerPayload = data.answer.sdp;
              }
            }

            const decryptedAnswer = await this.vault.decrypt(cipherAnswerPayload, true);
            logger.info('P2P Mesh', `🔓 Réponse SDP déchiffrée ! Application de la description distante...`);
            // Lie désormais la connexion au pair identifié (corrige track-received=null).
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

  // --- Signalement Complémentaire via Relais Nostr (NIP-01) ---

  connectToNostrRelay(relayUrl) {
    try {
      const ws = new WebSocket(relayUrl);
      this.nostrRelays.set(relayUrl, ws);

      ws.onopen = () => {
        logger.info('P2P Mesh', `⚡ Connecté au relais Nostr: ${relayUrl}`);
        const subId = `sub_${Math.random().toString(36).substr(2, 6)}`;
        const req = ['REQ', subId, {
          kinds: [29000],
          '#t': [this.vault.topicHex]
        }];
        ws.send(JSON.stringify(req));
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg[0] !== 'EVENT' || !msg[2]) return;
          const nostrEvent = msg[2];

          // Validation structurelle NIP-01 minimale.
          if (!nostrEvent || typeof nostrEvent.content !== 'string' ||
              !nostrEvent.id || !nostrEvent.sig || !nostrEvent.pubkey) return;

          // Anti-rejeu / anti-doublon par id d'événement Nostr (borné).
          if (!this.processedOfferIds.addIfNew(`nostr_${nostrEvent.id}`)) return;

          // Ignore nos propres annonces (émises par CE pair). On ne peut pas se
          // fier au champ pubkey (espace de clés Nostr distinct de notre clé ECDSA) :
          // on marque donc nos propres envois via un champ `_src` dans le contenu.
          let payload;
          try { payload = JSON.parse(nostrEvent.content); } catch (e) { logger.debug('P2P Mesh', 'Contenu Nostr non JSON, ignoré:', e); return; }
          if (!payload || payload.action !== 'announce') return;
          if (payload.peer_id && payload.peer_id === this.vault.peerIdHex.substring(0, 40)) return;

          // NOTE SÉCURITÉ : la signature Schnorr secp256k1 des événements Nostr
          // n'est pas vérifiée ici (nécessiterait une lib dédiée). La confiance ne
          // repose donc PAS sur Nostr : toute offre/réponse acheminée est de toute
          // façon chiffrée E2EE avec la clé de signalement du groupe et échoue au
          // déchiffrement si elle est forgée. Nostr n'est qu'un canal de rendez-vous.
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

  // --- Gestion des Connexions WebRTC & Transceivers ---

  createPeerConnection(remotePeerId) {
    const pc = new RTCPeerConnection({
      iceServers: CONFIG.ICE_SERVERS,
      iceCandidatePoolSize: 2
    });

    // CORRECTIF (audit §pistes média peerId=null) : côté offreur, l'identifiant
    // du pair n'est connu qu'à la réception de sa réponse SDP. On stocke donc
    // l'identité sur la connexion elle-même et les gestionnaires la LISENT
    // dynamiquement (pc._remotePeerId), au lieu de capturer `null` dans la closure.
    pc._remotePeerId = remotePeerId || null;

    // IMPORTANT : on N'AJOUTE PLUS de transceivers média à la connexion.
    // Auparavant deux transceivers `sendrecv` (audio+vidéo) étaient créés d'emblée,
    // ce qui négociait des pistes média DÈS la connexion — donc avant même de
    // rejoindre un salon (tuiles fantômes, impression de diffusion). Désormais les
    // pistes ne sont ajoutées QUE lorsqu'on rejoint réellement le salon vocal
    // (attachLocalMediaStream → addTrack + renégociation in-band).

    let controlChannel = null;
    let dataChannel = null;

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      const pid = pc._remotePeerId;
      logger.info('P2P Mesh', `📦 Canal de données reçu du pair distant [${pid || 'nouveau'}]: "${channel.label}"`);
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
      this.emit('track-received', {
        peerId: pid,
        track: event.track,
        streams: event.streams
      });
    };

    pc.oniceconnectionstatechange = () => {
      const pid = pc._remotePeerId;
      logger.info('P2P Mesh', `🌐 État ICE [${pid || 'nouveau'}] : ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        logger.info('P2P Mesh', `🌟 Connexion directe WebRTC P2P ÉTABLIE avec ${pid || 'pair distant'} !`);
      } else if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        if (pc._remotePeerId) this.removePeer(pc._remotePeerId);
      }
    };

    return pc;
  }

  setupControlChannel(channel, peerId) {
    const incomingFragments = new Map();

    channel.onopen = () => this._handleControlChannelOpen(peerId);

    channel.onmessage = async (event) => {
      try {
        let fullPayloadStr = event.data;
        const parsed = JSON.parse(event.data);

        // Réassemblage transparent des messages fragmentés
        if (parsed && parsed._isFrag) {
          const { _fragId, _part, _total, _data } = parsed;

          // CORRECTIF (audit §DoS fragmentation) : borne stricte de _total, _part
          // et de la taille cumulée AVANT toute allocation, pour empêcher un pair
          // malveillant de provoquer `new Array(2**31)` ou d'épuiser la mémoire.
          const MAX_PARTS = CONFIG.LIMITS.MAX_FRAGMENT_PARTS;
          const MAX_ASSEMBLED = CONFIG.LIMITS.MAX_ASSEMBLED_CONTROL_BYTES;
          if (typeof _fragId !== 'string' ||
              !Number.isInteger(_total) || _total < 1 || _total > MAX_PARTS ||
              !Number.isInteger(_part) || _part < 0 || _part >= _total ||
              typeof _data !== 'string') {
            logger.warn('P2P Mesh', `Fragment invalide rejeté de ${peerId} (part=${_part}, total=${_total})`);
            return;
          }

          let item = incomingFragments.get(_fragId);
          if (!item) {
            // Purge des réassemblages partiels abandonnés (anti-fuite mémoire).
            const now = Date.now();
            for (const [fid, it] of incomingFragments) {
              if (now - it.createdAt > 30000) incomingFragments.delete(fid);
            }
            // Map<index,chunk> plutôt qu'un tableau pré-alloué de taille _total.
            item = { parts: new Map(), total: _total, bytes: 0, createdAt: now };
            incomingFragments.set(_fragId, item);
          }
          if (item.total !== _total) return; // incohérence entre fragments
          if (!item.parts.has(_part)) {
            item.parts.set(_part, _data);
            item.bytes += _data.length;
            if (item.bytes > MAX_ASSEMBLED) {
              logger.warn('P2P Mesh', `Message fragmenté trop volumineux de ${peerId} — abandon`);
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

        // Traitement de la renégociation SDP in-band (Audio/Vidéo instantanée)
        if (message.type === 'MEDIA_RENEGOTIATE_OFFER') {
          await this.handleRenegotiateOffer(peerId, message.offer);
          return;
        } else if (message.type === 'MEDIA_RENEGOTIATE_ANSWER') {
          await this.handleRenegotiateAnswer(peerId, message.answer);
          return;
        }

        this.emit('message-received', { peerId, message });
      } catch (e) {
        logger.warn('P2P Mesh', `Message de contrôle indéchiffrable de ${peerId}:`, e.message);
      }
    };
  }

  /**
   * Traite l'ouverture EFFECTIVE du canal de contrôle d'un pair.
   *
   * CORRECTIF (bug « les nouveaux membres ne voient pas l'historique ») :
   * l'événement `peer-joined` était émis dès l'enregistrement du pair, alors que
   * le DataChannel de contrôle était encore en état `connecting`. La requête de
   * synchronisation CRDT partait donc trop tôt et `sendToPeer` la rejetait en
   * silence (canal non ouvert). On déclenche désormais la synchro via l'événement
   * `peer-ready`, émis uniquement quand le canal est réellement ouvert.
   */
  _handleControlChannelOpen(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;                 // pair déjà retiré / pas encore enregistré
    if (peer._controlReady) return;    // anti double-déclenchement (onopen + fallback)
    peer._controlReady = true;

    logger.info('P2P Mesh', `🟢 Canal 'p2p-control' OUVERT avec ${peerId}`);

    this.sendToPeer(peerId, {
      type: 'PEER_HELLO',
      name: this.vault.userName,
      pubkey: this.vault.publicKeyHex
    });

    // Si un flux média local existe déjà, l'attache immédiatement.
    if (this.localMediaStream) {
      this.attachLocalMediaStream(this.localMediaStream);
    }

    // Le canal est prêt : on peut demander/échanger l'historique en toute fiabilité.
    this.emit('peer-ready', peer);
  }

  setupDataChannel(channel, peerId) {
    channel.binaryType = 'arraybuffer';
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

    // Cas de course : si le canal de contrôle était DÉJÀ ouvert au moment de
    // l'enregistrement (onopen assigné trop tard), on déclenche la synchro
    // immédiatement plutôt que d'attendre un événement onopen qui ne viendra pas.
    if (controlChannel.readyState === 'open') {
      this._handleControlChannelOpen(peerId);
    }
  }

  removePeer(peerId) {
    if (!peerId) return;
    const peer = this.peers.get(peerId);
    if (peer) {
      try { peer.connection.close(); } catch (e) { logger.debug('P2P Mesh', 'Erreur fermeture connexion pair:', e); }
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

  // --- Renégociation WebRTC In-Band (Audio/Vidéo) ---

  async renegotiatePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.connection || !peer.controlChannel || peer.controlChannel.readyState !== 'open') return;

    try {
      logger.info('P2P Mesh', `🔄 Renégociation WebRTC in-band vers ${peerId}...`);
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      const completeOffer = await this.waitForIceGathering(peer.connection, 1500);

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
      const completeAnswer = await this.waitForIceGathering(peer.connection, 1500);

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
      logger.info('P2P Mesh', `✅ Renégociation média complétée avec succès avec ${peerId} !`);
      await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) {
      logger.warn('P2P Mesh', `Erreur finalisation renégociation ${peerId}:`, e);
    }
  }

  // --- Envoi de Données, Fragmentation & Diffusion ---

  async sendToPeer(peerId, payload) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.controlChannel || peer.controlChannel.readyState !== 'open') {
      return false;
    }

    const encrypted = await this.vault.encrypt(payload, false);
    const jsonStr = JSON.stringify(encrypted);

    // CORRECTIF (audit §max-message-size, confirmé par error.txt) : la limite
    // sûre inter-navigateurs d'un RTCDataChannel est ~16 Ko. L'ancienne valeur
    // (28672) provoquait « Failed to execute 'send'... larger than max-message-size »
    // et cassait silencieusement la synchro des commits Drive. On fragmente donc
    // en tranches nettement sous 16 Ko (l'enveloppe JSON de fragment ajoute ~120 o).
    const MAX_CHUNK_SIZE = CONFIG.LIMITS.MAX_DATACHANNEL_CHUNK;

    if (jsonStr.length <= MAX_CHUNK_SIZE) {
      peer.controlChannel.send(jsonStr);
    } else {
      const fragId = `frag_${Math.random().toString(36).substr(2, 8)}`;
      const totalParts = Math.ceil(jsonStr.length / MAX_CHUNK_SIZE);

      for (let i = 0; i < totalParts; i++) {
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
    let sentCount = 0;
    for (const [peerId] of this.peers) {
      if (excludePeerId && peerId === excludePeerId) continue; // relais gossip : on n'échoie pas vers la source
      const ok = await this.sendToPeer(peerId, payload);
      if (ok) sentCount++;
    }
    return sentCount;
  }

  async sendBinaryChunkSliced(peerId, hash, arrayBuffer) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') return false;

    const SLICE_SIZE = 16384;
    const totalSlices = Math.ceil(arrayBuffer.byteLength / SLICE_SIZE);
    const hashBytes = new TextEncoder().encode(hash.padEnd(64, '0').substring(0, 64));

    const headerSize = 1 + 64 + 2 + 2 + 4;

    for (let sliceIdx = 0; sliceIdx < totalSlices; sliceIdx++) {
      const start = sliceIdx * SLICE_SIZE;
      const end = Math.min(start + SLICE_SIZE, arrayBuffer.byteLength);
      const sliceRaw = arrayBuffer.slice(start, end);

      const packet = new Uint8Array(headerSize + sliceRaw.byteLength);
      packet[0] = 0xFD;
      packet.set(hashBytes, 1);
      
      const view = new DataView(packet.buffer);
      view.setUint16(65, sliceIdx, false);
      view.setUint16(67, totalSlices, false);
      view.setUint32(69, arrayBuffer.byteLength, false);
      packet.set(new Uint8Array(sliceRaw), headerSize);

      while (peer.dataChannel.bufferedAmount > 512 * 1024) {
        await new Promise(r => setTimeout(r, 15));
      }

      peer.dataChannel.send(packet.buffer);
    }
    return true;
  }

  // --- Gestion des Pistes Média (Audio/Vidéo) ---

  async attachLocalMediaStream(stream) {
    logger.info('P2P Mesh', '🎙️ Injection du MediaStream local dans toutes les connexions Mesh...');
    this.localMediaStream = stream;

    for (const [peerId, peer] of this.peers) {
      if (peer.connection) {
        stream.getTracks().forEach(track => {
          // Utilise replaceTrack sur le transceiver correspondant si disponible
          const transceivers = peer.connection.getTransceivers();
          const target = transceivers.find(t => t.receiver && t.receiver.track && t.receiver.track.kind === track.kind);
          if (target && target.sender) {
            target.sender.replaceTrack(track);
          } else {
            const senders = peer.connection.getSenders();
            const exists = senders.some(s => s.track && s.track.id === track.id);
            if (!exists) {
              peer.connection.addTrack(track, stream);
            }
          }
        });

        // Déclenche la renégociation in-band
        await this.renegotiatePeer(peerId);
      }
    }
  }

  /**
   * Adapte dynamiquement le débit vidéo sortant vers un pair selon la latence RTT
   * mesurée (cf. CONFIG.VIDEO_BITRATE.LADDER). Applique maxBitrate via
   * RTCRtpSender.setParameters — sans renégociation SDP (ajustement instantané).
   */
  async applyVideoBitrate(peerId, rttMs) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.connection) return;

    // Choisit le palier de bitrate correspondant au RTT.
    let target = CONFIG.VIDEO_BITRATE.LADDER[CONFIG.VIDEO_BITRATE.LADDER.length - 1][1];
    for (const [maxRtt, bitrate] of CONFIG.VIDEO_BITRATE.LADDER) {
      if (rttMs <= maxRtt) { target = bitrate; break; }
    }

    const sender = peer.connection.getSenders()
      .find(s => s.track && s.track.kind === 'video');
    if (!sender || !sender.getParameters) return;

    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      // N'applique que si le palier a changé (évite les setParameters inutiles).
      if (params.encodings[0].maxBitrate !== target) {
        params.encodings[0].maxBitrate = target;
        await sender.setParameters(params);
        logger.info('P2P Mesh', `🎚️ Bitrate vidéo vers ${peerId} ajusté à ${Math.round(target / 1000)} kbps (RTT ${rttMs} ms)`);
      }
    } catch (e) {
      // Certains navigateurs limitent setParameters ; échec silencieux non bloquant.
    }
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
          try { sender.replaceTrack(null); } catch (e) { logger.warn('P2P Mesh', 'Erreur replaceTrack null:', e); }
        });
      }
    });
  }

  /**
   * Coupe UNIQUEMENT la vidéo sortante (caméra/écran) chez tous les pairs, sans
   * toucher à l'audio. Utilisé quand on désactive la caméra : on retire la piste
   * du sender et on renégocie, pour réellement libérer la webcam (voyant éteint)
   * plutôt que d'envoyer des images noires.
   */
  async detachVideoTracks() {
    for (const [peerId, peer] of this.peers) {
      if (!peer.connection) continue;
      let changed = false;
      peer.connection.getSenders().forEach(sender => {
        if (sender.track && sender.track.kind === 'video') {
          try { sender.replaceTrack(null); changed = true; } catch (e) { logger.warn('P2P Mesh', `Erreur replaceTrack sur pair ${peerId}:`, e); }
        }
      });
      if (changed) { try { await this.renegotiatePeer(peerId); } catch (e) { logger.warn('P2P Mesh', `Erreur renégociation pair ${peerId}:`, e); } }
    }
  }
}
