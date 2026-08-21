import { logger } from './logger.js';

/**
 * Structures de Caches Bornés Anti-Fuite Mémoire & Anti-OOM (2025/2026).
 *
 * Implémente :
 * 1. BoundedSet (Anti-rejeu et déduplication de nonces/messages)
 * 2. TTLMap (Map avec durée de vie et éviction automatique)
 * 3. BoundedLRUCache (Cache LRU pondéré en octets avec double contrainte maxItems / maxBytes)
 */

/**
 * Ensemble borné à éviction FIFO / LRU pour déduplication (Offer IDs, Message IDs).
 */
export class BoundedSet {
  constructor(maxSize = 5000) {
    this.maxSize = maxSize;
    this._set = new Set();
  }

  addIfNew(key) {
    if (this._set.has(key)) return false;
    this._set.add(key);
    if (this._set.size > this.maxSize) {
      const oldest = this._set.values().next().value;
      this._set.delete(oldest);
    }
    return true;
  }

  has(key) { return this._set.has(key); }
  delete(key) { return this._set.delete(key); }
  get size() { return this._set.size; }
  clear() { this._set.clear(); }
}

/**
 * Map bornée avec TTL et éviction LRU.
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
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this.maxSize) {
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
    // LRU Refresh: déplace la clé à la fin de la Map
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  has(key, nowMs) { return this.get(key, nowMs) !== undefined; }

  delete(key) { return this._map.delete(key); }

  _evict(key) {
    const entry = this._map.get(key);
    this._map.delete(key);
    if (entry && this.onEvict) {
      try { this.onEvict(key, entry.value); } catch (err) { logger.warn('Cache', 'Erreur callback onEvict:', err); }
    }
  }

  sweep(nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    for (const [key, entry] of this._map) {
      if (entry.expiresAt <= now) this._evict(key);
    }
  }

  get size() { return this._map.size; }
  entries() { return this._map.entries(); }
  keys() { return this._map.keys(); }
  clear() {
    if (this.onEvict) {
      for (const [key, entry] of this._map) {
        try { this.onEvict(key, entry.value); } catch {}
      }
    }
    this._map.clear();
  }
}

/**
 * Cache LRU Avancé pondéré en octets (Byte-Aware) pour Médias, Chunks et Payloads lourds.
 */
export class BoundedLRUCache {
  constructor({
    maxItems = 1000,
    maxBytes = 64 * 1024 * 1024, // 64 Mo par défaut
    ttlMs = 0, // 0 = pas d'expiration par TTL (LRU pur)
    sizeCalculator = null,
    onEvict = null
  } = {}) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.onEvict = onEvict;
    this.sizeCalculator = sizeCalculator || ((val) => {
      if (!val) return 0;
      if (val.byteLength) return val.byteLength;
      if (val.size) return val.size;
      if (typeof val === 'string') return val.length * 2;
      return 128;
    });
    this._map = new Map(); // key -> { value, size, expiresAt }
    this._currentBytes = 0;
  }

  set(key, value, customTtlMs = null) {
    const now = Date.now();
    const ttl = customTtlMs ?? this.ttlMs;
    const size = this.sizeCalculator(value);

    if (this._map.has(key)) {
      const old = this._map.get(key);
      this._currentBytes -= old.size;
      this._map.delete(key);
    }

    // Éviction progressive si seuil d'items ou de mémoire dépassé
    while (this._map.size >= this.maxItems || (this._currentBytes + size > this.maxBytes && this._map.size > 0)) {
      const oldestKey = this._map.keys().next().value;
      this._evict(oldestKey);
    }

    this._map.set(key, {
      value,
      size,
      expiresAt: ttl > 0 ? now + ttl : Infinity
    });
    this._currentBytes += size;
    return value;
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this._evict(key);
      return undefined;
    }
    // LRU Refresh: déplace la clé à la fin de la Map (le plus récemment accédé)
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  has(key) { return this.get(key) !== undefined; }

  delete(key) {
    if (this._map.has(key)) {
      this._evict(key);
      return true;
    }
    return false;
  }

  _evict(key) {
    const entry = this._map.get(key);
    if (!entry) return;
    this._map.delete(key);
    this._currentBytes = Math.max(0, this._currentBytes - entry.size);
    if (this.onEvict) {
      try { this.onEvict(key, entry.value); } catch (e) { logger.warn('Cache', 'Erreur onEvict:', e); }
    }
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this._map) {
      if (entry.expiresAt <= now) this._evict(key);
    }
  }

  clear() {
    if (this.onEvict) {
      for (const [key, entry] of this._map) {
        try { this.onEvict(key, entry.value); } catch {}
      }
    }
    this._map.clear();
    this._currentBytes = 0;
  }

  get size() { return this._map.size; }
  get currentBytes() { return this._currentBytes; }
}

/**
 * Cache de déduplication multi-générationnel glissant (2025/2026).
 * Évite le GC thrashing et élimine les tempêtes d'écho en P2P.
 */
export class GenerationalSlidingCache {
  constructor({ generationSize = 20000, rotateIntervalMs = 90000 } = {}) {
    this.generationSize = generationSize;
    this.rotateIntervalMs = rotateIntervalMs;
    this.generations = [new Set(), new Set(), new Set()]; // [Current, Previous, Old]
    this.timer = setInterval(() => this.rotate(), this.rotateIntervalMs);
  }

  addIfNew(key) {
    if (this.has(key)) return false;
    if (this.generations[0].size >= this.generationSize) {
      this.rotate();
    }
    this.generations[0].add(key);
    return true;
  }

  has(key) {
    return this.generations[0].has(key) ||
           this.generations[1].has(key) ||
           this.generations[2].has(key);
  }

  rotate() {
    this.generations.pop();
    this.generations.unshift(new Set());
  }

  get size() {
    return this.generations[0].size + this.generations[1].size + this.generations[2].size;
  }

  clear() {
    this.generations = [new Set(), new Set(), new Set()];
  }

  destroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clear();
  }
}

/**
 * Enveloppe de diffusion épidémique Gossip (GossipEnvelope).
 * Prévention proactive des boucles et limitation du rayon de diffusion (TTL/Hops).
 */
export class GossipEnvelope {
  static wrap(type, payload, originPeerId, ttl = 8) {
    return {
      _gspId: `gsp_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`,
      _type: type,
      _origin: originPeerId,
      _hops: 0,
      _ttl: ttl,
      _path: [originPeerId],
      _time: Date.now(),
      payload
    };
  }

  static shouldRelay(env, localPeerId, targetPeerId, maxHops = 10) {
    if (!env || typeof env._ttl !== 'number' || env._ttl <= 1) return false;
    if (env._hops >= maxHops) return false;
    if (Array.isArray(env._path) && env._path.includes(targetPeerId)) return false;
    return true;
  }

  static advance(env, localPeerId) {
    return {
      ...env,
      _hops: (env._hops || 0) + 1,
      _ttl: Math.max(0, (env._ttl || 8) - 1),
      _path: Array.isArray(env._path) ? [...env._path, localPeerId] : [localPeerId]
    };
  }
}
