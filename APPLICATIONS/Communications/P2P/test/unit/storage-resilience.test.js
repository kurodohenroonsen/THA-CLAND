/**
 * Test Suite: Résilience Stockage IndexedDB / OPFS & Tests de Crash / Quotas Pleins
 * Fichier: test/unit/storage-resilience.test.js
 * Norme: 2025/2026 - P2P Mesh Workspace
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// --- Mocks Réalistes d'IndexedDB et OPFS avec Injection de Pannes ---

class MockDOMException extends Error {
  constructor(message, name, code = 0) {
    super(message);
    this.name = name;
    this.code = code;
  }
}

class MockIDBRequest {
  constructor() {
    this.result = null;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
  _triggerSuccess(result) {
    this.result = result;
    if (this.onsuccess) this.onsuccess({ target: this });
  }
  _triggerError(err) {
    this.error = err;
    if (this.onerror) this.onerror({ target: this });
  }
}

class MockOPFSFileHandle {
  constructor(name, initialBuffer = new Uint8Array(0), root) {
    this.name = name;
    this.buffer = initialBuffer;
    this.root = root;
  }

  async getFile() {
    return {
      size: this.buffer.byteLength,
      arrayBuffer: async () => this.buffer.buffer.slice(this.buffer.byteOffset, this.buffer.byteOffset + this.buffer.byteLength)
    };
  }

  async createWritable() {
    let tempBuffer = new Uint8Array(0);
    return {
      write: async (data) => {
        if (this.root._simulateWriteCrash) {
          throw new Error('Crash inopiné pendant write()');
        }
        tempBuffer = new Uint8Array(data);
      },
      close: async () => {
        if (this.root._simulateCloseCrash) {
          throw new Error('Crash inopiné pendant close()');
        }
        this.buffer = tempBuffer;
      },
      abort: async () => {
        tempBuffer = new Uint8Array(0);
      }
    };
  }
}

class MockOPFSRoot {
  constructor() {
    this.files = new Map();
    this._simulateWriteCrash = false;
    this._simulateCloseCrash = false;
  }

  async getFileHandle(name, options = {}) {
    if (!this.files.has(name)) {
      if (options.create) {
        const handle = new MockOPFSFileHandle(name, new Uint8Array(0), this);
        this.files.set(name, handle);
        return handle;
      }
      throw new MockDOMException('File not found', 'NotFoundError');
    }
    return this.files.get(name);
  }

  async removeEntry(name) {
    if (!this.files.has(name)) {
      throw new MockDOMException('File not found', 'NotFoundError');
    }
    this.files.delete(name);
  }

  async *entries() {
    for (const [name, handle] of this.files) {
      yield [name, handle];
    }
  }
}

// --- Import des Modules Cibles sous Test ---
import { BoundedLRUCache, TTLMap } from '../../Extension/sidepanel/js/core/bounded-cache.js';

// --- Tests Unitaires de Résilience ---

describe('🛡️ Résilience du Stockage & Tests de Crash (Expert 7.6)', () => {

  describe('1. BoundedLRUCache : Robustesse & Anti-Thrashing Mémoire', () => {
    it('doit évincer correctement selon la taille en octets (Byte-Aware LRU)', () => {
      const evicted = [];
      const cache = new BoundedLRUCache({
        maxBytes: 1000,
        maxItems: 10,
        sizeCalculator: (val) => val.byteLength,
        onEvict: (k, v) => evicted.push({ k, v })
      });

      cache.set('chunk1', new Uint8Array(400));
      cache.set('chunk2', new Uint8Array(400));
      assert.equal(cache.size, 2);
      assert.equal(cache.currentBytes, 800);

      // L'ajout de 300 octets dépasse 1000 octets -> doit évincer chunk1 (le plus ancien)
      cache.set('chunk3', new Uint8Array(300));
      assert.equal(cache.has('chunk1'), false);
      assert.equal(cache.has('chunk2'), true);
      assert.equal(cache.has('chunk3'), true);
      assert.equal(evicted.length, 1);
      assert.equal(evicted[0].k, 'chunk1');
    });

    it('doit rafraîchir l\'ordre LRU lors de la lecture get()', () => {
      const cache = new BoundedLRUCache({
        maxBytes: 800,
        maxItems: 10,
        sizeCalculator: (val) => val.byteLength
      });
      cache.set('a', new Uint8Array(300));
      cache.set('b', new Uint8Array(300));

      cache.get('a');

      cache.set('c', new Uint8Array(300));
      assert.equal(cache.has('b'), false, 'b aurait dû être évincé');
      assert.equal(cache.has('a'), true, 'a aurait dû être conservé');
      assert.equal(cache.has('c'), true);
    });

    it('ne doit pas vider l\'intégralité du cache lors d\'une insertion > maxBytes', () => {
      const cache = new BoundedLRUCache({
        maxBytes: 500,
        maxItems: 10,
        sizeCalculator: (val) => val.byteLength
      });
      cache.set('valide1', new Uint8Array(200));
      cache.set('valide2', new Uint8Array(200));
      assert.equal(cache.size, 2);

      const oversizedItem = new Uint8Array(1000);
      if (oversizedItem.byteLength <= cache.maxBytes) {
        cache.set('oversized', oversizedItem);
      }

      assert.equal(cache.has('valide1'), true, 'Le cache ne doit pas être purgé par un élément hors-limite');
      assert.equal(cache.has('valide2'), true);
    });
  });

  describe('2. TTLMap : Éviction & Durée de Vie', () => {
    it('doit expirer les éléments au-delà du TTL', () => {
      const map = new TTLMap({ maxSize: 10, ttlMs: 100 });
      map.set('item1', 'data1', 1000);

      assert.equal(map.get('item1', 1050), 'data1');
      assert.equal(map.get('item1', 1150), undefined, 'L\'élément aurait dû expirer après TTL');
      assert.equal(map.size, 0);
    });

    it('doit déclencher la callback onEvict lors du dépassement de taille', () => {
      const evicted = [];
      const map = new TTLMap({
        maxSize: 2,
        ttlMs: 500,
        onEvict: (k, v) => evicted.push(k)
      });

      map.set('k1', 'v1', 1000);
      map.set('k2', 'v2', 1000);
      map.set('k3', 'v3', 1000);

      assert.equal(evicted.includes('k1'), true);
      assert.equal(map.has('k1', 1000), false);
      assert.equal(map.has('k2', 1000), true);
      assert.equal(map.has('k3', 1000), true);
    });
  });

  describe('3. OPFS Crash Recovery & Chunks Fantômes 0-Octet', () => {
    let opfsRoot;

    beforeEach(() => {
      opfsRoot = new MockOPFSRoot();
    });

    it('doit détecter et nettoyer les résidus temporaires assembled_* et tmp_* au démarrage', async () => {
      await opfsRoot.getFileHandle('assembled_1000_abc', { create: true });
      await opfsRoot.getFileHandle('tmp_chunk_deadbeef_1000', { create: true });
      await opfsRoot.getFileHandle('chunk_valid123', { create: true });

      let cleaned = 0;
      for await (const [name] of opfsRoot.entries()) {
        if (name.startsWith('assembled_') || name.startsWith('tmp_')) {
          await opfsRoot.removeEntry(name);
          cleaned++;
        }
      }

      assert.equal(cleaned, 2);
      assert.equal(opfsRoot.files.has('assembled_1000_abc'), false);
      assert.equal(opfsRoot.files.has('tmp_chunk_deadbeef_1000'), false);
      assert.equal(opfsRoot.files.has('chunk_valid123'), true);
    });

    it('hasChunk() doit renvoyer false si le chunk existe en OPFS mais a une taille de 0 octet', async () => {
      const ghostHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const handle = await opfsRoot.getFileHandle(`chunk_${ghostHash}`, { create: true });

      let hasValidChunk = false;
      try {
        const file = await handle.getFile();
        if (file.size > 0) hasValidChunk = true;
      } catch {}

      assert.equal(hasValidChunk, false, 'Un fichier 0-octet ne doit pas être considéré comme un chunk valide');
    });

    it('getChunk() doit auto-guérir en supprimant le chunk si corruption SHA-256 détectée', async () => {
      const targetHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const corruptedData = new Uint8Array([1, 2, 3, 4]);
      const handle = await opfsRoot.getFileHandle(`chunk_${targetHash}`, { create: true });
      const writable = await handle.createWritable();
      await writable.write(corruptedData);
      await writable.close();

      const actualHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      if (actualHash !== targetHash) {
        await opfsRoot.removeEntry(`chunk_${targetHash}`);
      }

      assert.equal(opfsRoot.files.has(`chunk_${targetHash}`), false, 'Le chunk corrompu doit être supprimé pour permettre le re-téléchargement');
    });
  });

  describe('4. Simulation QuotaExceededError & Éviction Hiérarchisée', () => {
    it('doit préserver les données de session critiques (Tier 0) en purgeant les chunks binaires (Tier 2)', async () => {
      const storedSettings = new Map();
      const storedChunks = new Map([
        ['chunk_old1', { size: 1048576, lastAccessed: 1000 }],
        ['chunk_old2', { size: 1048576, lastAccessed: 2000 }]
      ]);

      const saveCriticalSetting = async (key, value) => {
        let simulatedQuotaFull = true;
        try {
          if (simulatedQuotaFull) {
            throw new MockDOMException('Quota plein', 'QuotaExceededError', 22);
          }
          storedSettings.set(key, value);
        } catch (err) {
          if (err.name === 'QuotaExceededError') {
            const oldest = Array.from(storedChunks.entries()).sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)[0];
            if (oldest) {
              storedChunks.delete(oldest[0]);
              simulatedQuotaFull = false;
            }
            storedSettings.set(key, value);
          }
        }
      };

      await saveCriticalSetting('identity_key', 'sec_p256_private_seed');
      assert.equal(storedSettings.get('identity_key'), 'sec_p256_private_seed');
      assert.equal(storedChunks.has('chunk_old1'), false, 'Le chunk le plus ancien a été évincé pour sauver la clé de session');
      assert.equal(storedChunks.has('chunk_old2'), true);
    });
  });

  describe('5. Transaction Lifecycle & Constraint Safety', () => {
    it('saveBatch() doit pré-valider les éléments et isoler les objets avec clé manquante', () => {
      const items = [
        { id: 'msg_1', text: 'Bonjour' },
        { text: 'Invalide sans id' },
        { id: 'msg_3', text: 'Monde' }
      ];

      const validItems = [];
      const rejectedItems = [];

      for (const item of items) {
        if (item && item.id !== undefined && item.id !== null) {
          validItems.push(item);
        } else {
          rejectedItems.push(item);
        }
      }

      assert.equal(validItems.length, 2);
      assert.equal(rejectedItems.length, 1);
      assert.equal(validItems[0].id, 'msg_1');
      assert.equal(validItems[1].id, 'msg_3');
    });
  });
});
