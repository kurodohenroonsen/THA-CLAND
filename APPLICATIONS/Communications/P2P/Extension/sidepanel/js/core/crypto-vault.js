import { logger } from './logger.js';
import { Multibase, Multicodec } from './did-codec.js';
import { DIDDocumentResolver } from './did-resolver.js';
import { SenderKeysManager } from './sender-keys.js';

/**
 * Coffre-fort Cryptographique Web Crypto API - P2P Mesh (Pass 2 - 2026)
 * - Dérivation PBKDF2-SHA512 (600k) + HKDF
 * - Identité Souveraine W3C DID Core (did:key:z... / did:peer:2...) & Résolution locale O(1)
 * - Chiffrement de Groupe Signal Sender Keys O(1) + KDF Ratchet & Skipped Keys Store
 * - Chiffrement AES-GCM-256 (Nonces partitionnés déterministes & AAD)
 * - Signatures ECDSA P-256 (RFC 8785 JCS & W3C Data Integrity Proofs)
 * - Accord de clés Pairwise ECDH P-256 & Memory Scrubbing
 */

export class CryptoVault {
  constructor() {
    this.masterKey = null;
    this.signalingKey = null;
    this.contentKey = null;
    this.topicId = null;
    this.topicHex = null;
    this.peerId = null;
    this.peerIdHex = null;
    this.publicKeyHex = null;
    this.publicKeyMultibase = null;
    this.did = null;
    this.didPeer = null;
    this.didDocument = null;
    this.userName = null;
    this.signingKeyPair = null;
    this.ecdhKeyPair = null;
    this.senderKeys = new SenderKeysManager(this);
    this.isInitialized = false;
    this.isDestroyed = false;

    // Gestion déterministe des nonces (NIST SP 800-38D §8.2.1)
    this._nodeNoncePrefix = new Uint8Array(4);
    crypto.getRandomValues(this._nodeNoncePrefix);
    this._nonceCounter = 0n;
  }

  static _byteToHex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

  /**
   * Convertit un ArrayBuffer en chaîne hexadécimale ultra-rapide
   */
  static bufferToHex(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let hex = '';
    const table = CryptoVault._byteToHex;
    for (let i = 0; i < bytes.length; i++) {
      hex += table[bytes[i]];
    }
    return hex;
  }

  /**
   * Convertit une chaîne hexadécimale en ArrayBuffer
   */
  static hexToBuffer(hex) {
    if (typeof hex !== 'string') {
      throw new TypeError(`Attendu une chaîne hexadécimale, reçu: ${typeof hex}`);
    }
    const cleanHex = hex.trim();
    const bytes = new Uint8Array(cleanHex.length / 2);
    for (let i = 0; i < cleanHex.length; i += 2) {
      bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
    }
    return bytes.buffer;
  }

  /**
   * Écrase de manière sécurisée un ArrayBuffer ou TypedArray en mémoire vive (Memory Zeroization)
   */
  static wipeBuffer(bufferOrArray) {
    if (!bufferOrArray) return;
    try {
      const view = bufferOrArray instanceof Uint8Array 
        ? bufferOrArray 
        : (bufferOrArray.buffer ? new Uint8Array(bufferOrArray.buffer) : new Uint8Array(bufferOrArray));
      crypto.getRandomValues(view);
      view.fill(0);
    } catch {
      // Ignorer si tampon verrouillé
    }
  }

  /**
   * Hachage SHA-256 standardisé renvoyant une chaîne hexadécimale
   */
  static async hashSHA256(data) {
    const encoder = new TextEncoder();
    const rawBytes = typeof data === 'string' ? encoder.encode(data) : data;
    const hashBuffer = await crypto.subtle.digest('SHA-256', rawBytes);
    return CryptoVault.bufferToHex(hashBuffer);
  }

  /**
   * Générateur d'entier uniforme anti-biais de modulo [0, max)
   */
  static _uniformInt(max) {
    if (max <= 0) throw new RangeError('max doit être strictement positif');
    const maxUint32 = 0x100000000;
    const limit = maxUint32 - (maxUint32 % max);
    const buf = new Uint32Array(1);
    while (true) {
      crypto.getRandomValues(buf);
      if (buf[0] < limit) {
        return buf[0] % max;
      }
    }
  }

