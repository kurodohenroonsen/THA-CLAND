import { logger } from '../../core/logger.js';
/**
 * Gestionnaire de Transfert en Essaim (Swarm Downloader) & Auto-Réplication P2P (2025/2026)
 * Téléchargement multi-sources type BitTorrent : inventaire d'availability,
 * planification RAREST-FIRST, parallélisme borné, ré-affectation sur timeout,
 * réassemblage en tranches 16 Ko, vérification SHA-256, validation Merkle RFC 6962 et auto-seeding.
 */

import { CONFIG } from '../../core/config.js';
import { CryptoVault } from '../../core/crypto-vault.js';
import { dbManager } from '../../core/local-storage.js';
import { TTLMap } from '../../core/bounded-cache.js';
import { FileChunker } from './file-chunker.js';
import { MerkleTree } from './merkle-tree.js';

export class DriveTransferManager {
  constructor(meshNetwork) {
    this.mesh = meshNetwork;
    this.activeDownloads = new Map(); // fileId -> DownloadState
    this.pendingChunkSlices = new TTLMap({
      maxSize: 128,
      ttlMs: 45000,
      onEvict: (hash) => {
        logger.debug('Drive', `[Transfer] Nettoyage réassemblage expiré pour chunk: ${hash.substring(0, 10)}...`);
      }
    });
    this.autoReplicatingFiles = new Set(); // fileId

    this._activeProbes = new Map(); // fileId -> { seeders:Set, fullSeeders:Set }
    this.peerReputation = new Map(); // peerId -> { failures: 0, penaltyUntil: 0 }

    this.initListeners();

    // Purge périodique des réassemblages binaires partiels abandonnés
    this.sliceSweepInterval = setInterval(() => this.pendingChunkSlices.sweep(), 15000);
  }

  _recordPeerFailure(peerId) {
    if (!peerId) return;
    const rep = this.peerReputation.get(peerId) || { failures: 0, penaltyUntil: 0 };
    rep.failures++;
    if (rep.failures >= 3) {
      rep.penaltyUntil = Date.now() + 180000; // 3 minutes de mise à l'écart
      logger.warn('Drive', `🚫 Pair ${peerId} temporairement mis en quarantaine pour défaillance de blocs.`);
    }
    this.peerReputation.set(peerId, rep);
  }

  _recordPeerSuccess(peerId) {
    if (!peerId) return;
    const rep = this.peerReputation.get(peerId) || { failures: 0, penaltyUntil: 0 };
    rep.failures = Math.max(0, rep.failures - 1);
    this.peerReputation.set(peerId, rep);
  }

  _isPeerPenalized(peerId) {
    const rep = this.peerReputation.get(peerId);
    return rep && rep.penaltyUntil > Date.now();
  }

  /**
   * Sonde le maillage pour estimer le nombre de sources détenant un fichier
   */
  async probeSeeders(commit, timeoutMs = 1600) {
    let localHave = 0;
    for (const c of commit.chunks) {
      if (await dbManager.hasChunk(c.hash)) localHave++;
    }
    const localComplete = localHave === commit.chunks.length;
    const localPercent = commit.chunks.length ? Math.round((localHave / commit.chunks.length) * 100) : 100;

    if (this.mesh.peers.size === 0) {
      return { seeders: 0, fullSeeders: 0, localComplete, localPercent };
    }

    const probe = { seeders: new Set(), fullSeeders: new Set() };
    this._activeProbes.set(commit.fileId, probe);

    this.mesh.broadcast({
      type: 'SEED_PROBE_REQ',
      fileId: commit.fileId,
      rootMerkleHash: commit.rootMerkleHash
    });

    await new Promise((r) => setTimeout(r, timeoutMs));
    this._activeProbes.delete(commit.fileId);

    return {
      seeders: probe.seeders.size,
      fullSeeders: probe.fullSeeders.size,
      localComplete,
      localPercent
    };
  }

  initListeners() {
    this.mesh.on('message-received', async ({ peerId, message }) => {
      try {
        switch (message.type) {
          case 'SEED_PROBE_REQ':
            await this.handleSeedProbeReq(peerId, message);
            break;
          case 'SEED_PROBE_RESP':
            this.handleSeedProbeResp(peerId, message);
            break;
          case 'CHUNK_AVAILABILITY_REQ':
            await this.handleAvailabilityReq(peerId, message);
            break;
          case 'CHUNK_AVAILABILITY_RESP':
            this.handleAvailabilityResp(peerId, message);
            break;
          case 'CHUNK_REQ':
            await this.handleChunkReq(peerId, message);
            break;
        }
      } catch (err) {
        logger.error('Drive', '[Transfer] Erreur traitement message:', err);
      }
    });

    this.mesh.on('peer-left', (peerId) => {
      this.activeDownloads.forEach((dl) => {
        let changed = false;
        dl.inFlight.forEach((info, hash) => {
          if (info.peerId === peerId) {
            dl.inFlight.delete(hash);
            changed = true;
          }
        });
        dl.providers.forEach((peerSet) => peerSet.delete(peerId));
        if (changed) this._scheduleRequests(dl);
      });
    });

    this.mesh.on('raw-binary-received', ({ buffer }) => {
      this.handleRawBinarySlice(buffer);
    });
  }

