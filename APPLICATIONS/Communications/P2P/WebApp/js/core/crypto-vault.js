import { logger } from './logger.js';

/**
 * Coffre-fort Cryptographique Web Crypto API - P2P Mesh (2025/2026)
 * Dérivation PBKDF2-SHA512 (600k) + HKDF, Chiffrement AES-GCM-256 (Nonces partitionnés déterministes & AAD),
 * Signatures ECDSA P-256 (RFC 8785 JCS), Numéros de Sécurité (Safety Numbers SAS) et Memory Scrubbing.
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
    this.userName = null;
    this.signingKeyPair = null;
    this.isInitialized = false;
    this.isDestroyed = false;

    // Gestion déterministe des nonces (NIST SP 800-38D §8.2.1)
    this._nodeNoncePrefix = new Uint8Array(4);
    crypto.getRandomValues(this._nodeNoncePrefix);
    this._nonceCounter = 0n;
  }

  /**
   * Convertit un ArrayBuffer en chaîne hexadécimale
   */
  static bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
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
      if (bufferOrArray.fill) bufferOrArray.fill(0);
    }
  }

  /**
   * Tirage uniforme d'un entier dans [0, max) sans biais de modulo
   */
  static _uniformInt(max) {
    if (max <= 0) throw new RangeError('max doit être > 0');
    const limit = Math.floor(0xffffffff / max) * max;
    const buf = new Uint32Array(1);
    let x;
    do {
      crypto.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % max;
  }

  /**
   * Génère un code papier sécurisé de 6 mots + 4 chiffres (~61 bits d'entropie)
   */
  static generatePaperCode(wordCount = 6) {
    const words = CryptoVault.WORDLIST;
    const parts = [];
    for (let i = 0; i < wordCount; i++) {
      parts.push(words[CryptoVault._uniformInt(words.length)]);
    }
    parts.push(CryptoVault._uniformInt(10000).toString().padStart(4, '0'));
    return parts.join('-');
  }

  /**
   * Évalue l'entropie d'un code papier avec détection des répétitions et formatage UI
   */
  static calculateEntropy(code) {
    if (!code || typeof code !== 'string') {
      return { bits: 0, label: 'Code vide', cls: 'entropy-none', pct: 0, isSecure: false };
    }

    const clean = code.trim().toUpperCase();
    if (!clean) {
      return { bits: 0, label: 'Code vide', cls: 'entropy-none', pct: 0, isSecure: false };
    }

    const tokens = clean.split(/[\s\-_.]+/).filter(Boolean);
    const wordlistSet = new Set(CryptoVault.WORDLIST || []);
    const seenWords = new Set();
    let bits = 0;

    for (const tok of tokens) {
      if (/^\d{4}$/.test(tok)) {
        bits += Math.log2(10000); // ~13.28 bits
      } else if (wordlistSet.has(tok)) {
        if (seenWords.has(tok)) {
          bits += 1; // Pénalité en cas de répétition
        } else {
          seenWords.add(tok);
          bits += Math.log2(CryptoVault.WORDLIST.length); // 8 bits
        }
      } else if (/^[A-Z]{3,}$/.test(tok)) {
        bits += Math.min(tok.length * Math.log2(26), 12);
      } else {
        let pool = 0;
        if (/[A-Z]/.test(tok)) pool += 26;
        if (/[0-9]/.test(tok)) pool += 10;
        if (/[^A-Z0-9]/.test(tok)) pool += 16;
        bits += tok.length * Math.log2(Math.max(2, pool));
      }
    }

    const roundedBits = Math.round(bits);
    let label = 'Faible';
    let cls = 'entropy-weak';
    let pct = Math.min(100, Math.round((roundedBits / 64) * 100));

    if (roundedBits >= 60 && seenWords.size >= 4) {
      label = 'Forte (Recommandée)';
      cls = 'entropy-strong';
    } else if (roundedBits >= 40) {
      label = 'Moyenne';
      cls = 'entropy-medium';
    }

    return {
      bits: roundedBits,
      label,
      cls,
      pct,
      isSecure: roundedBits >= 55
    };
  }

  static estimatePaperCodeEntropyBits(code) {
    return CryptoVault.calculateEntropy(code).bits;
  }

  /**
   * Calcule le hash SHA-256 d'une chaîne ou d'un ArrayBuffer
   */
  static async hashSHA256(data) {
    const buffer =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data instanceof Uint8Array
        ? data.buffer
        : data;

    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return CryptoVault.bufferToHex(hashBuffer);
  }

  /**
   * Génère un nonce 96-bit partitionné déterministe (NIST SP 800-38D)
   */
  _generateDeterministicNonce() {
    const nonce = new Uint8Array(12);
    nonce.set(this._nodeNoncePrefix, 0); // 4 premiers octets = préfixe de session
    const view = new DataView(nonce.buffer);
    view.setBigUint64(4, this._nonceCounter, false); // 8 octets suivants = compteur Big-Endian
    this._nonceCounter += 1n;
    return nonce;
  }

  /**
   * Initialise le coffre cryptographique à partir du code papier
   */
  async initializeFromPaperCode(paperCode, customName = 'Membre P2P') {
    if (!paperCode || typeof paperCode !== 'string') {
      throw new Error('Code papier invalide');
    }

    logger.info('Vault', `🔐 Démarrage dérivation cryptographique (Utilisateur: "${customName}")`);

    const cleanCode = paperCode.trim().toUpperCase();
    const encoder = new TextEncoder();
    const codeBuffer = encoder.encode(cleanCode);
    let masterDeriveBits = null;

    try {
      // 1. Clé brute de base PBKDF2
      const baseKey = await crypto.subtle.importKey(
        'raw',
        codeBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
      );

      // 2. Dérivation PBKDF2 (600 000 itérations SHA-512)
      const ITERATIONS = CryptoVault.PBKDF2_ITERATIONS;
      const staticSalt = encoder.encode('P2P_MESH_DECENTRALIZED_WORKSPACE_SALT_v2');
      masterDeriveBits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: staticSalt,
          iterations: ITERATIONS,
          hash: 'SHA-512'
        },
        baseKey,
        512 // 64 octets
      );

      // 3. Clé maîtresse HKDF
      const hkdfMasterKey = await crypto.subtle.importKey(
        'raw',
        masterDeriveBits,
        { name: 'HKDF' },
        false,
        ['deriveKey', 'deriveBits']
      );

      // 4. Topic ID de rendez-vous (20 octets = 40 hex chars)
      const topicBits = await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode('P2P_TOPIC_SALT'),
          info: encoder.encode('rendezvous-topic-v1')
        },
        hkdfMasterKey,
        160
      );
      this.topicHex = CryptoVault.bufferToHex(topicBits);
      this.topicId = this.topicHex;

      // 5. Clé de signalement WebRTC (AES-GCM 256)
      this.signalingKey = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode('P2P_SIGNALING_SALT'),
          info: encoder.encode('signaling-cipher-v1')
        },
        hkdfMasterKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      // 6. Clé de contenu E2EE (AES-GCM 256)
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

      // 7. Paire ECDSA P-256 protégée (extractable: false)
      this.signingKeyPair = await crypto.subtle.generateKey(
        {
          name: 'ECDSA',
          namedCurve: 'P-256'
        },
        false, // 🔒 Clé privée protégée en mémoire V8
        ['sign', 'verify']
      );

      // Export SPKI de la clé publique
      const exportedPubkey = await crypto.subtle.exportKey('spki', this.signingKeyPair.publicKey);
      this.publicKeyHex = CryptoVault.bufferToHex(exportedPubkey);

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
  async decrypt(encryptedObj, isSignaling = false, aadContext = null) {
    const key = isSignaling ? this.signalingKey : this.contentKey;
    if (!key) throw new Error('Clé de chiffrement non initialisée');

    let parsed = encryptedObj;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        throw new Error('Format de paquet chiffré invalide');
      }
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.iv || !parsed.ciphertext) {
      throw new Error('Structure chiffrée incomplète (iv ou ciphertext manquant)');
    }

    const iv = CryptoVault.hexToBuffer(parsed.iv);
    const ciphertext = CryptoVault.hexToBuffer(parsed.ciphertext);
    const additionalData = aadContext ? new TextEncoder().encode(typeof aadContext === 'string' ? aadContext : JSON.stringify(aadContext)) : undefined;

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
   * Chiffre un ArrayBuffer binaire (Chunk de Drive)
   */
  async encryptBinary(arrayBuffer) {
    const iv = this._generateDeterministicNonce();
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      this.contentKey,
      arrayBuffer
    );
    return { iv, ciphertext };
  }

  /**
   * Déchiffre un ArrayBuffer binaire
   */
  async decryptBinary(iv, ciphertext) {
    const ivBytes = iv instanceof Uint8Array ? iv : new Uint8Array(CryptoVault.hexToBuffer(iv));
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes, tagLength: 128 },
      this.contentKey,
      ciphertext
    );
  }

  /**
   * Sérialisation canonique conforme RFC 8785 (JSON Canonicalization Scheme - JCS)
   */
  static canonicalize(data, extraExcluded = []) {
    const excluded = new Set(['signature', ...extraExcluded]);

    function serialize(v, depth = 0) {
      if (v === null || typeof v !== 'object') {
        if (typeof v === 'number') {
          if (!Number.isFinite(v)) return 'null';
          if (Object.is(v, -0)) return '0';
          return JSON.stringify(v);
        }
        return JSON.stringify(v);
      }
      if (Array.isArray(v)) {
        return '[' + v.map((item) => (item === undefined ? 'null' : serialize(item, depth + 1))).join(',') + ']';
      }
      const keys = Object.keys(v)
        .filter((k) => (depth === 0 ? !excluded.has(k) : true) && v[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(v[k], depth + 1)).join(',') + '}';
    }

    return serialize(data, 0);
  }

  /**
   * Signe un objet ou une chaîne avec la clé privée ECDSA P-256
   */
  async sign(data, extraExcluded = []) {
    if (!this.signingKeyPair?.privateKey) throw new Error('Clé privée non disponible');
    const encoder = new TextEncoder();
    const payload = typeof data === 'string' ? data : CryptoVault.canonicalize(data, extraExcluded);
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      this.signingKeyPair.privateKey,
      encoder.encode(payload)
    );
    return CryptoVault.bufferToHex(signature);
  }

  /**
   * Vérifie la signature ECDSA d'un tiers
   */
  static async verify(data, signatureHex, publicKeyHex, extraExcluded = []) {
    try {
      if (!signatureHex || !publicKeyHex) return false;
      const pubKeyBuffer = CryptoVault.hexToBuffer(publicKeyHex);
      const pubKey = await crypto.subtle.importKey(
        'spki',
        pubKeyBuffer,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );

      const encoder = new TextEncoder();
      const payload = typeof data === 'string' ? data : CryptoVault.canonicalize(data, extraExcluded);
      const sigBuffer = CryptoVault.hexToBuffer(signatureHex);

      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        pubKey,
        sigBuffer,
        encoder.encode(payload)
      );
    } catch {
      return false;
    }
  }

  /**
   * Vérifie l'authenticité d'un objet signé avec contrôle de liaison d'identité (128-bit)
   */
  static async verifyObject(obj, { pubkeyField = 'authorPubkey', idField = 'authorId', excludeFields = [] } = {}) {
    if (!obj || typeof obj !== 'object') return false;
    const pubkey = obj[pubkeyField];
    const sig = obj.signature;
    if (!pubkey || !sig) return false;

    const okSig = await CryptoVault.verify(obj, sig, pubkey, excludeFields);
    if (!okSig) return false;

    if (idField && obj[idField]) {
      const expected = (await CryptoVault.hashSHA256(pubkey)).substring(0, 32);
      const claimed = String(obj[idField]).replace(/^peer_/, '').substring(0, 32);
      if (claimed !== expected.substring(0, claimed.length)) {
        logger.warn('Vault', 'Identité incohérente avec la clé publique (usurpation détectée)');
        return false;
      }
    }
    return true;
  }

  /**
   * Dérive un Numéro de Sécurité (Safety Number) commutatif (Signal style 5200 rounds SHA-512)
   */
  static async computeSafetyNumber(pubKeyA, pubKeyB) {
    if (!pubKeyA || !pubKeyB) throw new Error('Deux clés publiques sont requises');
    const [firstKey, secondKey] = [pubKeyA, pubKeyB].sort();
    const encoder = new TextEncoder();

    let currentBuffer = encoder.encode(`P2P_MESH_SAS_v1:${firstKey}:${secondKey}`);
    for (let i = 0; i < 5200; i++) {
      currentBuffer = await crypto.subtle.digest('SHA-512', currentBuffer);
    }

    const hashBytes = new Uint8Array(currentBuffer);

    // 12 blocs de 5 chiffres
    const chunks = [];
    for (let i = 0; i < 12; i++) {
      const offset = i * 4;
      const val =
        (((hashBytes[offset] << 24) |
          (hashBytes[offset + 1] << 16) |
          (hashBytes[offset + 2] << 8) |
          hashBytes[offset + 3]) >>>
          0) %
        100000;
      chunks.push(val.toString().padStart(5, '0'));
    }
    const numeric = `${chunks.slice(0, 6).join(' ')}\n${chunks.slice(6, 12).join(' ')}`;

    // 7 Emojis SAS
    const EMOJIS = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦟','🦗','🐢','🐍','🦎','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🦈','🐊','🐅','🐆','🦓','🦍','🐘','🦛','🦏','🐪','🐫'];
    const selectedEmojis = [];
    for (let i = 0; i < 7; i++) {
      selectedEmojis.push(EMOJIS[hashBytes[48 + i] % EMOJIS.length]);
    }

    return { numeric, emojis: selectedEmojis };
  }

  /**
   * Génère un Identicon vectoriel SVG 5x5 symétrique déterministe à partir du hash de la clé publique
   */
  static generateVisualFingerprint(pubKeyHex) {
    if (!pubKeyHex) return 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="%23666"/>';

    const bytes = [];
    for (let i = 0; i < Math.min(pubKeyHex.length, 32); i += 2) {
      bytes.push(parseInt(pubKeyHex.substr(i, 2), 16) || 0);
    }

    const hue = Math.floor(((bytes[0] || 0) * 360) / 255);
    const sat = 65 + ((bytes[1] || 0) % 30);
    const light = 45 + ((bytes[2] || 0) % 20);
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
    this.masterKey = null;
    this.signalingKey = null;
    this.contentKey = null;
    this.signingKeyPair = null;
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
