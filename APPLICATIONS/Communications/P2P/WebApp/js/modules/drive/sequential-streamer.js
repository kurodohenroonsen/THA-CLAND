/**
 * modules/drive/sequential-streamer.js
 * Moteur de Streaming Séquentiel P2P & Ordonnanceur Haute Priorité (Pass 4 - 2026)
 * Priorité multi-tiers : 1. Métadonnées / En-têtes -> 2. Fenêtre Glissante de Lecture -> 3. Swarm Rarest-First
 */

import { logger } from '../../core/logger.js';
import { dbManager } from '../../core/local-storage.js';

export class SequentialP2PStreamer {
  constructor(transferManager, meshNetwork) {
    this.transferManager = transferManager;
    this.mesh = meshNetwork;
    this.activeStreams = new Map(); // fileId -> StreamSession
  }

  /**
   * Crée ou récupère une session de streaming séquentiel pour un fichier
   */
  createStreamSession(commit, options = {}) {
    const fileId = commit.fileId;
    if (this.activeStreams.has(fileId)) {
      return this.activeStreams.get(fileId);
    }

    const totalChunks = commit.chunks.length;
    const session = {
      fileId,
      commit,
      totalChunks,
      windowSize: options.windowSize || 4, // Nombre de blocs préchargés en avance
      currentChunkIndex: 0,
      cachedChunks: new Map(), // index -> ArrayBuffer
      downloadedBitfield: new Uint8Array(Math.ceil(totalChunks / 8)),
      listeners: new Set(),
      closed: false
    };

    this.activeStreams.set(fileId, session);
    this._startPrioritizedScheduler(session);
    return session;
  }

  /**
   * Ordonnanceur multi-tiers réactif
   */
  async _startPrioritizedScheduler(session) {
    const { commit, totalChunks } = session;

    // Étape 1 : Récupérer d'abord les blocs critiques d'en-tête (Metadata Tier)
    const headerChunkIndexes = [0];
    if (totalChunks > 1) headerChunkIndexes.push(1);
    // Si MP4, le moov atom peut être à la fin du fichier
    if (totalChunks > 2 && commit.mimeType?.includes('mp4')) {
      headerChunkIndexes.push(totalChunks - 1);
    }

    for (const idx of headerChunkIndexes) {
      await this._ensureChunkLoaded(session, idx, 'CRITICAL_METADATA');
    }

    // Étape 2 : Boucle de gestion de la fenêtre glissante
    const interval = setInterval(async () => {
      if (session.closed) {
        clearInterval(interval);
        return;
      }
      const start = session.currentChunkIndex;
      const end = Math.min(totalChunks, start + session.windowSize);

      for (let i = start; i < end; i++) {
        if (!this.hasChunkInSession(session, i)) {
          this._ensureChunkLoaded(session, i, 'PLAYBACK_SLIDING_WINDOW');
        }
      }
    }, 250);

    session._schedulerInterval = interval;
  }

  /**
   * Assure la disponibilité d'un bloc unitaire par index
   */
  async _ensureChunkLoaded(session, chunkIndex, priority = 'NORMAL') {
    if (session.closed || chunkIndex < 0 || chunkIndex >= session.totalChunks) return null;

    // 1. Vérification en cache mémoire de session
    if (session.cachedChunks.has(chunkIndex)) {
      return session.cachedChunks.get(chunkIndex);
    }

    const chunkMeta = session.commit.chunks[chunkIndex];
    if (!chunkMeta) return null;

    // 2. Vérification dans le stockage local persistant (OPFS/IndexedDB)
    const localBuf = await dbManager.getChunk(chunkMeta.hash);
    if (localBuf) {
      session.cachedChunks.set(chunkIndex, localBuf);
      this._markBitfield(session, chunkIndex);
      this._notifyProgress(session, chunkIndex);
      return localBuf;
    }

    // 3. Réquisition immédiate auprès du maillage P2P avec priorité boostée
    logger.debug('Streamer', `⚡ Requête chunk #${chunkIndex} (${priority}) pour ${session.commit.fileName}`);
    try {
      const arrayBuffer = await this._fetchSingleChunkFromMesh(session.commit.fileId, chunkMeta.hash);
      if (arrayBuffer) {
        session.cachedChunks.set(chunkIndex, arrayBuffer);
        this._markBitfield(session, chunkIndex);
        this._notifyProgress(session, chunkIndex);
        return arrayBuffer;
      }
    } catch (err) {
      logger.warn('Streamer', `Échec récupération bloc #${chunkIndex}:`, err.message);
    }
    return null;
  }

  async _fetchSingleChunkFromMesh(fileId, hash) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout chunk ${hash.slice(0, 8)}`));
      }, 10000);

      const onChunk = ({ peerId, buffer }) => {
        if (!this.transferManager) return;
        this.transferManager.handleRawBinarySlice(buffer, peerId).then(() => {
          dbManager.getChunk(hash).then((res) => {
            if (res) {
              cleanup();
              resolve(res);
            }
          });
        });
      };

      const cleanup = () => {
        clearTimeout(timeout);
        if (this.mesh && typeof this.mesh.off === 'function') {
          this.mesh.off('chunk-received', onChunk);
        }
      };

      if (this.mesh) {
        this.mesh.on('chunk-received', onChunk);
        this.mesh.broadcast({
          type: 'CHUNK_REQ',
          fileId,
          hash
        });
      }
    });
  }

  _markBitfield(session, index) {
    const byteIdx = Math.floor(index / 8);
    const bitIdx = index % 8;
    session.downloadedBitfield[byteIdx] |= (1 << bitIdx);
  }

  hasChunkInSession(session, index) {
    const byteIdx = Math.floor(index / 8);
    const bitIdx = index % 8;
    return (session.downloadedBitfield[byteIdx] & (1 << bitIdx)) !== 0;
  }

  seek(session, targetTimeSeconds, totalDurationSeconds) {
    if (!totalDurationSeconds || totalDurationSeconds <= 0) return;
    const ratio = Math.max(0, Math.min(1, targetTimeSeconds / totalDurationSeconds));
    const targetChunkIndex = Math.floor(ratio * session.totalChunks);
    logger.info('Streamer', `⏩ Seeking vers t=${targetTimeSeconds.toFixed(1)}s -> Chunk #${targetChunkIndex}/${session.totalChunks}`);
    session.currentChunkIndex = targetChunkIndex;
  }

  _notifyProgress(session, chunkIndex) {
    session.listeners.forEach(fn => fn({
      chunkIndex,
      totalChunks: session.totalChunks,
      bitfield: session.downloadedBitfield
    }));
  }

  closeSession(fileId) {
    const session = this.activeStreams.get(fileId);
    if (session) {
      session.closed = true;
      if (session._schedulerInterval) clearInterval(session._schedulerInterval);
      session.cachedChunks.clear();
      session.listeners.clear();
      this.activeStreams.delete(fileId);
    }
  }
}