  async handleSeedProbeReq(peerId, message) {
    const commits = await dbManager.getCommitsByFileId(message.fileId);
    const target = commits.find((c) => c.rootMerkleHash === message.rootMerkleHash) || commits[0];
    if (!target || !target.chunks) return;

    let haveCount = 0;
    for (const c of target.chunks) {
      if (await dbManager.hasChunk(c.hash)) haveCount++;
    }

    this.mesh.sendToPeer(peerId, {
      type: 'SEED_PROBE_RESP',
      fileId: message.fileId,
      haveCount,
      totalChunks: target.chunks.length,
      isFullSeeder: haveCount === target.chunks.length
    });
  }

  handleSeedProbeResp(peerId, message) {
    const probe = this._activeProbes.get(message.fileId);
    if (!probe) return;
    if (message.haveCount > 0) probe.seeders.add(peerId);
    if (message.isFullSeeder) probe.fullSeeders.add(peerId);
  }

  async handleAvailabilityReq(peerId, message) {
    const have = [];
    for (const hash of message.hashes || []) {
      if (await dbManager.hasChunk(hash)) have.push(hash);
    }
    this.mesh.sendToPeer(peerId, {
      type: 'CHUNK_AVAILABILITY_RESP',
      fileId: message.fileId,
      availableHashes: have
    });
  }

  handleAvailabilityResp(peerId, message) {
    const dl = this.activeDownloads.get(message.fileId);
    if (!dl) return;

    for (const hash of message.availableHashes || []) {
      if (dl.missingHashes.has(hash)) {
        if (!dl.providers.has(hash)) dl.providers.set(hash, new Set());
        dl.providers.get(hash).add(peerId);
      }
    }
    dl.providersKnown = true;
    this._scheduleRequests(dl);
  }

  async handleChunkReq(peerId, message) {
    const { hash } = message;
    if (!hash) return;
    const arrayBuffer = await dbManager.getChunk(hash);
    if (!arrayBuffer) {
      this.mesh.sendToPeer(peerId, { type: 'CHUNK_NOT_FOUND', hash });
      return;
    }
    await this.mesh.sendBinaryChunkSliced(peerId, hash, arrayBuffer);
  }

  /**
   * Traite une tranche binaire entrante
   */
  async handleRawBinarySlice(buffer) {
    if (!buffer || buffer.byteLength < 73) return;
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0xFD && bytes[0] !== 0xFC) return;

    const hash = new TextDecoder().decode(bytes.subarray(1, 65)).trim();
    const view = new DataView(buffer);
    const sliceIdx = view.getUint16(65, false);
    const totalSlices = view.getUint16(67, false);
    const totalChunkSize = view.getUint32(69, false);
    const slicePayload = buffer.slice(73);

    const L = CONFIG.LIMITS;
    if (!/^[0-9a-f]{64}$/.test(hash) ||
        totalSlices < 1 || totalSlices > L.MAX_BINARY_SLICES ||
        sliceIdx >= totalSlices ||
        totalChunkSize < 1 || totalChunkSize > L.MAX_BINARY_CHUNK_BYTES) {
      logger.warn('Drive', `[Transfer] En-tête de tranche invalide rejeté (slices=${totalSlices}, size=${totalChunkSize})`);
      return;
    }

    let entry = this.pendingChunkSlices.get(hash);
    if (!entry) {
      entry = { slices: new Map(), received: 0, totalSlices, totalChunkSize, createdAt: Date.now() };
      this.pendingChunkSlices.set(hash, entry);
    }
    if (entry.totalSlices !== totalSlices || entry.totalChunkSize !== totalChunkSize) return;

    if (!entry.slices.has(sliceIdx)) {
      entry.slices.set(sliceIdx, slicePayload);
      entry.received++;
    }

