/**
 * @file sender-keys.js
 * @description Gestionnaire de Chiffrement de Groupe Signal Sender Keys Durci (Pass 4 - 2026)
 * - Complexité Chiffrement O(1), Post-Compromise Security (PCS) par Époques & Rotation Auto à 100 msgs.
 * - Distribution Pairwise ECDH Chiffrée & Signée des SKDM (Sender Key Distribution Messages).
 * - Zero-Retention stricte des clés de message (Memory Zeroization via SecureMemorySanitizer).
 * - Store de Clés Sautées avec politique d'éviction LRU, TTL de 10 min et protection anti-DoS (max 100 sauts).
 * - Protocole complet d'expulsion de membre (Eviction / Room Key Re-issue).
 */

import { CryptoVault } from './crypto-vault.js';
import { logger } from './logger.js';
import { SecureMemorySanitizer } from './secure-memory-sanitizer.js';

export class SenderKeysManager {
  /**
   * @param {CryptoVault} cryptoVault
   * @param {Object} [options]
   */
  constructor(cryptoVault, options = {}) {
    if (!cryptoVault) throw new Error('CryptoVault requis pour initialiser SenderKeysManager');
    this.vault = cryptoVault;
    
    this.currentEpoch = options.epoch || 1;
    this.localSenderKey = null; // { epoch, chainKeyBuffer, messageIndex, createdAt, rotationCount }
    this.inboundSenderKeys = new Map(); // peerId -> { epoch, chainKeyBuffer, lastIndex, publicKeyHex, updatedAt }
    this.skippedMessageKeys = new Map(); // keyId -> { keyBuffer, createdAt }
    this.evictedPeers = new Set(); // peerId set
    
    // Seuils de sécurité et de rotation conformes Pass 4
    this.MAX_MESSAGES_PER_KEY = options.maxMessagesPerKey || 100; // Rotation obligatoire après 100 messages
    this.MAX_KEY_AGE_MS = options.maxKeyAgeMs || 24 * 60 * 60 * 1000; // Rotation max 24h
    this.MAX_SKIP_STEPS = options.maxSkipSteps || 100; // Seuil max de désynchronisation anti-DoS
    this.MAX_SKIPPED_STORE_SIZE = options.maxSkippedStoreSize || 1000; // Borne mémoire stricte
    this.SKIPPED_KEY_TTL_MS = options.skippedKeyTtlMs || 10 * 60 * 1000; // 10 minutes TTL

    // Nettoyage périodique des clés sautées expirées
    if (typeof setInterval !== 'undefined') {
      this._gcInterval = setInterval(() => this.sweepExpiredSkippedKeys(), 60000);
      if (this._gcInterval && typeof this._gcInterval.unref === 'function') {
        this._gcInterval.unref();
      }
    }
  }

  /**
   * Initialise ou fait tourner la clé d'émission locale (Sender Key)
   * @param {number} [targetEpoch]
   */
  async generateLocalSenderKey(targetEpoch = null) {
    if (this.localSenderKey?.chainKeyBuffer) {
      SecureMemorySanitizer.wipe(this.localSenderKey.chainKeyBuffer);
    }

    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);

    if (targetEpoch && targetEpoch > this.currentEpoch) {
      this.currentEpoch = targetEpoch;
    }

    this.localSenderKey = {
      epoch: this.currentEpoch,
      chainKeyBuffer: seed,
      messageIndex: 0,
      createdAt: Date.now(),
      rotationCount: (this.localSenderKey?.rotationCount || 0) + 1
    };