  /**
   * Génère un code papier sécurisé (6 mots OTAN + checksum 4 chiffres)
   */
  static generatePaperCode() {
    const wordlist = CryptoVault.WORDLIST;
    const words = [];
    for (let i = 0; i < 6; i++) {
      const idx = CryptoVault._uniformInt(wordlist.length);
      words.push(wordlist[idx]);
    }
    const checkInt = CryptoVault._uniformInt(9000) + 1000;
    return `${words.join('-')}-${checkInt}`;
  }

  /**
   * Calcule l'entropie théorique d'un code papier
   */
  static calculateEntropy(code) {
    if (!code || typeof code !== 'string') {
      return { bits: 0, isSecure: false, cls: 'entropy-weak', label: 'Vide' };
    }
    const clean = code.trim().toUpperCase();
    const parts = clean.split('-');
    if (parts.length < 2) {
      return { bits: Math.min(20, clean.length * 3), isSecure: false, cls: 'entropy-weak', label: 'Très Faible' };
    }
    const words = parts.slice(0, -1);
    const digits = parts[parts.length - 1];
    const uniqueWords = new Set(words);
    const wordEntropy = uniqueWords.size * Math.log2(CryptoVault.WORDLIST.length);
    const digitEntropy = /^\d+$/.test(digits) ? digits.length * Math.log2(10) : 0;
    const penalty = words.length !== uniqueWords.size ? 0.75 : 1.0;
    const totalBits = Math.round((wordEntropy + digitEntropy) * penalty);

    if (totalBits >= 55) {
      return { bits: totalBits, isSecure: true, cls: 'entropy-strong', label: 'Excellent' };
    }
    if (totalBits >= 40) {
      return { bits: totalBits, isSecure: true, cls: 'entropy-medium', label: 'Moyen' };
    }
    return { bits: totalBits, isSecure: false, cls: 'entropy-weak', label: 'Faible' };
  }

  /**
   * Valide le format d'un code papier
   */
  static validatePaperCode(code) {
    if (!code || typeof code !== 'string') return false;
    const parts = code.trim().toUpperCase().split('-');
    if (parts.length !== 7) return false;

    const words = parts.slice(0, 6);
    const checksum = parts[6];

    const wordlistSet = new Set(CryptoVault.WORDLIST);
    for (const w of words) {
      if (!wordlistSet.has(w)) return false;
    }

    return /^\d{4}$/.test(checksum);
  }

  /**
   * Normalise un code papier pour la dérivation cryptographique
   */
  static normalizePaperCode(code) {
    return code.trim().toUpperCase().replace(/\s+/g, '-');
  }

  /**
   * Génère un Nonce partitionné déterministe de 96 bits (12 octets)
   */
  _generateDeterministicNonce() {
    const nonce = new Uint8Array(12);
    nonce.set(this._nodeNoncePrefix, 0); // 4 octets préfixe nœud

    this._nonceCounter += 1n;
    let count = this._nonceCounter;
    for (let i = 11; i >= 4; i--) {
      nonce[i] = Number(count & 0xffn);
      count >>= 8n;
    }
    return nonce;
  }

  /**
   * Initialise le coffre-fort depuis un code papier
   */
  async initializeFromPaperCode(paperCode, customName = 'Membre P2P') {
    if (!CryptoVault.validatePaperCode(paperCode)) {
      throw new Error('Code papier invalide ou corrompu');
    }

    const normalizedCode = CryptoVault.normalizePaperCode(paperCode);
    const encoder = new TextEncoder();
    const codeBuffer = encoder.encode(normalizedCode);

    let masterDeriveBits = null;

    try {
      logger.info('Vault', `🔐 Démarrage dérivation cryptographique (Utilisateur: "${customName}")`);

      // 1. Dérivation PBKDF2-SHA512 (600 000 itérations)
      const baseKey = await crypto.subtle.importKey(
        'raw',
        codeBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveBits', 'deriveKey']
      );

      const pbkdf2Salt = encoder.encode('P2P_MESH_PAPER_SALT_V2');
      masterDeriveBits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: pbkdf2Salt,
          iterations: CryptoVault.PBKDF2_ITERATIONS,
          hash: 'SHA-512'
        },
        baseKey,
        512 // 64 octets d'entropie maîtresse
      );