    if (entry.received === entry.totalSlices) {
      const fullChunk = new Uint8Array(entry.totalChunkSize);
      let offset = 0;
      for (let i = 0; i < entry.totalSlices; i++) {
        const slice = entry.slices.get(i);
        if (slice) {
          fullChunk.set(new Uint8Array(slice), offset);
          offset += slice.byteLength;
        }
      }
      this.pendingChunkSlices.delete(hash);
      await this.handleCompleteChunkReceived(hash, fullChunk.buffer);
    }
  }

  destroy() {
    if (this.sliceSweepInterval) {
      clearInterval(this.sliceSweepInterval);
      this.sliceSweepInterval = null;
    }
    this.activeDownloads.forEach((dl) => {
      if (dl.pump) clearInterval(dl.pump);
      if (dl.timeout) clearTimeout(dl.timeout);
    });
    this.activeDownloads.clear();
  }

  async handleCompleteChunkReceived(hash, arrayBuffer) {
    const computedHash = await CryptoVault.hashSHA256(arrayBuffer);
    if (computedHash !== hash) {
      logger.warn('Drive', `[Transfer] Bloc corrompu rejeté (${hash} != ${computedHash})`);
      this.activeDownloads.forEach((dl) => {
        if (dl.inFlight.has(hash)) {
          dl.inFlight.delete(hash);
          this._scheduleRequests(dl);
        }
      });
      return;
    }

    await dbManager.saveChunk(hash, arrayBuffer);

    this.activeDownloads.forEach((dl, fileId) => {
      if (dl.missingHashes.has(hash)) {
        dl.missingHashes.delete(hash);
        dl.inFlight.delete(hash);
        dl.completedChunks++;

        if (dl.onProgress) {
          dl.onProgress(Math.round((dl.completedChunks / dl.totalChunks) * 100));
        }

        if (dl.missingHashes.size === 0) {
          this.completeDownload(fileId);
        } else {
          this._scheduleRequests(dl);
        }
      }
    });
  }

  _scheduleRequests(dl) {
    if (dl.missingHashes.size === 0) return;

    const maxParallel = CONFIG.DRIVE.SWARM_MAX_PARALLEL_CHUNKS || 4;
    const now = Date.now();
    const TIMEOUT_CHUNK_MS = 12000;

    dl.inFlight.forEach((info, hash) => {
      if (now - info.sentAt > TIMEOUT_CHUNK_MS) {
        logger.debug('Drive', `[Transfer] Timeout chunk ${hash.substring(0, 8)} après ${TIMEOUT_CHUNK_MS}ms -> ré-affectation`);
        this._recordPeerFailure(info.peerId);
        if (!dl.triedPeers.has(hash)) dl.triedPeers.set(hash, new Set());
        dl.triedPeers.get(hash).add(info.peerId);
        dl.inFlight.delete(hash);
      }
    });

    if (dl.inFlight.size >= maxParallel) return;

    const rarityList = [];
    dl.missingHashes.forEach((hash) => {
      if (dl.inFlight.has(hash)) return;
      const providers = dl.providers.get(hash) || new Set();
      const onlineProviders = Array.from(providers)
        .filter((p) => this.mesh.peers.has(p) && !this._isPeerPenalized(p));
      rarityList.push({ hash, providers: onlineProviders, score: onlineProviders.length });
    });

    rarityList.sort((a, b) => a.score - b.score);

    for (const item of rarityList) {
      if (dl.inFlight.size >= maxParallel) break;
      const { hash, providers } = item;

      const tried = dl.triedPeers.get(hash) || new Set();
      let candidate = providers.find((p) => !tried.has(p));
      if (!candidate && providers.length > 0) {
        if (tried.size > 0) dl.triedPeers.get(hash).clear();
        candidate = providers[Math.floor(Math.random() * providers.length)];
      }

      if (!candidate && this.mesh.peers.size > 0) {
        const unpenalizedPeers = Array.from(this.mesh.peers.keys()).filter((p) => !this._isPeerPenalized(p));
        if (unpenalizedPeers.length > 0) {
          candidate = unpenalizedPeers[Math.floor(Math.random() * unpenalizedPeers.length)];
        }
      }

      if (candidate) {
        dl.inFlight.set(hash, { peerId: candidate, sentAt: now });
        this.mesh.sendToPeer(candidate, {
          type: 'CHUNK_REQ',
          fileId: dl.commit.fileId,
          hash
        });
      }
    }
  }

  /**
   * Télécharge un fichier depuis l'essaim P2P
   */
  async downloadFile(commit, onProgress = null, { assemble = true } = {}) {
    if (this.activeDownloads.has(commit.fileId)) {
      throw new Error(`Téléchargement déjà en cours pour ${commit.fileName}`);
    }

    await dbManager.ensureSpaceFor(commit.fileSize, assemble ? 'download' : 'replicate');

    const missingHashes = new Set();
    const providers = new Map();
    let alreadyPresent = 0;

    for (const chunk of commit.chunks) {
      if (await dbManager.hasChunk(chunk.hash)) {
        alreadyPresent++;
      } else {
        missingHashes.add(chunk.hash);
        providers.set(chunk.hash, new Set());
      }
    }

    if (missingHashes.size === 0) {
      if (onProgress) onProgress(100);
      if (!assemble) return null;
      return await FileChunker.assembleFileStreaming(commit.chunks, commit.mimeType, commit.fileName);
    }

    return new Promise((resolve, reject) => {
      const dl = {
        commit,
        assemble,
        totalChunks: commit.chunks.length,
        completedChunks: alreadyPresent,
        missingHashes,
        providers,
        providersKnown: false,
        inFlight: new Map(),
        triedPeers: new Map(),
        onProgress,
        resolve,
        reject,
        startedAt: Date.now()
      };
      this.activeDownloads.set(commit.fileId, dl);

      if (onProgress) onProgress(Math.round((alreadyPresent / commit.chunks.length) * 100));

      this.mesh.broadcast({
        type: 'CHUNK_AVAILABILITY_REQ',
        fileId: commit.fileId,
        hashes: Array.from(missingHashes)
      });

      this._scheduleRequests(dl);
      dl.pump = setInterval(() => {
        if (!this.activeDownloads.has(commit.fileId)) {
          clearInterval(dl.pump);
          return;
        }
        this._scheduleRequests(dl);
      }, 2000);

      dl.timeout = setTimeout(() => {
        if (this.activeDownloads.has(commit.fileId)) {
          clearInterval(dl.pump);
          this.activeDownloads.delete(commit.fileId);
          reject(new Error(`Délai dépassé pour ${commit.fileName} (${dl.missingHashes.size} blocs manquants)`));
        }
      }, 180000);
    });
  }

  /**
   * Auto-réplication en arrière-plan (Swarm Auto-Seeding sans duplication de fichier assemblé)
   */
  async autoReplicateFile(commit) {
    if (!commit || !commit.chunks || commit.chunks.length === 0) return;
    if (this.autoReplicatingFiles.has(commit.fileId)) return;
    this.autoReplicatingFiles.add(commit.fileId);

    const missing = [];
    for (const chunk of commit.chunks) {
      if (!(await dbManager.hasChunk(chunk.hash))) missing.push(chunk.hash);
    }
    if (missing.length === 0) {
      this.autoReplicatingFiles.delete(commit.fileId);
      return;
    }

    logger.info('Drive', `[Transfer] 🔄 Auto-réplication swarm pour "${commit.fileName}" (${missing.length}/${commit.chunks.length} blocs manquants)...`);
    try {
      await this.downloadFile(commit, () => {}, { assemble: false });
      logger.info('Drive', `[Transfer] 🌟 "${commit.fileName}" répliqué en blocs (seeding actif) !`);
    } catch (err) {
      logger.warn('Drive', `[Transfer] Auto-réplication partielle pour "${commit.fileName}":`, err.message);
    } finally {
      this.autoReplicatingFiles.delete(commit.fileId);
    }
  }

  async completeDownload(fileId) {
    const dl = this.activeDownloads.get(fileId);
    if (!dl) return;
    if (dl.pump) clearInterval(dl.pump);
    if (dl.timeout) clearTimeout(dl.timeout);
    this.activeDownloads.delete(fileId);

    try {
      // 1. Validation cryptographique de l'arbre Merkle complet RFC 6962
      const chunkHashes = dl.commit.chunks.map((c) => c.hash);
      const computedRoot = await MerkleTree.computeRoot(chunkHashes);
      if (dl.commit.rootMerkleHash && computedRoot !== dl.commit.rootMerkleHash) {
        logger.error('Drive', `🚨 [Transfer] Échec intégrité Merkle racine : ${computedRoot} !== ${dl.commit.rootMerkleHash}`);
        throw new Error(`Échec d'intégrité Merkle : racine invalide (${computedRoot.substring(0, 12)} !== ${dl.commit.rootMerkleHash.substring(0, 12)})`);
      }

      // 2. Si mode réplication seule, résolution immédiate sans assemblage disque
      if (dl.assemble === false) {
        dl.resolve(null);
        return;
      }

      // 3. Assemblage en flux (streaming OPFS)
      const result = await FileChunker.assembleFileStreaming(dl.commit.chunks, dl.commit.mimeType, dl.commit.fileName);
      dl.resolve(result);
    } catch (e) {
      dl.reject(e);
    }
  }
}
