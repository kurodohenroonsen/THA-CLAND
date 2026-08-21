/**
 * Structures bornées anti-fuite-mémoire & anti-rejeu.
 *
 * L'audit a relevé plusieurs ensembles/maps à croissance illimitée
 * (processedOfferIds, activeOffers, incomingFragments, pendingChunkSlices)
 * exploitables en déni de service. Ces utilitaires imposent une capacité
 * maximale (éviction FIFO/LRU) et, optionnellement, une durée de vie (TTL).
 */

/**
 * Ensemble borné à éviction FIFO. Sert de cache anti-rejeu / anti-doublon
 * (offer_id, nonces de messages) sans jamais dépasser `maxSize` entrées.
 */
export class BoundedSet {
  constructor(maxSize = 5000) {
    this.maxSize = maxSize;
    this._set = new Set();
  }

  /** Renvoie true si `key` est nouveau (et l'enregistre), false s'il a déjà été vu. */
  addIfNew(key) {
    if (this._set.has(key)) return false;
    this._set.add(key);
    if (this._set.size > this.maxSize) {
      // Évince l'entrée la plus ancienne (ordre d'insertion garanti par Set).
      const oldest = this._set.values().next().value;
      this._set.delete(oldest);
    }
    return true;
  }

  has(key) { return this._set.has(key); }
  get size() { return this._set.size; }
  clear() { this._set.clear(); }
}

/**
 * Map bornée avec TTL. Les entrées expirent après `ttlMs` et la taille est
 * plafonnée à `maxSize` (éviction de la plus ancienne). Un balayage périodique
 * purge les entrées expirées (par ex. offres SDP jamais répondues, fragments
 * partiels jamais complétés).
 */
export class TTLMap {
  constructor({ maxSize = 2000, ttlMs = 60000, onEvict = null } = {}) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.onEvict = onEvict;
    this._map = new Map(); // key -> { value, expiresAt }
  }

  set(key, value, nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    if (this._map.size >= this.maxSize && !this._map.has(key)) {
      const oldestKey = this._map.keys().next().value;
      this._evict(oldestKey);
    }
    this._map.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  get(key, nowMs) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    if (entry.expiresAt <= now) {
      this._evict(key);
      return undefined;
    }
    return entry.value;
  }

  has(key, nowMs) { return this.get(key, nowMs) !== undefined; }

  delete(key) { return this._map.delete(key); }

  _evict(key) {
    const entry = this._map.get(key);
    this._map.delete(key);
    if (entry && this.onEvict) {
      try { this.onEvict(key, entry.value); } catch {}
    }
  }

  /** Purge toutes les entrées expirées. À appeler périodiquement. */
  sweep(nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    for (const [key, entry] of this._map) {
      if (entry.expiresAt <= now) this._evict(key);
    }
  }

  get size() { return this._map.size; }
  entries() { return this._map.entries(); }
  keys() { return this._map.keys(); }
  clear() { this._map.clear(); }
}