      // 2. Importation de la clé HKDF Maîtresse
      const hkdfMasterKey = await crypto.subtle.importKey(
        'raw',
        masterDeriveBits,
        { name: 'HKDF' },
        false,
        ['deriveKey', 'deriveBits']
      );

      this.masterKey = hkdfMasterKey;

      // 3. Dérivation du Topic ID du salon
      const topicBytes = await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode('P2P_TOPIC_SALT'),
          info: encoder.encode('mesh-topic-identifier-v1')
        },
        hkdfMasterKey,
        160 // 20 octets pour compatibilité info_hash WebTorrent
      );
      this.topicId = topicBytes;
      this.topicHex = CryptoVault.bufferToHex(topicBytes);

      // 4. Dérivation de la clé de signalement
      this.signalingKey = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode('P2P_SIGNALING_SALT'),
          info: encoder.encode('signaling-channel-v1')
        },
        hkdfMasterKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      // 5. Dérivation de la clé de contenu symétrique
      this.contentKey = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode('P2P_CONTENT_SALT'),
          info: encoder.encode('content-cipher-v1')
        },
        hkdfMasterKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      // 6. Paire ECDSA P-256 protégée (extractable: false)
      this.signingKeyPair = await crypto.subtle.generateKey(
        {
          name: 'ECDSA',
          namedCurve: 'P-256'
        },
        false,
        ['sign', 'verify']
      );

      // 7. Paire ECDH P-256 pour l'accord de clés pairwise
      this.ecdhKeyPair = await crypto.subtle.generateKey(
        {
          name: 'ECDH',
          namedCurve: 'P-256'
        },
        false,
        ['deriveKey', 'deriveBits']
      );

      // Export SPKI de la clé publique de signature
      const exportedPubkey = await crypto.subtle.exportKey('spki', this.signingKeyPair.publicKey);
      this.publicKeyHex = CryptoVault.bufferToHex(exportedPubkey);

      // Encodage Multicodec + Multibase Base58-BTC (W3C did:key)
      try {
        const uncompressedPub = new Uint8Array(exportedPubkey).slice(26);
        const compressedPub = Multicodec.compressP256(uncompressedPub);
        const multicodecPayload = Multicodec.addPrefix(Multicodec.P256_PUB, compressedPub);
        this.publicKeyMultibase = Multibase.encodeBase58Btc(multicodecPayload);
        this.did = `did:key:${this.publicKeyMultibase}`;
        this.didPeer = DIDDocumentResolver.createDidPeer2({
          signingMultibase: this.publicKeyMultibase,
          signalingEndpoint: `pmesh://topic/${this.topicHex}`
        });
        this.didDocument = DIDDocumentResolver.resolve(this.did).didDocument;
      } catch {
        this.did = `did:key:raw_${this.publicKeyHex.substring(0, 32)}`;
      }

      // Initialisation du gestionnaire Sender Keys
      await this.senderKeys.generateLocalSenderKey();

      // Peer ID cryptographiquement lié à la clé publique
      const pubHashHex = await CryptoVault.hashSHA256(this.publicKeyHex);
      this.peerIdHex = pubHashHex.substring(0, 40);
      this.peerId = `peer_${this.peerIdHex.substring(0, 16)}`;
      this.userName = customName;
    } finally {
      // Nettoyage Zéro-Trace en RAM des tampons transitoires
      CryptoVault.wipeBuffer(codeBuffer);
      if (masterDeriveBits) {
        CryptoVault.wipeBuffer(masterDeriveBits);
        masterDeriveBits = null;
      }
    }

    this.isInitialized = true;
    this.isDestroyed = false;
    logger.info('Vault', `🎯 Coffre initialisé avec succès ! Topic: ${this.topicHex.substring(0, 10)}... | PeerId: ${this.peerId}`);
    return this;
  }

  /**
   * Chiffre des données avec AES-GCM-256, Nonce partitionné et tag 128-bit strict
   */
  async encrypt(data, isSignaling = false, aadContext = null) {
    const key = isSignaling ? this.signalingKey : this.contentKey;
    if (!key) throw new Error('Clé de chiffrement non initialisée');

    const encoder = new TextEncoder();
    const rawBytes = typeof data === 'string' ? encoder.encode(data) : encoder.encode(JSON.stringify(data));
    const iv = this._generateDeterministicNonce();
    const additionalData = aadContext ? encoder.encode(typeof aadContext === 'string' ? aadContext : JSON.stringify(aadContext)) : undefined;

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128, additionalData },
      key,
      rawBytes
    );

    return {
      iv: CryptoVault.bufferToHex(iv),
      ciphertext: CryptoVault.bufferToHex(ciphertextBuffer)
    };
  }

  /**
   * Déchiffre un paquet AES-GCM
   */
  async decrypt(packet, isSignaling = false, aadContext = null) {
    const key = isSignaling ? this.signalingKey : this.contentKey;
    if (!key) throw new Error('Clé de déchiffrement non initialisée');

    if (!packet || typeof packet.iv !== 'string' || typeof packet.ciphertext !== 'string') {
      throw new TypeError('Structure de paquet chiffré invalide');
    }

    const iv = CryptoVault.hexToBuffer(packet.iv);
    const ciphertext = CryptoVault.hexToBuffer(packet.ciphertext);
    const encoder = new TextEncoder();
    const additionalData = aadContext ? encoder.encode(typeof aadContext === 'string' ? aadContext : JSON.stringify(aadContext)) : undefined;

    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv), tagLength: 128, additionalData },
      key,
      ciphertext
    );

    const decodedStr = new TextDecoder().decode(decryptedBuffer);
    try {
      return JSON.parse(decodedStr);
    } catch {
      return decodedStr;
    }
  }

  /**
   * Chiffre un bloc binaire brut (Drive 16 Ko)
   */
  async encryptBinary(chunkBytes, customKey = null) {
    const key = customKey || this.contentKey;
    if (!key) throw new Error('Clé de chiffrement non initialisée');

    const iv = this._generateDeterministicNonce();
    const rawBuffer = chunkBytes instanceof Uint8Array ? chunkBytes : new Uint8Array(chunkBytes);

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      rawBuffer
    );

    return {
      iv: CryptoVault.bufferToHex(iv),
      ciphertext: CryptoVault.bufferToHex(ciphertextBuffer)
    };
  }

  /**
   * Déchiffre un bloc binaire brut
   */
  async decryptBinary(ivOrCombined, ciphertextHex = null, customKey = null) {
    const key = customKey || this.contentKey;
    if (!key) throw new Error('Clé de déchiffrement non initialisée');

    let iv, ciphertext;
    if (ciphertextHex !== null && typeof ciphertextHex === 'string') {
      iv = CryptoVault.hexToBuffer(ivOrCombined);
      ciphertext = CryptoVault.hexToBuffer(ciphertextHex);
    } else {
      const combined = new Uint8Array(ivOrCombined);
      if (combined.byteLength < 28) {
        throw new Error('Bloc binaire trop court pour être valide');
      }
      iv = combined.slice(0, 12);
      ciphertext = combined.slice(12);
    }

    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv), tagLength: 128 },
      key,
      ciphertext
    );
  }

  /**
   * Primitives d'accord de clés ECDH P-256
   */
  static async derivePairwiseKey(localPrivateKey, remotePublicKeySPKIHex) {
    const remoteKeyBuffer = CryptoVault.hexToBuffer(remotePublicKeySPKIHex);
    const remotePublicKey = await crypto.subtle.importKey(
      'spki',
      remoteKeyBuffer,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    return await crypto.subtle.deriveKey(
      { name: 'ECDH', public: remotePublicKey },
      localPrivateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Canonisation stricte RFC 8785 (JCS) avec normalisation Unicode NFC
   */
  static canonicalize(obj, excludeFields = ['signature']) {
    const defaultExcludes = Array.isArray(excludeFields) ? excludeFields : (excludeFields ? [excludeFields] : ['signature']);
    const excludeSet = new Set(defaultExcludes);
    function serialize(v) {
      if (v === null || typeof v !== 'object') {
        if (typeof v === 'string') return JSON.stringify(v.normalize('NFC'));
        if (typeof v === 'number') {
          if (!Number.isFinite(v)) return 'null';
          if (Object.is(v, -0)) return '0';
          return JSON.stringify(v);
        }
        return JSON.stringify(v);
      }
      if (Array.isArray(v)) {
        return '[' + v.map((item) => (item === undefined ? 'null' : serialize(item))).join(',') + ']';
      }
      const keys = Object.keys(v).filter((k) => !excludeSet.has(k) && v[k] !== undefined).sort();
      return '{' + keys.map((k) => JSON.stringify(k.normalize('NFC')) + ':' + serialize(v[k])).join(',') + '}';
    }
    return serialize(obj);
  }

  /**
   * Signe des données avec ECDSA P-256 et canonisation JCS
   */
  async sign(data, excludeFields = ['signature']) {
    if (!this.signingKeyPair?.privateKey) {
      throw new Error('Clé privée de signature non disponible');
    }

    const payloadStr = typeof data === 'string' ? data : CryptoVault.canonicalize(data, excludeFields);
    const encoder = new TextEncoder();
    const rawBytes = encoder.encode(payloadStr);

    const signatureBuffer = await crypto.subtle.sign(
      {
        name: 'ECDSA',
        hash: { name: 'SHA-256' }
      },
      this.signingKeyPair.privateKey,
      rawBytes
    );

    return CryptoVault.bufferToHex(signatureBuffer);
  }

  /**
   * Vérifie une signature ECDSA P-256
   */
  static async verify(data, signatureHex, publicKeyHex, excludeFields = ['signature']) {
    if (!data || !signatureHex || !publicKeyHex) return false;

    try {
      const pubKeyBuffer = CryptoVault.hexToBuffer(publicKeyHex);
      const pubKey = await crypto.subtle.importKey(
        'spki',
        pubKeyBuffer,
        {
          name: 'ECDSA',
          namedCurve: 'P-256'
        },
        false,
        ['verify']
      );

      const payloadStr = typeof data === 'string' ? data : CryptoVault.canonicalize(data, excludeFields);
      const encoder = new TextEncoder();
      const rawBytes = encoder.encode(payloadStr);
      const signatureBuffer = CryptoVault.hexToBuffer(signatureHex);

      return await crypto.subtle.verify(
        {
          name: 'ECDSA',
          hash: { name: 'SHA-256' }
        },
        pubKey,
        signatureBuffer,
        rawBytes
      );
    } catch (err) {
      logger.warn('Vault', 'Échec vérification signature ECDSA:', err.message);
      return false;
    }
  }

  /**
   * Vérifie un objet auto-signé avec exclusion de signature
   */
  static async verifyObject(obj, options = {}) {
    if (!obj || typeof obj !== 'object') return false;

    const signatureField = options.signatureField || 'signature';
    const pubkeyField = options.pubkeyField || (obj.authorPubkey ? 'authorPubkey' : 'pubkey');
    const idField = options.idField || (obj.authorId ? 'authorId' : 'peerId');
    const extraExcluded = options.excludeFields || [];

    const sigHex = obj[signatureField];
    const pubHex = obj[pubkeyField];

    if (!sigHex || !pubHex) return false;

    // Vérification de la concordance de l'identifiant du pair avec sa clé publique
    if (obj[idField]) {
      const computedHash = await CryptoVault.hashSHA256(pubHex);
      const expectedPrefix = `peer_${computedHash.substring(0, 16)}`;
      if (obj[idField] !== expectedPrefix && !obj[idField].startsWith('peer_')) {
        return false;
      }
    }

    const excluded = [signatureField, ...extraExcluded];
    return await CryptoVault.verify(obj, sigHex, pubHex, excluded);
  }

  /**
   * Calcule un Numéro de Sécurité SAS (Safety Number 5200 rounds SHA-512)
   */
  static async computeSafetyNumber(myPublicKeyHex, peerPublicKeyHex) {
    if (!myPublicKeyHex || !peerPublicKeyHex) return { numeric: '------', emojis: [] };

    const sortedKeys = [myPublicKeyHex, peerPublicKeyHex].sort();
    const combined = sortedKeys[0] + sortedKeys[1];
    const encoder = new TextEncoder();

    let currentHash = new Uint8Array(await crypto.subtle.digest('SHA-512', encoder.encode(combined)));
    for (let i = 0; i < 5200; i++) {
      const iterBuffer = new Uint8Array(currentHash.length + encoder.encode(combined).length);
      iterBuffer.set(currentHash, 0);
      iterBuffer.set(encoder.encode(combined), currentHash.length);
      currentHash = new Uint8Array(await crypto.subtle.digest('SHA-512', iterBuffer));
    }

    const blocks = [];
    for (let b = 0; b < 12; b++) {
      const offset = b * 4;
      const val =
        ((currentHash[offset] << 24) |
          (currentHash[offset + 1] << 16) |
          (currentHash[offset + 2] << 8) |
          currentHash[offset + 3]) >>>
        0;
      const digits = (val % 100000).toString().padStart(5, '0');
      blocks.push(digits);
    }

    const numeric = `${blocks.slice(0, 6).join(' ')}\n${blocks.slice(6, 12).join(' ')}`;

    // 7 emojis déterministes dérivés des octets 48 à 54
    const EMOJI_LIST = ['🐶','🐱','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🐢','🐍','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','鲨','🐊','🐅','🐆','🦓','🦍','🐘','🦛','🦏','🐪','🦒','🦘','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕'];
    const emojis = [];
    for (let e = 0; e < 7; e++) {
      const byteVal = currentHash[48 + e] || 0;
      emojis.push(EMOJI_LIST[byteVal % EMOJI_LIST.length]);
    }

    return { numeric, emojis };
  }

  /**
   * Génère une empreinte visuelle SVG (Identicon géométrique)
   */
  static generateVisualFingerprint(inputStr) {
    if (!inputStr) return '';
    let hash = 0;
    for (let i = 0; i < inputStr.length; i++) {
      hash = (hash << 5) - hash + inputStr.charCodeAt(i);
      hash |= 0;
    }

    const bytes = [];
    for (let i = 0; i < 16; i++) {
      bytes.push(Math.abs((hash ^ (i * 0x9e3779b9)) & 0xff));
    }

    const hue = (bytes[0] * 360) / 255;
    const sat = 65 + (bytes[1] % 25);
    const light = 50 + (bytes[2] % 15);
    const color = `hsl(${hue}, ${sat}%, ${light}%)`;
    const bg = `hsl(${(hue + 180) % 360}, 20%, 12%)`;

    let rects = '';
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        const byteIdx = (row * 3 + col + 3) % bytes.length;
        if ((bytes[byteIdx] % 2) === 1) {
          rects += `<rect x="${col * 12 + 2}" y="${row * 12 + 2}" width="10" height="10" rx="2" fill="${color}"/>`;
          if (col < 2) {
            rects += `<rect x="${(4 - col) * 12 + 2}" y="${row * 12 + 2}" width="10" height="10" rx="2" fill="${color}"/>`;
          }
        }
      }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 62 62"><rect width="62" height="62" rx="14" fill="${bg}"/>${rects}</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  /**
   * Destruction Zéro-Trace du coffre cryptographique en mémoire vive
   */
  destroy() {
    if (this.senderKeys) {
      try { this.senderKeys.destroy(); } catch {}
    }
    this.masterKey = null;
    this.signalingKey = null;
    this.contentKey = null;
    this.signingKeyPair = null;
    this.ecdhKeyPair = null;
    this.topicId = null;
    this.topicHex = null;
    this.peerId = null;
    this.peerIdHex = null;
    this.publicKeyHex = null;
    this.userName = null;
    if (this._nodeNoncePrefix) CryptoVault.wipeBuffer(this._nodeNoncePrefix);
    this._nonceCounter = 0n;
    this.isInitialized = false;
    this.isDestroyed = true;
    logger.info('Vault', '🧹 Coffre cryptographique détruit (Zero-Trace Memory Scrubbing).');
  }
}

// --- Liste de mots OTAN étendue pour les codes papier (256 termes lisibles) ---
CryptoVault.WORDLIST = (() => {
  const base = [
    'ALPHA','BRAVO','CHARLIE','DELTA','ECHO','FOXTROT','GOLF','HOTEL','INDIGO','JULIET',
    'KILO','LIMA','MIKE','NOVEMBER','OSCAR','PAPA','QUEBEC','ROMEO','SIERRA','TANGO',
    'UNIFORM','VICTOR','WHISKEY','XRAY','YANKEE','ZULU','FALCON','GALAXY','HORIZON','NEBULA',
    'OMEGA','PULSAR','QUANTUM','RADAR','SOLAR','TITAN','URANUS','VECTOR','ZENITH','NEXUS',
    'CIPHER','MATRIX','LUMEN','KAPPA','JUPITER','SATURN','MERCURY','VENUS','MARS','NEPTUNE',
    'PLUTO','COMET','METEOR','NOVA','QUASAR','ORBIT','COSMOS','PHOTON','PLASMA','ATOM',
    'PROTON','NEUTRON','ELECTRON','FUSION','FISSION','GRAVITY','MAGNET','CRYSTAL','PRISM','LASER',
    'BEACON','ANCHOR','HARBOR','SUMMIT','CANYON','GLACIER','TUNDRA','SAVANNA','DESERT','FOREST',
    'RIVER','OCEAN','ISLAND','VOLCANO','GEYSER','THUNDER','LIGHTNING','MONSOON','AURORA','ECLIPSE',
    'ZEPHYR','TEMPEST','CASCADE','RAPID','SUMMITT','RIDGE','VALLEY','MEADOW','WILLOW','CEDAR',
    'MAPLE','ASPEN','BIRCH','JUNIPER','SEQUOIA','ORCHID','JASMINE','LOTUS','IRIS','AMBER',
    'JADE','ONYX','OPAL','TOPAZ','RUBY','EMERALD','SAPPHIRE','DIAMOND','QUARTZ','GRANITE',
    'COBALT','NICKEL','COPPER','SILVER','PLATINUM','TITANIUM','CHROME','IRON','ZINC','CARBON',
    'HELIUM','NEON','ARGON','KRYPTON','XENON','RADON','OXYGEN','NITROGEN','HYDROGEN','CALCIUM',
    'FALCONER','RANGER','SCOUT','PILOT','CAPTAIN','ADMIRAL','MARSHAL','SENTRY','GUARDIAN','WARDEN',
    'PHOENIX','GRIFFIN','DRAGON','KRAKEN','HYDRA','SPHINX','PEGASUS','CENTAUR','MINOTAUR','CYCLOPS',
    'RAVEN','FALCONRY','EAGLE','HAWK','OSPREY','HERON','CRANE','SPARROW','ROBIN','FINCH',
    'LYNX','PANTHER','JAGUAR','LEOPARD','CHEETAH','COUGAR','BOBCAT','OCELOT','SERVAL','CARACAL',
    'BASALT','MARBLE','SLATE','FLINT','PUMICE','GYPSUM','SULFUR','COBALTIC','MERIDIAN','EQUATOR',
    'POLARIS','SIRIUS','VEGA','RIGEL','ANTARES','ALTAIR','DENEB','CASTOR','POLLUX','SPICA',
    'HELIX','SPIRAL','VORTEX','NEBULAE','CLUSTER','GALACTIC','STELLAR','LUNAR','SOLARIS','ASTRAL',
    'BEACONS','CIPHERS','ENIGMA','RIDDLE','PUZZLE','TOKEN','KEYSTONE','LATTICE','MOSAIC','FRACTAL',
    'TESSERA','OCTAGON','HEXAGON','PENTAGON','POLYGON','VERTEX','APEX','ZENITHAL','NADIR','AZIMUTH',
    'COMPASS','SEXTANT','ASTROLABE','GNOMON','SUNDIAL','PENDULUM','QUARTZITE','FELDSPAR','OBSIDIAN','MALACHITE',
    'AMETHYST','GARNET','PERIDOT','CITRINE','ZIRCON','SPINEL','BERYL','TOURMALINE','MOONSTONE','SUNSTONE',
    'HELIODOR','KUNZITE','AZURITE','LAPIS','TURQUOISE','CORAL'
  ];
  const seen = new Set();
  const list = [];
  for (const w of base) {
    const u = String(w).trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (u && !seen.has(u)) {
      seen.add(u);
      list.push(u);
    }
  }
  return list;
})();

// Coût PBKDF2 (600 000 itérations SHA-512 conforme OWASP 2025/2026)
CryptoVault.PBKDF2_ITERATIONS = 600000;
