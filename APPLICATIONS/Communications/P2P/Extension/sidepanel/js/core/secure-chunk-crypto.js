/**
 * core/secure-chunk-crypto.js
 * Moteur Cryptographique de Chunks E2EE & Chiffrement Convergent Sécurisé (Pass 4 - 2026)
 * Standards : DupLESS, RFC 5869 (HKDF), NIST SP 800-38D (AES-GCM-256), RFC 8785 (JCS AAD)
 */

import { logger } from './logger.js';
import { CryptoVault } from './crypto-vault.js';
import { SecureMemorySanitizer } from './secure-memory-sanitizer.js';

export class SecureChunkCrypto {
  /**
   * @param {CryptoVault} vault Instance initialisée du coffre-fort cryptographique
   */
  constructor(vault) {
    if (!vault || !vault.isInitialized) {
      throw new Error('SecureChunkCrypto requiert un CryptoVault initialisé.');
    }
    this.vault = vault;
    this._drivePrkKey = null;
    this._hmacIvKey = null;
    this._isReady = false;
  }

  /**
   * Initialise les clés maîtresses de dérivation du Drive à partir de la clé maîtresse de salon
   */
  async initialize() {
    if (this._isReady) return this;

    const encoder = new TextEncoder();
    const driveSalt = encoder.encode('PMESH_DRIVE_ROOM_SALT_V4');
    const driveInfo = encoder.encode('pmesh-drive-prk-v1');

    // 1. Dérivation de la Pseudorandom Key (PRK) maîtresse pour le Drive E2EE
    const prkBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: driveSalt,
        info: driveInfo
      },
      this.vault.masterKey,
      256
    );

    // Importation sous forme de clé HKDF réutilisable
    this._drivePrkKey = await crypto.subtle.importKey(
      'raw',
      prkBits,
      { name: 'HKDF' },
      false,
      ['deriveKey', 'deriveBits']
    );

    // 2. Clé HMAC dédiée à la génération des IV déterministes
    this._hmacIvKey = await crypto.subtle.importKey(
      'raw',
      prkBits,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Nettoyage immédiat du secret intermédiaire brut
    SecureMemorySanitizer.wipe(prkBits);

    this._isReady = true;
    logger.info('DriveCrypto', '🔐 Moteur cryptographique de chunks E2EE/DupLESS initialisé.');
    return this;
  }

  /**
   * Dérive la clé symétrique AES-GCM 256 bits unique pour un chunk spécifique
   * @param {string} rawChunkHashHex Condensat SHA-256 du contenu brut du chunk
   * @returns {Promise<CryptoKey>}
   */
  async deriveChunkKey(rawChunkHashHex) {
    if (!this._isReady) await this.initialize();

    const encoder = new TextEncoder();
    const info = new Uint8Array(20 + 32);
    info.set(encoder.encode('PMESH_CHUNK_KEY_V1:'), 0);
    const hashBytes = new Uint8Array(CryptoVault.hexToBuffer(rawChunkHashHex));
    info.set(hashBytes, 19);

    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0), // Salt déjà absorbé par le Drive PRK
        info
      },
      this._drivePrkKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Génère un Nonce/IV de 96 bits déterministe et unique par chunk
   * @param {string} rawChunkHashHex
   * @param {number} chunkIndex
   * @returns {Promise<Uint8Array>} 12 octets
   */
  async deriveDeterministicNonce(rawChunkHashHex, chunkIndex) {
    if (!this._isReady) await this.initialize();

    const indexBuf = new ArrayBuffer(4);
    new DataView(indexBuf).setUint32(0, chunkIndex, false);

    const hashBytes = new Uint8Array(CryptoVault.hexToBuffer(rawChunkHashHex));
    const hmacPayload = new Uint8Array(hashBytes.length + 4);
    hmacPayload.set(hashBytes, 0);
    hmacPayload.set(new Uint8Array(indexBuf), hashBytes.length);

    const signature = await crypto.subtle.sign('HMAC', this._hmacIvKey, hmacPayload);
    return new Uint8Array(signature, 0, 12);
  }

  /**
   * Construit l'objet AAD canonique sérialisé
   */
  static buildAAD(meta) {
    const canonicalObj = {
      chunkIndex: meta.chunkIndex ?? 0,
      fileId: String(meta.fileId || ''),
      offset: meta.offset ?? 0,
      rawSize: meta.rawSize ?? 0,
      rootMerkleHash: String(meta.rootMerkleHash || '')
    };
    return new TextEncoder().encode(JSON.stringify(canonicalObj));
  }

  /**
   * Chiffre un chunk compressé ou brut avec AAD et Nonce déterministe
   * @param {Uint8Array} chunkPayload Données du bloc à chiffrer
   * @param {string} rawChunkHashHex Hash SHA-256 du contenu brut avant chiffrement
   * @param {object} meta Metadonnées contextuelles pour l'AAD
   * @returns {Promise<{ ciphertext: Uint8Array, cipherHash: string }>}
   */
  async encryptChunk(chunkPayload, rawChunkHashHex, meta) {
    const chunkKey = await this.deriveChunkKey(rawChunkHashHex);
    const iv = await this.deriveDeterministicNonce(rawChunkHashHex, meta.chunkIndex);
    const additionalData = SecureChunkCrypto.buildAAD(meta);

    const encryptedBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData,
        tagLength: 128
      },
      chunkKey,
      chunkPayload
    );

    const ciphertext = new Uint8Array(encryptedBuffer);
    const cipherHash = await CryptoVault.hashSHA256(ciphertext.buffer);

    return { ciphertext, cipherHash };
  }

  /**
   * Déchiffre un chunk avec vérification stricte de l'intégrité et de l'AAD
   * @param {Uint8Array|ArrayBuffer} ciphertextBuffer Données chiffrées (incluant le tag de 16 octets)
   * @param {string} rawChunkHashHex Hash SHA-256 attendu pour dériver la clé
   * @param {object} meta Metadonnées contextuelles de position
   * @returns {Promise<Uint8Array>}
   */
  async decryptChunk(ciphertextBuffer, rawChunkHashHex, meta) {
    const chunkKey = await this.deriveChunkKey(rawChunkHashHex);
    const iv = await this.deriveDeterministicNonce(rawChunkHashHex, meta.chunkIndex);
    const additionalData = SecureChunkCrypto.buildAAD(meta);

    try {
      const decryptedBuffer = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData,
          tagLength: 128
        },
        chunkKey,
        ciphertextBuffer
      );

      return new Uint8Array(decryptedBuffer);
    } catch (err) {
      throw new Error(`Échec de déchiffrement du bloc #${meta.chunkIndex} (AAD ou Clé invalide): ${err.message}`);
    }
  }

  /**
   * Nettoie les secrets du moteur cryptographique en mémoire vive
   */
  destroy() {
    this._drivePrkKey = null;
    this._hmacIvKey = null;
    this._isReady = false;
    logger.info('DriveCrypto', '🧹 Moteur de chiffrement de chunks détruit (Zero-Trace).');
  }
}
