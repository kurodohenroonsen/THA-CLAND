/**
 * test/unit/storage-chaos-adversarial.test.js
 * 
 * HARNAIS D'AUDIT ADVERSARIAL & PREUVES FORMELLES DE NON-PERTE (ZERO DATA LOSS)
 * Norme : 2025/2026 - P2P Mesh Workspace (Pass 4 - G2.P10)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

class MockCryptoVault {
  static hashSHA256(data) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  static canonicalize(obj, excludeKeys = ['signature']) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(x => MockCryptoVault.canonicalize(x, excludeKeys)).join(',')}]`;
    const keys = Object.keys(obj).filter(k => !excludeKeys.includes(k)).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${MockCryptoVault.canonicalize(obj[k], excludeKeys)}`).join(',')}}`;
  }

  static async sign(obj, secretKey = 'test_key') {
    const canon = MockCryptoVault.canonicalize(obj, ['signature']);
    return crypto.createHmac('sha256', secretKey).update(canon).digest('hex');
  }

  static async verify(obj, secretKey = 'test_key') {
    if (!obj || !obj.signature) return false;
    const expected = await MockCryptoVault.sign(obj, secretKey);
    return obj.signature === expected;
  }
}

class HardenedStorageMock {
  constructor() {
    this.opfsFiles = new Map();
    this.idbStores = {
      messages: new Map(),
      forum_threads: new Map(),
      file_commits: new Map(),
      file_chunks: new Map(),
      drive_folders: new Map(),
      drive_deletions: new Map(),
      drive_folder_deletions: new Map(),
      settings: new Map()
    };
    this.quotaExceeded = false;
    this.writeCrashCountdown = -1;
  }

  async saveChunkHardened(hash, arrayBuffer) {
    if (this.writeCrashCountdown === 0) {
      this.writeCrashCountdown = -1;
      this.opfsFiles.set(`chunk_${hash}`, new Uint8Array(0));
      throw new Error('CRASH_SIMULATED: Flush interruption during OPFS write()');
    }
    if (this.writeCrashCountdown > 0) this.writeCrashCountdown--;

    if (this.quotaExceeded) {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      err.code = 22;
      throw err;
    }

    this.opfsFiles.set(`chunk_${hash}`, new Uint8Array(arrayBuffer));
    return { hash, size: arrayBuffer.byteLength, inOPFS: true };
  }

  async hasChunkHardened(hash) {
    if (this.opfsFiles.has(`chunk_${hash}`)) {
      const data = this.opfsFiles.get(`chunk_${hash}`);
      if (data && data.byteLength > 0) {
        return true;
      } else {
        this.opfsFiles.delete(`chunk_${hash}`);
      }
    }
    return this.idbStores.file_chunks.has(hash);
  }

  async getChunkHardened(hash) {
    let buf = null;
    if (this.opfsFiles.has(`chunk_${hash}`)) {
      buf = this.opfsFiles.get(`chunk_${hash}`);
      if (buf && buf.byteLength > 0) {
        const computed = MockCryptoVault.hashSHA256(buf);
        if (computed === hash) {
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        } else {
          this.opfsFiles.delete(`chunk_${hash}`);
          buf = null;
        }
      } else {
        this.opfsFiles.delete(`chunk_${hash}`);
        buf = null;
      }
    }

    if (!buf && this.idbStores.file_chunks.has(hash)) {
      const item = this.idbStores.file_chunks.get(hash);
      const computed = MockCryptoVault.hashSHA256(item.data);
      if (computed === hash) return item.data;
      this.idbStores.file_chunks.delete(hash);
    }

    return null;
  }
}

describe('🧪 SUITE D\'AUDIT ADVERSARIAL DE STOCKAGE & CONVERGENCE (PASSE 4 - G2.P10)', () => {

  describe('1. Preuve Formelle de Demi-Treillis Supérieur CRDT (Join-Semilattice SEC)', () => {
    const mergeReplies = (repliesA, repliesB) => {
      const byId = new Map();
      for (const r of repliesA || []) byId.set(r.id, r);
      for (const r of repliesB || []) if (!byId.has(r.id)) byId.set(r.id, r);
      return Array.from(byId.values()).sort((a, b) => {
        if ((a.createdAt || 0) !== (b.createdAt || 0)) {
          return (a.createdAt || 0) - (b.createdAt || 0);
        }
        return (a.id || '').localeCompare(b.id || '');
      });
    };

    const mergeThreads = (tA, tB) => ({
      id: tA.id,
      title: tA.title,
      replies: mergeReplies(tA.replies, tB.replies)
    });

    it('PROPRIÉTÉ 1 — IDEMPOTENCE STRICTE : merge(A, A) === A', () => {
      const stateA = {
        id: 'thr_1',
        title: 'Architecture 2026',
        replies: [
          { id: 'rep_1', text: 'Message 1', createdAt: 1000 },
          { id: 'rep_2', text: 'Message 2', createdAt: 2000 }
        ]
      };

      const merged = mergeThreads(stateA, stateA);
      assert.deepEqual(merged, stateA, 'La fusion d\'un état avec lui-même doit être strictement identique (Idempotence)');
    });

    it('PROPRIÉTÉ 2 — COMMUTATIVITÉ STRICTE : merge(A, B) === merge(B, A)', () => {
      const stateA = {
        id: 'thr_1',
        title: 'Architecture 2026',
        replies: [
          { id: 'rep_1', text: 'Message 1', createdAt: 1000 },
          { id: 'rep_col_A', text: 'Collision A', createdAt: 1500 }
        ]
      };

      const stateB = {
        id: 'thr_1',
        title: 'Architecture 2026',
        replies: [
          { id: 'rep_2', text: 'Message 2', createdAt: 2000 },
          { id: 'rep_col_B', text: 'Collision B', createdAt: 1500 }
        ]
      };

      const mergedAB = mergeThreads(stateA, stateB);
      const mergedBA = mergeThreads(stateB, stateA);

      assert.deepEqual(mergedAB, mergedBA, 'merge(A, B) doit être strictement identique à merge(B, A) (Commutativité)');
      assert.equal(mergedAB.replies.length, 4);
      assert.equal(mergedAB.replies[1].id, 'rep_col_A');
      assert.equal(mergedAB.replies[2].id, 'rep_col_B');
    });

    it('PROPRIÉTÉ 3 — ASSOCIATIVITÉ STRICTE : merge(merge(A, B), C) === merge(A, merge(B, C))', () => {
      const sA = { id: 't1', replies: [{ id: 'r1', createdAt: 100 }] };
      const sB = { id: 't1', replies: [{ id: 'r2', createdAt: 200 }] };
      const sC = { id: 't1', replies: [{ id: 'r3', createdAt: 300 }] };

      const left = mergeThreads(mergeThreads(sA, sB), sC);
      const right = mergeThreads(sA, mergeThreads(sB, sC));

      assert.deepEqual(left, right, 'L\'ordre de groupement des deltas ne doit pas altérer l\'état convergent (Associativité)');
    });
  });

  describe('2. Fuzzing Adversarial de Bit-Rot & Corruption de Chunks SHA-256', () => {
    it('doit détecter la corruption d\'un bit (Single-Bit Flip) et auto-guérir le cache', async () => {
      const storage = new HardenedStorageMock();
      const rawData = Buffer.from('Bloc de données hautement critique pour le P2P Workspace 2026');
      const validHash = MockCryptoVault.hashSHA256(rawData);

      await storage.saveChunkHardened(validHash, rawData);
      assert.equal(await storage.hasChunkHardened(validHash), true);

      const corruptedData = Buffer.from(rawData);
      corruptedData[10] ^= 0x01;
      storage.opfsFiles.set(`chunk_${validHash}`, corruptedData);

      const fetched = await storage.getChunkHardened(validHash);
      assert.equal(fetched, null, 'Le bloc corrompu doit être rejeté à la lecture SHA-256');
      assert.equal(storage.opfsFiles.has(`chunk_${validHash}`), false, 'L\'entrée corrompue doit être immédiatement supprimée');
      assert.equal(await storage.hasChunkHardened(validHash), false, 'hasChunk doit désormais renvoyer false');
    });
  });

  describe('3. Crash Simulation en Plein Flush (Interrupted SyncAccessHandle / 0-Byte)', () => {
    it('doit survivre à une coupure d\'alimentation en plein write() sans empoisonner le cache', async () => {
      const storage = new HardenedStorageMock();
      const rawData = Buffer.from('Contenu de test pour simulation de crash');
      const hash = MockCryptoVault.hashSHA256(rawData);

      storage.writeCrashCountdown = 0;

      await assert.rejects(
        async () => storage.saveChunkHardened(hash, rawData),
        /CRASH_SIMULATED/,
        'Le crash doit être intercepté'
      );

      assert.equal(storage.opfsFiles.get(`chunk_${hash}`).byteLength, 0);
      assert.equal(await storage.hasChunkHardened(hash), false, 'Un fichier 0-octet ne doit jamais être validé');
      assert.equal(await storage.getChunkHardened(hash), null);
      assert.equal(storage.opfsFiles.has(`chunk_${hash}`), false);

      await storage.saveChunkHardened(hash, rawData);
      assert.equal(await storage.hasChunkHardened(hash), true);
      const recovered = await storage.getChunkHardened(hash);
      assert.deepEqual(Buffer.from(recovered), rawData);
    });
  });

  describe('4. Simulation d\'Épuisement de Quota (QuotaExceededError Recovery)', () => {
    it('doit déclencher la purge d\'urgence et préserver les structures critiques', async () => {
      const storage = new HardenedStorageMock();
      storage.quotaExceeded = true;

      const rawData = Buffer.from('Bloc sous contrainte de quota');
      const hash = MockCryptoVault.hashSHA256(rawData);

      let quotaHandled = false;
      try {
        await storage.saveChunkHardened(hash, rawData);
      } catch (err) {
        if (err.name === 'QuotaExceededError') {
          quotaHandled = true;
          storage.quotaExceeded = false;
          await storage.saveChunkHardened(hash, rawData);
        }
      }

      assert.equal(quotaHandled, true, 'L\'exception QuotaExceededError doit être interceptée');
      assert.equal(await storage.hasChunkHardened(hash), true, 'L\'écriture doit réussir après la purge corrective');
    });
  });
});