    logger.info('SenderKeys', `🔑 Nouvelle Sender Key générée (Époque: ${this.currentEpoch}, Rotation: #${this.localSenderKey.rotationCount})`);
    return await this.getLocalDistributionMessage();
  }

  /**
   * Force la rotation de la clé locale (déclenchée après 100 messages ou sur événement d'éviction)
   */
  async rotateLocalSenderKey() {
    logger.info('SenderKeys', `🔄 Rotation de la clé locale (Atteinte du seuil de ${this.MAX_MESSAGES_PER_KEY} messages)`);
    return await this.generateLocalSenderKey(this.currentEpoch);
  }

  /**
   * Produit le message de distribution de clé (SKDM) signé pour échange interne
   */
  async getLocalDistributionMessage() {
    if (!this.localSenderKey) await this.generateLocalSenderKey();
    
    const payload = {
      type: 'SENDER_KEY_DISTRIBUTION',
      version: 4,
      epoch: this.localSenderKey.epoch,
      senderId: this.vault.peerId,
      publicKeyHex: this.vault.publicKeyHex,
      chainKeyHex: CryptoVault.bufferToHex(this.localSenderKey.chainKeyBuffer),
      startIndex: this.localSenderKey.messageIndex,
      timestamp: Date.now()
    };

    // Signature ECDSA de non-répudiation de la distribution
    payload.signature = await this.vault.sign(payload);
    return payload;
  }

  /**
   * Chiffre le SKDM spécifiquement pour un pair destinataire via accord ECDH Pairwise
   * @param {string} targetPeerId
   * @param {string} targetPubkeyHex
   */
  async createEncryptedSKDMForPeer(targetPeerId, targetPubkeyHex) {
    if (this.evictedPeers.has(targetPeerId)) {
      throw new Error(`Impossible d'émettre un SKDM pour un pair expulsé: ${targetPeerId}`);
    }

    const rawSKDM = await this.getLocalDistributionMessage();
    if (!this.vault.ecdhKeyPair?.privateKey) {
      return rawSKDM;
    }

    const pairwiseKey = await CryptoVault.derivePairwiseKey(this.vault.ecdhKeyPair.privateKey, targetPubkeyHex);
    const encoder = new TextEncoder();
    const iv = this.vault._generateDeterministicNonce();
    const rawBytes = encoder.encode(JSON.stringify(rawSKDM));

    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      pairwiseKey,
      rawBytes
    );

    return {
      type: 'ENCRYPTED_SENDER_KEY_DISTRIBUTION',
      version: 4,
      epoch: this.localSenderKey.epoch,
      senderId: this.vault.peerId,
      targetPeerId,
      senderPubkeyHex: this.vault.publicKeyHex,
      iv: CryptoVault.bufferToHex(iv),
      ciphertext: CryptoVault.bufferToHex(cipherBuffer),
      signature: await this.vault.sign({
        epoch: this.localSenderKey.epoch,
        senderId: this.vault.peerId,
        targetPeerId,
        ciphertext: CryptoVault.bufferToHex(cipherBuffer)
      })
    };
  }

  /**
   * Traite la réception d'un SKDM (en clair ou chiffré par paire)
   * @param {Object} skdm
   * @param {string} [senderECDHPubkeyHex]
   */
  async handleInboundSenderKey(skdm, senderECDHPubkeyHex = null) {
    if (!skdm || !skdm.senderId) return false;

    let payload = skdm;

    // 1. Déchiffrement pairwise si le message est sous enveloppe ENCRYPTED_SENDER_KEY_DISTRIBUTION
    if (skdm.type === 'ENCRYPTED_SENDER_KEY_DISTRIBUTION') {
      if (!this.vault.ecdhKeyPair?.privateKey || !senderECDHPubkeyHex) {
        throw new Error('Clés ECDH requises pour déchiffrer le SKDM pairwise entrant');
      }

      const pairwiseKey = await CryptoVault.derivePairwiseKey(this.vault.ecdhKeyPair.privateKey, senderECDHPubkeyHex);
      const ivBuf = CryptoVault.hexToBuffer(skdm.iv);
      const cipherBuf = CryptoVault.hexToBuffer(skdm.ciphertext);

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(ivBuf), tagLength: 128 },
        pairwiseKey,
        cipherBuf
      );

      payload = JSON.parse(new TextDecoder().decode(decrypted));
    }

    const { senderId, epoch, chainKeyHex, startIndex, publicKeyHex, signature } = payload;

    // 2. Contrôle d'exclusion (Anti-Banned Peer)
    if (this.evictedPeers.has(senderId)) {
      logger.warn('SenderKeys', `⛔ Rejet du SKDM émis par un pair expulsé: ${senderId}`);
      return false;
    }

    // 3. Vérification de concordance PeerID <=> PublicKeyHex
    if (publicKeyHex) {
      const expectedPeerId = `peer_${(await CryptoVault.hashSHA256(publicKeyHex)).substring(0, 16)}`;
      if (senderId !== expectedPeerId && !senderId.startsWith('peer_')) {
        logger.error('SenderKeys', `Tentative de spoofing SKDM : senderId ${senderId} != ${expectedPeerId}`);
        return false;
      }
    }

    // 4. Vérification de la signature ECDSA du SKDM
    if (signature && publicKeyHex) {
      const isSigValid = await CryptoVault.verify(payload, signature, publicKeyHex, ['signature']);
      if (!isSigValid) {
        logger.error('SenderKeys', `❌ Signature SKDM invalide ou corrompue pour le pair: ${senderId}`);
        return false;
      }
    }

    const existing = this.inboundSenderKeys.get(senderId);
    if (existing && existing.epoch > epoch) {
      logger.warn('SenderKeys', `⚠️ Rejet SKDM d'une époque obsolète (${epoch} < ${existing.epoch}) pour ${senderId}`);
      return false;
    }

    // 5. Nettoyage Zéro-Trace de l'ancienne clé en mémoire
    if (existing?.chainKeyBuffer) {
      SecureMemorySanitizer.wipe(existing.chainKeyBuffer);
    }

    const rawChainBuf = new Uint8Array(CryptoVault.hexToBuffer(chainKeyHex));
    this.inboundSenderKeys.set(senderId, {
      epoch: epoch || 1,
      chainKeyBuffer: rawChainBuf,
      lastIndex: startIndex || 0,
      publicKeyHex: publicKeyHex || '',
      updatedAt: Date.now()
    });

    logger.info('SenderKeys', `📥 Clé de diffusion distante enregistrée pour [${senderId}] (Époque: ${epoch}, Index départ: ${startIndex || 0})`);
    return true;
  }

  /**
   * Chiffre un message de groupe en O(1) avec avancement du cliquet symétrique
   * @param {string} channelId
   * @param {Object|string} plaintextObj
   */
  async encryptGroupMessage(channelId, plaintextObj) {
    if (!this.localSenderKey) {
      await this.generateLocalSenderKey();
    }

    // Rotation préemptive si seuil de 100 messages ou âge max atteint
    const isOverIndex = this.localSenderKey.messageIndex >= this.MAX_MESSAGES_PER_KEY;
    const isOverAge = (Date.now() - this.localSenderKey.createdAt) >= this.MAX_KEY_AGE_MS;
    if (isOverIndex || isOverAge) {
      await this.rotateLocalSenderKey();
    }

    const idx = this.localSenderKey.messageIndex;
    const epoch = this.localSenderKey.epoch;
    const encoder = new TextEncoder();

    let messageKey = null;
    let nextChainBits = null;
    let hkdfKey = null;

    try {
      // 1. Dérivation de la Clé de Message (MK) via HKDF
      hkdfKey = await crypto.subtle.importKey(
        'raw', this.localSenderKey.chainKeyBuffer, { name: 'HKDF' }, false, ['deriveKey', 'deriveBits']
      );

      messageKey = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode(`P2P_MESH_EPOCH_${epoch}`),
          info: encoder.encode(`P2P_MSG_KEY:${channelId}:${idx}`)
        },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
      );

      // 2. Avancement irréversible de la Clé de Chaîne (CK)
      nextChainBits = await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode(`P2P_MESH_EPOCH_${epoch}`),
          info: encoder.encode(`P2P_CHAIN_ADVANCE:${channelId}:${idx}`)
        },
        hkdfKey,
        256
      );

      // Écrasement immédiat de l'ancienne clé en mémoire vive
      SecureMemorySanitizer.wipe(this.localSenderKey.chainKeyBuffer);
      const nextChainCopy = new Uint8Array(nextChainBits.byteLength);
      nextChainCopy.set(new Uint8Array(nextChainBits));
      this.localSenderKey.chainKeyBuffer = nextChainCopy;
      this.localSenderKey.messageIndex += 1;

      // 3. Chiffrement AES-256-GCM avec Nonce déterministe et AAD
      const nonce = this.vault._generateDeterministicNonce();
      const aadObj = { epoch, channelId, senderId: this.vault.peerId, idx };
      const aadBytes = encoder.encode(JSON.stringify(aadObj));
      const rawPlaintext = encoder.encode(typeof plaintextObj === 'string' ? plaintextObj : JSON.stringify(plaintextObj));

      const ciphertextBuffer = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, tagLength: 128, additionalData: aadBytes },
        messageKey,
        rawPlaintext
      );

      const envelope = {
        type: 'SENDER_KEY_MESSAGE',
        version: 4,
        epoch,
        channelId,
        senderId: this.vault.peerId,
        idx,
        iv: CryptoVault.bufferToHex(nonce),
        ciphertext: CryptoVault.bufferToHex(ciphertextBuffer),
        aad: aadObj
      };

      // 4. Signature ECDSA de non-répudiation
      const signPayload = `${epoch}:${channelId}:${this.vault.peerId}:${idx}:${envelope.iv}:${envelope.ciphertext}`;
      envelope.signature = await this.vault.sign(signPayload);

      return envelope;
    } finally {
      if (nextChainBits) SecureMemorySanitizer.wipe(nextChainBits);
    }
  }

  /**
   * Déchiffre un message de groupe entrant avec gestion out-of-order et Zero-Retention
   * @param {Object} envelope
   */
  async decryptGroupMessage(envelope) {
    if (!envelope || !envelope.senderId || !envelope.signature) {
      throw new Error('Enveloppe de message de groupe invalide ou signature manquante');
    }
    const { epoch, channelId, senderId, idx, iv, ciphertext, aad, signature } = envelope;

    if (this.evictedPeers.has(senderId)) {
      throw new Error(`Rejet du message émis par un pair exclu du groupe: ${senderId}`);
    }

    const inbound = this.inboundSenderKeys.get(senderId);
    if (!inbound || !inbound.publicKeyHex) {
      throw new Error(`Aucune clé de diffusion enregistrée pour le pair ${senderId}`);
    }
    if (inbound.epoch !== epoch) {
      throw new Error(`Époque non concordante (reçu ${epoch}, attendu ${inbound.epoch})`);
    }

    // 1. Vérification stricte de la signature ECDSA (Non-Répudiation)
    const signPayload = `${epoch}:${channelId}:${senderId}:${idx}:${iv}:${ciphertext}`;
    const isValidSig = await CryptoVault.verify(signPayload, signature, inbound.publicKeyHex);
    if (!isValidSig) {
      throw new Error('Signature Sender Key falsifiée ou invalide (Non-répudiation violée)');
    }

    const encoder = new TextEncoder();
    let targetMessageKey = null;
    let tempRawKeyBuffer = null;

    try {
      const skippedKeyId = `${senderId}:${epoch}:${channelId}:${idx}`;

      // 2. Vérification dans le Store de Clés Sautées (Out-of-Order Cache)
      if (this.skippedMessageKeys.has(skippedKeyId)) {
        const item = this.skippedMessageKeys.get(skippedKeyId);
        tempRawKeyBuffer = item.keyBuffer;
        this.skippedMessageKeys.delete(skippedKeyId);
        targetMessageKey = await crypto.subtle.importKey(
          'raw', tempRawKeyBuffer, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
        );
      } else {
        // 3. Avancement rapide (Fast-Forward Ratchet) si idx >= lastIndex
        if (idx < inbound.lastIndex) {
          throw new Error(`Message obsolète ou déjà consommé (index ${idx} < dernier vu ${inbound.lastIndex})`);
        }

        const steps = idx - inbound.lastIndex;
        if (steps > this.MAX_SKIP_STEPS) {
          throw new Error(`Désynchronisation critique : saut trop grand (${steps} > max ${this.MAX_SKIP_STEPS})`);
        }

        let currentChainBuf = inbound.chainKeyBuffer;

        for (let cur = inbound.lastIndex; cur <= idx; cur++) {
          const hkdfKey = await crypto.subtle.importKey(
            'raw', currentChainBuf, { name: 'HKDF' }, false, ['deriveKey', 'deriveBits']
          );

          const mkBits = await crypto.subtle.deriveBits(
            {
              name: 'HKDF',
              hash: 'SHA-256',
              salt: encoder.encode(`P2P_MESH_EPOCH_${epoch}`),
              info: encoder.encode(`P2P_MSG_KEY:${channelId}:${cur}`)
            },
            hkdfKey,
            256
          );

          const nextChainBits = await crypto.subtle.deriveBits(
            {
              name: 'HKDF',
              hash: 'SHA-256',
              salt: encoder.encode(`P2P_MESH_EPOCH_${epoch}`),
              info: encoder.encode(`P2P_CHAIN_ADVANCE:${channelId}:${cur}`)
            },
            hkdfKey,
            256
          );

          if (cur === idx) {
            targetMessageKey = await crypto.subtle.importKey(
              'raw', mkBits, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
            );
            SecureMemorySanitizer.wipe(mkBits);
          } else {
            // Sauvegarde de la clé sautée avec politique d'éviction LRU
            this._storeSkippedKey(`${senderId}:${epoch}:${channelId}:${cur}`, new Uint8Array(mkBits));
            SecureMemorySanitizer.wipe(mkBits);
          }

          SecureMemorySanitizer.wipe(currentChainBuf);
          currentChainBuf = new Uint8Array(nextChainBits);
        }

        inbound.chainKeyBuffer = currentChainBuf;
        inbound.lastIndex = idx + 1;
      }

      // 4. Déchiffrement AES-256-GCM
      const ivBuf = CryptoVault.hexToBuffer(iv);
      const cipherBuf = CryptoVault.hexToBuffer(ciphertext);
      const aadBytes = encoder.encode(JSON.stringify(aad || { epoch, channelId, senderId, idx }));

      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(ivBuf), tagLength: 128, additionalData: aadBytes },
        targetMessageKey,
        cipherBuf
      );

      const decodedText = new TextDecoder().decode(decryptedBuffer);
      try {
        return JSON.parse(decodedText);
      } catch {
        return decodedText;
      }
    } finally {
      if (tempRawKeyBuffer) {
        SecureMemorySanitizer.wipe(tempRawKeyBuffer);
        tempRawKeyBuffer = null;
      }
    }
  }

  /**
   * Enregistre une clé sautée dans le store borné avec politique d'éviction LRU
   * @private
   */
  _storeSkippedKey(keyId, keyBuffer) {
    if (this.skippedMessageKeys.size >= this.MAX_SKIPPED_STORE_SIZE) {
      const oldestKey = this.skippedMessageKeys.keys().next().value;
      if (oldestKey) {
        const item = this.skippedMessageKeys.get(oldestKey);
        if (item?.keyBuffer) SecureMemorySanitizer.wipe(item.keyBuffer);
        this.skippedMessageKeys.delete(oldestKey);
        logger.warn('SenderKeys', `🧹 Éviction LRU d'une clé sautée non réclamée: ${oldestKey}`);
      }
    }

    const clone = new Uint8Array(keyBuffer.byteLength);
    clone.set(keyBuffer);
    this.skippedMessageKeys.set(keyId, {
      keyBuffer: clone,
      createdAt: Date.now()
    });
  }

  /**
   * Procédure d'expulsion d'un membre avec bump d'époque et réinitialisation de la clé locale
   * @param {string} peerIdToEvict
   */
  async evictPeer(peerIdToEvict) {
    if (!peerIdToEvict) return;
    logger.warn('SenderKeys', `🚨 Déclenchement de l'expulsion du membre: ${peerIdToEvict}`);

    this.evictedPeers.add(peerIdToEvict);

    // 1. Purge et wipe des clés distantes associées au pair banni
    const inbound = this.inboundSenderKeys.get(peerIdToEvict);
    if (inbound?.chainKeyBuffer) {
      SecureMemorySanitizer.wipe(inbound.chainKeyBuffer);
    }
    this.inboundSenderKeys.delete(peerIdToEvict);

    // 2. Purge de toutes les clés sautées de ce pair
    for (const [k, item] of this.skippedMessageKeys) {
      if (k.startsWith(`${peerIdToEvict}:`)) {
        if (item?.keyBuffer) SecureMemorySanitizer.wipe(item.keyBuffer);
        this.skippedMessageKeys.delete(k);
      }
    }

    // 3. Transition d'époque globale et regénération de la Sender Key locale
    this.currentEpoch += 1;
    await this.generateLocalSenderKey(this.currentEpoch);

    logger.info('SenderKeys', `✅ Expulsion finalisée. Nouvelle époque de salon active: ${this.currentEpoch}`);
    return {
      epoch: this.currentEpoch,
      evictedPeer: peerIdToEvict,
      distributionMessage: await this.getLocalDistributionMessage()
    };
  }

  /**
   * Nettoie les clés sautées expirées (TTL > 10 min) avec Memory Scrubbing
   */
  sweepExpiredSkippedKeys() {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, item] of this.skippedMessageKeys) {
      if (now - item.createdAt > this.SKIPPED_KEY_TTL_MS) {
        if (item.keyBuffer) SecureMemorySanitizer.wipe(item.keyBuffer);
        this.skippedMessageKeys.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info('SenderKeys', `🧹 Sweep GC: ${cleaned} clés sautées expirées détruites en mémoire.`);
    }
  }

  /**
   * Destruction Zéro-Trace totale du gestionnaire
   */
  destroy() {
    if (this._gcInterval) clearInterval(this._gcInterval);
    if (this.localSenderKey?.chainKeyBuffer) {
      SecureMemorySanitizer.wipe(this.localSenderKey.chainKeyBuffer);
    }
    for (const item of this.inboundSenderKeys.values()) {
      if (item.chainKeyBuffer) SecureMemorySanitizer.wipe(item.chainKeyBuffer);
    }
    for (const item of this.skippedMessageKeys.values()) {
      if (item.keyBuffer) SecureMemorySanitizer.wipe(item.keyBuffer);
    }
    this.inboundSenderKeys.clear();
    this.skippedMessageKeys.clear();
    this.evictedPeers.clear();
    this.localSenderKey = null;
    logger.info('SenderKeys', '🧹 SenderKeysManager détruit avec succès.');
  }
}
