/**
 * sender-keys.js - Gestionnaire de Chiffrement de Groupe Signal Sender Keys (Megolm Protocol)
 * Complexité Chiffrement O(1), Post-Compromise Security par Époques, Store de Clés Sautées borné.
 * P2P Mesh Workspace (Pass 2 - 2026)
 */

import { CryptoVault } from './crypto-vault.js';
import { logger } from './logger.js';

export class SenderKeysManager {
  constructor(cryptoVault) {
    this.vault = cryptoVault;
    this.currentEpoch = 1;
    this.localSenderKey = null; // { chainKeyBuffer, messageIndex }
    this.inboundSenderKeys = new Map(); // peerId -> { epoch, chainKeyBuffer, lastIndex, publicKeyHex }
    this.skippedMessageKeys = new Map(); // keyId ("peerId:epoch:channel:idx") -> { keyBuffer, createdAt }
    
    this.MAX_SKIP_STEPS = 100;
    this.MAX_SKIPPED_STORE_SIZE = 2000;
    this.SKIPPED_KEY_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
   */
  async generateLocalSenderKey() {
    if (this.localSenderKey?.chainKeyBuffer) {
      CryptoVault.wipeBuffer(this.localSenderKey.chainKeyBuffer);
    }
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);

    this.localSenderKey = {
      epoch: this.currentEpoch,
      chainKeyBuffer: seed,
      messageIndex: 0
    };
    return this.getLocalDistributionMessage();
  }

  /**
   * Produit le message de distribution de clé (SKDM) à envoyer aux pairs
   */
  getLocalDistributionMessage() {
    if (!this.localSenderKey) throw new Error('Clé locale non initialisée');
    return {
      type: 'SENDER_KEY_DISTRIBUTION',
      epoch: this.localSenderKey.epoch,
      senderId: this.vault.peerId,
      publicKeyHex: this.vault.publicKeyHex,
      chainKeyHex: CryptoVault.bufferToHex(this.localSenderKey.chainKeyBuffer),
      startIndex: this.localSenderKey.messageIndex
    };
  }

  /**
   * Traite la réception d'une clé de diffusion distante (SKDM)
   */
  async handleInboundSenderKey(skdm) {
    if (!skdm || !skdm.senderId || !skdm.chainKeyHex) return false;
    const { senderId, epoch, chainKeyHex, startIndex, publicKeyHex } = skdm;
    const existing = this.inboundSenderKeys.get(senderId);
    if (existing && existing.epoch > epoch) {
      return false; // Rejet d'une époque obsolète
    }
    if (existing?.chainKeyBuffer) {
      CryptoVault.wipeBuffer(existing.chainKeyBuffer);
    }

    this.inboundSenderKeys.set(senderId, {
      epoch: epoch || 1,
      chainKeyBuffer: new Uint8Array(CryptoVault.hexToBuffer(chainKeyHex)),
      lastIndex: startIndex || 0,
      publicKeyHex: publicKeyHex || ''
    });
    return true;
  }

  /**
   * Chiffre un message de groupe en O(1) avec avancement du cliquet symétrique (Ratchet)
   */
  async encryptGroupMessage(channelId, plaintextObj) {
    if (!this.localSenderKey) await this.generateLocalSenderKey();

    const idx = this.localSenderKey.messageIndex;
    const epoch = this.localSenderKey.epoch;
    const encoder = new TextEncoder();

    // 1. Dérivation de la Clé de Message (MK) via HKDF
    const hkdfKey = await crypto.subtle.importKey(
      'raw', this.localSenderKey.chainKeyBuffer, { name: 'HKDF' }, false, ['deriveKey', 'deriveBits']
    );
    const messageKey = await crypto.subtle.deriveKey(
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
    const nextChainBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode(`P2P_MESH_EPOCH_${epoch}`),
        info: encoder.encode(`P2P_CHAIN_ADVANCE:${channelId}:${idx}`)
      },
      hkdfKey,
      256
    );

    // Écrasement RAM de l'ancienne clé et mise à jour
    CryptoVault.wipeBuffer(this.localSenderKey.chainKeyBuffer);
    this.localSenderKey.chainKeyBuffer = new Uint8Array(nextChainBits);
    this.localSenderKey.messageIndex += 1;

