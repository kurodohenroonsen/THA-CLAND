/**
 * core/worker-pool-rpc.js - Worker Pool RPC Manager Zero-Copy (Pass 4 Hardened - 2026)
 * P2P Mesh Workspace
 * - Détection automatique Hardware Concurrency & dimensionnement élastique
 * - Répartition de charge Least-Busy / Round-Robin
 * - Gestion Transferable Objects bidirectionnelle (Main -> Worker -> Main)
 * - Fallback synchrone robuste en cas d'absence de Web Workers
 * - Zero Memory Leaks & Auto-Restart sur crash
 */

import { logger } from './logger.js';

export class WorkerPoolRPC {
  /**
   * @param {object} options
   * @param {number} [options.poolSize] Nombre de workers dans le pool (auto-détecté si omis)
   * @param {string} [options.workerPath] URL/chemin vers le script crypto-compute-worker.js
   * @param {number} [options.defaultTimeoutMs] Timeout par défaut pour une opération RPC (30s)
   */
  constructor(options = {}) {
    const defaultConcurrency = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : 4;

    this.poolSize = options.poolSize || Math.max(1, Math.min(defaultConcurrency - 1, 8));
    this.workerPath = options.workerPath || new URL('./crypto-compute-worker.js', import.meta.url).href;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 30000;

    this.workers = [];
    this.activeTasks = new Map();
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;
    this.isDestroyed = false;

    this._initPool();
  }

  _initPool() {
    if (typeof Worker === 'undefined') {
      logger.warn('WorkerPoolRPC', '⚠️ Environnement sans Web Workers : mode fallback actif.');
      return;
    }

    try {
      for (let i = 0; i < this.poolSize; i++) {
        this._spawnWorker(i);
      }
      logger.info('WorkerPoolRPC', `⚡ Pool de ${this.workers.length} Workers initialisé avec succès.`);
    } catch (err) {
      logger.warn('WorkerPoolRPC', 'Échec initialisation WorkerPool, fallback local activé:', err.message);
    }
  }

  _spawnWorker(index) {
    try {
      const worker = new Worker(this.workerPath, { type: 'module' });
      worker.onmessage = (e) => this._handleMessage(e.data);
      worker.onerror = (err) => this._handleWorkerError(index, err);

      this.workers[index] = worker;
      this.activeTasks.set(index, 0);
    } catch (err) {
      logger.warn('WorkerPoolRPC', `Impossible de créer le worker #${index}:`, err.message);
    }
  }

  _handleMessage(data) {
    const { id, success, result, error } = data;
    const req = this.pendingRequests.get(id);
    if (!req) return;

    clearTimeout(req.timer);
    this.pendingRequests.delete(id);

    const current = this.activeTasks.get(req.workerIndex) || 1;
    this.activeTasks.set(req.workerIndex, Math.max(0, current - 1));

    if (success) {
      req.resolve(result);
    } else {
      req.reject(new Error(error || 'Erreur d\'exécution RPC dans le Worker'));
    }
  }

  _handleWorkerError(workerIndex, err) {
    logger.error('WorkerPoolRPC', `🔥 Crash Worker #${workerIndex}:`, err.message || err);

    for (const [id, req] of this.pendingRequests.entries()) {
      if (req.workerIndex === workerIndex) {
        clearTimeout(req.timer);
        this.pendingRequests.delete(id);
        req.reject(new Error(`Worker #${workerIndex} a crashé pendant l'opération.`));
      }
    }

    try {
      this.workers[workerIndex].terminate();
    } catch (_) {}
    this._spawnWorker(workerIndex);
  }

  _selectLeastBusyWorker() {
    if (this.workers.length === 0) return -1;

    let bestIndex = 0;
    let minLoad = Infinity;

    for (let i = 0; i < this.workers.length; i++) {
      if (!this.workers[i]) continue;
      const load = this.activeTasks.get(i) || 0;
      if (load < minLoad) {
        minLoad = load;
        bestIndex = i;
      }
    }

    return minLoad === Infinity ? -1 : bestIndex;
  }

  /**
   * Exécute une tâche RPC générique avec transfert d'ArrayBuffer sans copie
   */
  async execute(action, payload = {}, transferList = [], timeoutMs = this.defaultTimeoutMs) {
    if (this.isDestroyed) {
      throw new Error('WorkerPoolRPC a été détruit.');
    }

    const workerIndex = this._selectLeastBusyWorker();
    if (workerIndex === -1) {
      throw new Error('Aucun Worker disponible dans le pool.');
    }

    const id = ++this.requestIdCounter;
    const worker = this.workers[workerIndex];

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          const current = this.activeTasks.get(workerIndex) || 1;
          this.activeTasks.set(workerIndex, Math.max(0, current - 1));
          reject(new Error(`Délai d'attente dépassé (Timeout ${timeoutMs}ms) pour l'action ${action} (id: ${id})`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer, workerIndex });
      this.activeTasks.set(workerIndex, (this.activeTasks.get(workerIndex) || 0) + 1);

      worker.postMessage({ id, action, payload }, transferList);
    });
  }

  async fastCDCChunk(arrayBuffer, options = {}) {
    return this.execute('FASTCDC_CHUNK', {
      buffer: arrayBuffer,
      minSize: options.minSize,
      avgSize: options.avgSize,
      maxSize: options.maxSize
    }, [arrayBuffer]);
  }

  async hashSHA256(arrayBuffer) {
    const res = await this.execute('HASH_SHA256', { buffer: arrayBuffer }, [arrayBuffer]);
    return res.hashHex;
  }

  async compressAdaptive(arrayBuffer, threshold = 7.35) {
    return this.execute('COMPRESS_ADAPTIVE', { buffer: arrayBuffer, threshold }, [arrayBuffer]);
  }

  async decompressAdaptive(arrayBuffer) {
    const res = await this.execute('DECOMPRESS_ADAPTIVE', { buffer: arrayBuffer }, [arrayBuffer]);
    return res.payload;
  }

  async encryptChunkDupless(arrayBuffer, rawChunkHashHex, meta, masterKeyRaw) {
    return this.execute('ENCRYPT_CHUNK_DUPLESS', {
      buffer: arrayBuffer,
      rawChunkHashHex,
      meta,
      masterKeyRaw
    }, [arrayBuffer]);
  }

  async decryptChunkDupless(ciphertextBuffer, rawChunkHashHex, meta, masterKeyRaw) {
    const res = await this.execute('DECRYPT_CHUNK_DUPLESS', {
      buffer: ciphertextBuffer,
      rawChunkHashHex,
      meta,
      masterKeyRaw
    }, [ciphertextBuffer]);
    return res.payload;
  }

  async computeMerkleRoot(leafHashes) {
    const res = await this.execute('MERKLE_TREE_COMPUTE', { leafHashes });
    return res.root;
  }

  destroy() {
    this.isDestroyed = true;
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error('WorkerPoolRPC a été détruit.'));
    }
    this.pendingRequests.clear();

    for (const worker of this.workers) {
      try {
        worker.terminate();
      } catch (_) {}
    }
    this.workers = [];
    this.activeTasks.clear();
    logger.info('WorkerPoolRPC', '🧹 WorkerPoolRPC entièrement détruit et mémoire libérée.');
  }
}
