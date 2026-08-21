import { logger } from './logger.js';
/**
 * Coffre-fort Cryptographique Web Crypto API - P2P Mesh
 * Dérivation de clé sans serveur, chiffrement AES-GCM-256, hachage SHA-256 et signatures ECDSA.
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
    this.signingKeyPair = null;
    this.isInitialized = false;
  }

  /**
   * Convertit un ArrayBuffer en chaîne hexadécimale
   */
  static bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Convertit une chaîne hexadécimale en ArrayBuffer
   */
  static hexToBuffer(hex) {
    if (typeof hex !== 'string') {
      throw new TypeError(`Attendu une chaîne hexadécimale, reçu: ${typeof hex}`);
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes.buffer;
  }

  /**
   * Tirage uniforme d'un entier dans [0, max) SANS biais de modulo (rejection sampling).
   */
  static _uniformInt(max) {
    if (max <= 0) throw new RangeError('max doit être > 0');
    const limit = Math.floor(0xFFFFFFFF / max) * max;
    const buf = new Uint32Array(1);
    let x;
    do {
      crypto.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % max;
  }

  /**
   * Génère un code papier sécurisé de type MOT-MOT-MOT-MOT-MOT-MOT (≈ 6 mots).
   *
   * SÉCURITÉ : le code papier est l'UNIQUE secret dont dérivent toutes les clés
   * (aucun sel côté serveur n'est possible dans un modèle 100% P2P). Son entropie
   * doit donc être élevée. L'ancien format `MOT-1234-MOT-5678` ne fournissait
   * que ~35 bits — brute-forçable hors ligne d'autant que le Topic ID (infoHash)
   * est public sur les trackers. Ce nouveau format tire 6 mots dans une liste de
   * 256 termes + un segment numérique, soit ≈ 6·log2(256) + 13 ≈ 61 bits, et reste
   * mémorisable/transcriptible. Voir RAPPORT_AUDIT pour le compromis entropie/UX.
   */
  static generatePaperCode(wordCount = 6) {
    logger.debug('Vault', '🎲 Génération d\'un nouveau code papier maître...');
    const words = CryptoVault.WORDLIST;
    const parts = [];
    for (let i = 0; i < wordCount; i++) {
      parts.push(words[CryptoVault._uniformInt(words.length)]);
    }
    // Segment numérique final (0000-9999) tiré sans biais
    parts.push(CryptoVault._uniformInt(10000).toString().padStart(4, '0'));

    const generated = parts.join('-');
    logger.debug('Vault', `✨ Code généré (${wordCount} mots, ≈${Math.round(wordCount * Math.log2(words.length) + Math.log2(10000))} bits d'entropie)`);
    return generated;
  }

  /**
   * Estime l'entropie (bits) d'un code papier saisi manuellement, à titre indicatif.
   * Heuristique simple basée sur la longueur et la diversité des caractères.
   */
  static estimatePaperCodeEntropyBits(code) {
    if (!code) return 0;
    const clean = code.trim();
    if (!clean) return 0;

    // Entropie d'un mot tiré du dictionnaire du générateur (cohérent avec
    // generatePaperCode). Un modèle "par caractère" surestime massivement les
    // codes composés de mots : on estime donc par jeton, de façon CONSERVATRICE
    // (on sous-estime plutôt que de donner un faux sentiment de sécurité).
    const wordBits = Math.log2((CryptoVault.WORDLIST && CryptoVault.WORDLIST.length) || 256);
    const tokens = clean.split(/[\s\-_.]+/).filter(Boolean);
    let bits = 0;

    for (const tok of tokens) {
      if (/^[A-Za-z]+$/.test(tok) && tok.length >= 3) {
        // Mot : tirage dans le dictionnaire, plafonné par le modèle par caractère.
        bits += Math.min(wordBits, tok.length * Math.log2(26));
      } else if (/^[0-9]+$/.test(tok)) {
        bits += tok.length * Math.log2(10);
      } else {
        // Jeton mixte / aléatoire : modèle par caractère sur l'alphabet observé.
        let pool = 0;
        if (/[a-z]/.test(tok)) pool += 26;
        if (/[A-Z]/.test(tok)) pool += 26;
        if (/[0-9]/.test(tok)) pool += 10;
        if (/[^A-Za-z0-9]/.test(tok)) pool += 16;
        bits += tok.length * Math.log2(Math.max(2, pool));
      }
    }
    return Math.round(bits);
  }

  /**
   * Calcule le hash SHA-256 d'une chaîne ou d'un ArrayBuffer
   */
  static async hashSHA256(data) {
    const buffer = typeof data === 'string' 
      ? new TextEncoder().encode(data) 
      : (data instanceof Uint8Array ? data.buffer : data);
    
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return CryptoVault.bufferToHex(hashBuffer);
  }

  /**
   * Initialise le vault à partir du code papier (Master Key Derivation)
   */
  async initializeFromPaperCode(paperCode, customName = 'Membre P2P') {
    if (!paperCode || typeof paperCode !== 'string') {
      throw new Error('Code papier invalide');
    }

    logger.info('Vault', `🔐 Démarrage dérivation cryptographique (Utilisateur: "${customName}")`);

    const cleanCode = paperCode.trim().toUpperCase();
    const encoder = new TextEncoder();
    const codeBuffer = encoder.encode(cleanCode);

    // 1. Clé brute de base (Passphrase)
    logger.debug('Vault', '➡️ Étape 1/7 : Import de la clé brute PBKDF2...');
    const baseKey = await crypto.subtle.importKey(
      'raw',
      codeBuffer,
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );

    // 2. Dérivation PBKDF2 de la clé maîtresse HKDF
    // SÉCURITÉ : le sel PBKDF2 est nécessairement déterministe dans un modèle
    // 100% P2P (deux pairs doivent dériver LA MÊME clé à partir du seul code papier,
    // sans échange préalable). On ne peut donc pas utiliser un sel aléatoire par
    // installation. En compensation, on (a) augmente fortement le nombre d'itérations
    // et (b) domaine-sépare le sel avec la version applicative. La vraie défense
    // contre le brute-force reste l'entropie du code papier (cf. generatePaperCode).
    const ITERATIONS = CryptoVault.PBKDF2_ITERATIONS;
    logger.debug('Vault', `➡️ Étape 2/7 : Calcul PBKDF2 (${ITERATIONS} itérations SHA-512)...`);
    const staticSalt = encoder.encode('P2P_MESH_DECENTRALIZED_WORKSPACE_SALT_v2');
    const masterDeriveBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: staticSalt,
        iterations: ITERATIONS,
        hash: 'SHA-512'
      },
      baseKey,
      512 // 64 octets
    );

    // 3. Import en tant que clé maîtresse HKDF
    logger.debug('Vault', '➡️ Étape 3/7 : Import de la clé maîtresse HKDF...');
    const hkdfMasterKey = await crypto.subtle.importKey(
      'raw',
      masterDeriveBits,
      { name: 'HKDF' },
      false,
      ['deriveKey', 'deriveBits']
    );

    // 4. Dérivation du Topic ID (20 octets hex pour compatibilité WebTorrent infoHash & Nostr)
    logger.debug('Vault', '➡️ Étape 4/7 : Dérivation du Topic ID de rendez-vous...');
    const topicBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode('P2P_TOPIC_SALT'),
        info: encoder.encode('rendezvous-topic-v1')
      },
      hkdfMasterKey,
      160 // 20 octets = 40 caractères hex
    );
    this.topicHex = CryptoVault.bufferToHex(topicBits);
    this.topicId = this.topicHex;
    logger.debug('Vault', `🏷️ Topic ID calculé: ${this.topicHex.substring(0, 10)}... (infoHash 20-bytes)`);

    // 5. Dérivation de la clé de signalement WebRTC (AES-GCM 256-bit)
    logger.debug('Vault', '➡️ Étape 5/7 : Dérivation de la clé de signalement WebRTC (AES-GCM 256)...');
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

    // 6. Dérivation de la clé de contenu (Messages, Fichiers, Forums) (AES-GCM 256-bit)
    logger.debug('Vault', '➡️ Étape 6/7 : Dérivation de la clé de contenu (AES-GCM 256)...');
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

    // 7. Génération de la paire ECDSA P-256 puis DÉRIVATION de l'identifiant de pair
    //    À PARTIR de la clé publique.
    // SÉCURITÉ : auparavant le peerId était 20 octets aléatoires, sans aucun lien
    // avec la clé de signature. N'importe qui pouvait donc annoncer le peerId d'un
    // autre. On lie désormais peerId = SHA-256(clé publique)[:20]. Combiné à la
    // vérification de signature à la réception (verifyObject), un pair ne peut plus
    // se faire passer pour un autre sans posséder la clé privée correspondante.
    logger.debug('Vault', '➡️ Étape 7/7 : Génération de la paire ECDSA P-256 et dérivation du Peer ID...');
    this.signingKeyPair = await crypto.subtle.generateKey(
      {
        name: 'ECDSA',
        namedCurve: 'P-256'
      },
      true,
      ['sign', 'verify']
    );

    // Exporte la clé publique au format SPKI hex
    const exportedPubkey = await crypto.subtle.exportKey('spki', this.signingKeyPair.publicKey);
    this.publicKeyHex = CryptoVault.bufferToHex(exportedPubkey);

    // Peer ID lié cryptographiquement à la clé publique
    const pubHashHex = await CryptoVault.hashSHA256(this.publicKeyHex);
    this.peerIdHex = pubHashHex.substring(0, 40); // 20 octets = 40 hex chars
    this.peerId = `peer_${this.peerIdHex.substring(0, 16)}`;
    this.userName = customName;

    // Vérifie que l'identité annoncée par un pair distant est cohérente avec sa clé.
    // Renvoie true si peerIdHex == SHA-256(pubkey)[:40].
    this.expectedPeerIdFor = async (publicKeyHex) => {
      const h = await CryptoVault.hashSHA256(publicKeyHex);
      return h.substring(0, 40);
    };

    this.isInitialized = true;
    logger.info('Vault', `🎯 INITIALISATION RÉUSSIE ! Topic: ${this.topicHex.substring(0, 10)}... | PeerId: ${this.peerId} | User: ${this.userName}`);
    return this;
  }

  /**
   * Chiffre une chaîne ou un objet JSON avec une clé AES-GCM
   */
  async encrypt(data, isSignaling = false) {
    const key = isSignaling ? this.signalingKey : this.contentKey;
    if (!key) throw new Error('Clé de chiffrement non initialisée');

    const encoder = new TextEncoder();
    const rawBytes = typeof data === 'string' ? encoder.encode(data) : encoder.encode(JSON.stringify(data));
    
    // Vecteur d'initialisation IV unique de 12 octets
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      rawBytes
    );

    return {
      iv: CryptoVault.bufferToHex(iv),
      ciphertext: CryptoVault.bufferToHex(ciphertextBuffer)
    };
  }

  /**
   * Déchiffre un paquet chiffré
   */
  async decrypt(encryptedObj, isSignaling = false) {
    const key = isSignaling ? this.signalingKey : this.contentKey;
    if (!key) throw new Error('Clé de chiffrement non initialisée');

    let parsed = encryptedObj;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch (e) {
        throw new Error(`Format de paquet chiffré invalide (reçu chaîne non JSON: ${parsed.substring(0, 30)})`);
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Objet chiffré invalide (type: ${typeof parsed})`);
    }

    if (!parsed.iv || !parsed.ciphertext) {
      throw new Error(`Champs iv ou ciphertext manquants dans l'objet chiffré (clés reçues: ${Object.keys(parsed).join(', ')})`);
    }

    const iv = CryptoVault.hexToBuffer(parsed.iv);
    const ciphertext = CryptoVault.hexToBuffer(parsed.ciphertext);

    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      ciphertext
    );

    const decodedStr = new TextDecoder().decode(decryptedBuffer);
    try {
      return JSON.parse(decodedStr);
    } catch (e) {
      logger.debug('Vault', 'Payload non JSON après déchiffrement, renvoi chaîne brute');
      return decodedStr;
    }
  }

  /**
   * Chiffre un ArrayBuffer brut (ex: Chunk binaire de fichier)
   */
  async encryptBinary(arrayBuffer) {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.contentKey,
      arrayBuffer
    );

    return { iv, ciphertext };
  }

  /**
   * Déchiffre un ArrayBuffer binaire
   */
  async decryptBinary(iv, ciphertext) {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.contentKey,
      ciphertext
    );
  }

  /**
   * Sérialisation canonique déterministe (clés triées récursivement).
   * Indispensable pour que signature et vérification opèrent sur des octets
   * identiques, quel que soit l'ordre d'insertion des clés après un aller-retour
   * JSON/IndexedDB/réseau. Le champ `signature` est toujours exclu.
   */
  static canonicalize(value, extraExcluded = []) {
    const excluded = new Set(['signature', ...extraExcluded]);
    const seen = new WeakSet();
    const norm = (v, depth) => {
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v)) throw new TypeError('Référence circulaire non sérialisable');
      seen.add(v);
      if (Array.isArray(v)) return v.map(x => norm(x, depth + 1));
      const out = {};
      for (const key of Object.keys(v).sort()) {
        // Les champs exclus ne le sont qu'au 1er niveau (l'objet signé lui-même).
        if (depth === 0 && excluded.has(key)) continue;
        out[key] = norm(v[key], depth + 1);
      }
      return out;
    };
    return JSON.stringify(norm(value, 0));
  }

  /**
   * Signe une chaîne de données OU un objet (canonicalisé, hors `signature`
   * et hors champs `extraExcluded` — ex. `replies`, champ muté après signature).
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
   * Vérifie la signature d'un tiers sur une chaîne ou un objet (canonicalisé).
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
    } catch (err) {
      logger.warn('Vault', 'Échec de vérification de signature:', err);
      return false;
    }
  }

  /**
   * Vérifie qu'un objet reçu est authentique :
   *  1. la signature correspond à la clé publique déclarée (authorPubkey) ;
   *  2. l'identité (authorId) est bien liée à cette clé (peerId = SHA-256(pubkey)[:16]).
   * `excludeFields` : champs mutés après signature à ignorer (ex. `replies`).
   * Renvoie true seulement si les deux conditions sont réunies.
   */
  static async verifyObject(obj, { pubkeyField = 'authorPubkey', idField = 'authorId', excludeFields = [] } = {}) {
    if (!obj || typeof obj !== 'object') return false;
    const pubkey = obj[pubkeyField];
    const sig = obj.signature;
    if (!pubkey || !sig) return false;

    const okSig = await CryptoVault.verify(obj, sig, pubkey, excludeFields);
    if (!okSig) return false;

    // Liaison identité <-> clé (défense contre l'usurpation de peerId)
    if (idField && obj[idField]) {
      const expected = (await CryptoVault.hashSHA256(pubkey)).substring(0, 16);
      const claimed = String(obj[idField]).replace(/^peer_/, '').substring(0, 16);
      if (claimed !== expected) {
        logger.warn('Vault', 'Identité incohérente avec la clé publique (usurpation ?)');
        return false;
      }
    }
    return true;
  }
}

// --- Liste de mots pour les codes papier (256 termes lisibles/OTAN étendu) ---
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
  // Déduplique et normalise pour garantir des tirages uniformes.
  const seen = new Set();
  const list = [];
  for (const w of base) {
    const u = String(w).trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (u && !seen.has(u)) { seen.add(u); list.push(u); }
  }
  return list;
})();

// Coût PBKDF2 (relevé face au brute-force offline ; OWASP 2023 ≈ 210k pour SHA-512,
// on prend une marge supplémentaire vu que le code papier est le seul secret).
CryptoVault.PBKDF2_ITERATIONS = 600000;