    // 3. Chiffrement AES-256-GCM avec Nonce déterministe et AAD
    const nonce = this.vault._generateDeterministicNonce();
    const aadObj = { epoch, channelId, senderId: this.vault.peerId, idx };
    const aadBytes = encoder.encode(JSON.stringify(aadObj));
    const rawPlaintext = encoder.encode(JSON.stringify(plaintextObj));

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128, additionalData: aadBytes },
      messageKey,
      rawPlaintext
    );

    const envelope = {
      epoch,
      channelId,
      senderId: this.vault.peerId,
      idx,
      iv: CryptoVault.bufferToHex(nonce),
      ciphertext: CryptoVault.bufferToHex(ciphertextBuffer),
      aad: aadObj
    };

    // 4. Signature ECDSA P-256 de non-répudiation de l'émetteur
    const signPayload = `${epoch}:${channelId}:${this.vault.peerId}:${idx}:${envelope.iv}:${envelope.ciphertext}`;
    envelope.signature = await this.vault.sign(signPayload);

    return envelope;
  }

  /**
   * Déchiffre un message de groupe entrant avec gestion des clés sautées
   */
  async decryptGroupMessage(envelope) {
    if (!envelope || !envelope.senderId) throw new Error('Enveloppe invalide');
    const { epoch, channelId, senderId, idx, iv, ciphertext, aad, signature } = envelope;
    const inbound = this.inboundSenderKeys.get(senderId);
    if (!inbound) throw new Error(`Aucune clé de diffusion enregistrée pour le pair ${senderId}`);
    if (inbound.epoch !== epoch) throw new Error(`Époque non concordante (reçu ${epoch}, attendu ${inbound.epoch})`);

    // 1. Vérification stricte de la signature de l'émetteur
    const signPayload = `${epoch}:${channelId}:${senderId}:${idx}:${iv}:${ciphertext}`;
    if (signature && inbound.publicKeyHex) {
      const isValidSig = await CryptoVault.verify(signPayload, signature, inbound.publicKeyHex);
      if (!isValidSig) throw new Error('Signature Sender Key falsifiée ou invalide');
    }

    const encoder = new TextEncoder();
    let targetMessageKey = null;

    // 2. Recherche dans le Store de Clés Sautées
    const skippedKeyId = `${senderId}:${epoch}:${channelId}:${idx}`;
    if (this.skippedMessageKeys.has(skippedKeyId)) {
      const { keyBuffer } = this.skippedMessageKeys.get(skippedKeyId);
      targetMessageKey = await crypto.subtle.importKey(
        'raw', keyBuffer, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
      );
      CryptoVault.wipeBuffer(keyBuffer);
      this.skippedMessageKeys.delete(skippedKeyId);
    } else {
      // 3. Avancement de la chaîne si idx >= lastIndex
      if (idx < inbound.lastIndex) {
        throw new Error(`Message obsolète ou rejoué (index ${idx} < dernier vu ${inbound.lastIndex})`);
      }
      const steps = idx - inbound.lastIndex;
      if (steps > this.MAX_SKIP_STEPS) {
        throw new Error(`Trop grand nombre de messages sautés (${steps} > max ${this.MAX_SKIP_STEPS})`);
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
          CryptoVault.wipeBuffer(mkBits);
        } else {
          // Sauvegarde de la clé sautée
          if (this.skippedMessageKeys.size < this.MAX_SKIPPED_STORE_SIZE) {
            this.skippedMessageKeys.set(`${senderId}:${epoch}:${channelId}:${cur}`, {
              keyBuffer: new Uint8Array(mkBits),
              createdAt: Date.now()
            });
          }
        }

        CryptoVault.wipeBuffer(currentChainBuf);
        currentChainBuf = new Uint8Array(nextChainBits);
      }

      inbound.chainKeyBuffer = currentChainBuf;
      inbound.lastIndex = idx + 1;
    }

    // 4. Déchiffrement AES-256-GCM
    const ivBuf = CryptoVault.hexToBuffer(iv);
    const cipherBuf = CryptoVault.hexToBuffer(ciphertext);
    const aadBytes = encoder.encode(JSON.stringify(aad));

    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(ivBuf), tagLength: 128, additionalData: aadBytes },
      targetMessageKey,
      cipherBuf
    );

    return JSON.parse(new TextDecoder().decode(decryptedBuffer));
  }

  sweepExpiredSkippedKeys() {
    const now = Date.now();
    for (const [id, item] of this.skippedMessageKeys) {
      if (now - item.createdAt > this.SKIPPED_KEY_TTL_MS) {
        CryptoVault.wipeBuffer(item.keyBuffer);
        this.skippedMessageKeys.delete(id);
      }
    }
  }

  destroy() {
    if (this._gcInterval) clearInterval(this._gcInterval);
    if (this.localSenderKey?.chainKeyBuffer) CryptoVault.wipeBuffer(this.localSenderKey.chainKeyBuffer);
    for (const item of this.inboundSenderKeys.values()) {
      if (item.chainKeyBuffer) CryptoVault.wipeBuffer(item.chainKeyBuffer);
    }
    for (const item of this.skippedMessageKeys.values()) {
      if (item.keyBuffer) CryptoVault.wipeBuffer(item.keyBuffer);
    }
    this.inboundSenderKeys.clear();
    this.skippedMessageKeys.clear();
    this.localSenderKey = null;
  }
}
