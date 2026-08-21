/**
 * @file secure-memory-sanitizer.js
 * @description Module Universel d'Hygiène Mémoire, Zeroization Multi-Passe & Anti-DCE (Pass 4 - 2026)
 * Normes : W3C WebCrypto, NIST SP 800-88 Rev 1, CWE-14, CWE-226, Libsodium memzero pattern.
 */

export class SecureMemorySanitizer {
  /**
   * Barrière de lecture volatile globale servant d'accumulateur anti-DCE
   * @private
   */
  static _volatileSink = 0;

  /**
   * Obtient une vue Uint8Array exacte en préservant scrupuleusement les offsets et tailles
   * @param {ArrayBufferView|ArrayBuffer} target
   * @returns {Uint8Array|null}
   */
  static getExactUint8View(target) {
    if (!target) return null;
    if (target instanceof Uint8Array) return target;
    if (ArrayBuffer.isView(target)) {
      return new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
    }
    if (target instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && target instanceof SharedArrayBuffer)) {
      return new Uint8Array(target);
    }
    return null;
  }

  /**
   * Écrasement Zéro-Trace Multi-Passe avec Prévention d'Élimination de Code Mort (Anti-DCE)
   * 1. Passe 1 : Remplissage aléatoire CSPRNG
   * 2. Passe 2 : Inversion bit-à-bit (Masque de basculement 0xFF)
   * 3. Passe 3 : Zeroization stricte (0x00)
   * 4. Passe 4 : Barrière de lecture volatile empêchant l'optimisation TurboFan
   * 
   * @param {ArrayBufferView|ArrayBuffer} target - Tampon ou vue à détruire
   * @returns {boolean} true si l'écrasement a été exécuté avec succès
   */
  static wipe(target) {
    const view = SecureMemorySanitizer.getExactUint8View(target);
    if (!view || view.byteLength === 0) return false;

    try {
      const len = view.length;

      // Passe 1 : Bruit aléatoire CSPRNG
      if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(view);
      }

      // Passe 2 : Inversion bit-à-bit
      for (let i = 0; i < len; i++) {
        view[i] = view[i] ^ 0xff;
      }

      // Passe 3 : Zeroization finale
      view.fill(0);

      // Passe 4 : Barrière de lecture volatile Anti-DCE (empêche TurboFan de supprimer les passes 1-3)
      let checksum = 0;
      for (let i = 0; i < len; i++) {
        checksum |= view[i];
      }
      SecureMemorySanitizer._volatileSink ^= checksum;

      return checksum === 0;
    } catch {
      // Échec silencieux si le tampon est détaché ou verrouillé
      return false;
    }
  }

  /**
   * Détruit simultanément une liste de tampons ou d'objets contenant des tampons
   * @param {...(ArrayBufferView|ArrayBuffer|null|undefined)} targets
   */
  static wipeAll(...targets) {
    for (const t of targets) {
      if (t) SecureMemorySanitizer.wipe(t);
    }
  }

  /**
   * Pattern RAII : Alloue un tampon temporaire, exécute le traitement et garantit la destruction
   * @template T
   * @param {number|Uint8Array} sizeOrArray - Taille en octets ou tampon existant
   * @param {(buf: Uint8Array) => Promise<T>|T} callback - Fonction traitant le secret
   * @returns {Promise<T>}
   */
  static async withSecureBuffer(sizeOrArray, callback) {
    const buf = typeof sizeOrArray === 'number' ? new Uint8Array(sizeOrArray) : sizeOrArray;
    try {
      return await callback(buf);
    } finally {
      SecureMemorySanitizer.wipe(buf);
    }
  }

  /**
   * Pattern Scope Sécurisé : Enregistre et nettoie tous les tampons déclarés dans un bloc
   * @template T
   * @param {(scope: SecureScope) => Promise<T>|T} scopeRunner
   * @returns {Promise<T>}
   */
  static async withSecureScope(scopeRunner) {
    const scope = new SecureScope();
    try {
      return await scopeRunner(scope);
    } finally {
      scope.dispose();
    }
  }

  /**
   * Assainit un élément de saisie DOM (input password/text) pour limiter la rétention
   * @param {HTMLInputElement} inputEl
   */
  static sanitizeDOMInput(inputEl) {
    if (!inputEl) return;
    try {
      inputEl.value = '';
      inputEl.setAttribute('value', '');
      if (inputEl.defaultValue) inputEl.defaultValue = '';
      inputEl.blur();
    } catch {}
  }
}

/**
 * Conteneur RAII pour la gestion groupée de buffers éphémères
 */
export class SecureScope {
  constructor() {
    this._trackedBuffers = new Set();
    this._isDisposed = false;
  }

  /**
   * Alloue un nouveau Uint8Array tracké par le scope
   * @param {number} byteLength
   * @returns {Uint8Array}
   */
  alloc(byteLength) {
    if (this._isDisposed) throw new Error('SecureScope déjà détruit');
    const buf = new Uint8Array(byteLength);
    this._trackedBuffers.add(buf);
    return buf;
  }

  /**
   * Enregistre un tampon existant pour destruction à la sortie du scope
   * @template {ArrayBufferView|ArrayBuffer} T
   * @param {T} target
   * @returns {T}
   */
  track(target) {
    if (target && !this._isDisposed) {
      this._trackedBuffers.add(target);
    }
    return target;
  }

  /**
   * Détruit l'intégralité des tampons trackés
   */
  dispose() {
    if (this._isDisposed) return;
    for (const buf of this._trackedBuffers) {
      SecureMemorySanitizer.wipe(buf);
    }
    this._trackedBuffers.clear();
    this._isDisposed = true;
  }
}

/**
 * Wrapper révocable pour CryptoKey avec traçabilité du cycle de vie
 */
export class RevocableCryptoKey {
  /**
   * @param {CryptoKey} rawKey
   * @param {string} [alias='unnamed_key']
   */
  constructor(rawKey, alias = 'unnamed_key') {
    this._rawKey = rawKey;
    this._alias = alias;
    this._isRevoked = false;
    this._createdAt = Date.now();
  }

  /**
   * Clé brute sous-jacente
   * @returns {CryptoKey}
   */
  get key() {
    if (this._isRevoked || !this._rawKey) {
      throw new Error(`Accès refusé : La clé "${this._alias}" a été révoquée (Memory Scrubbing)`);
    }
    return this._rawKey;
  }

  get isRevoked() {
    return this._isRevoked;
  }

  /**
   * Révoque et déréférence la clé pour libération immédiate par le GC
   */
  revoke() {
    this._rawKey = null;
    this._isRevoked = true;
  }
}
