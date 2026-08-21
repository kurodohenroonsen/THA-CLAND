/**
 * modules/drive/file-chunker.js (Version Durcie Pass 4 - 2026)
 * Découpage FastCDC Haute Performance, Déduplication Binaire,
 * Merkle Tree RFC 6962, Compression Adaptative & Streaming Zéro OOM.
 */

import { logger } from '../../core/logger.js';
import { CONFIG } from '../../core/config.js';
import { CryptoVault } from '../../core/crypto-vault.js';
import { dbManager } from '../../core/local-storage.js';
import { StreamCompressor } from '../../core/stream-compressor.js';
import { MerkleTree } from './merkle-tree.js';
import { FastCDC } from './fast-cdc.js';

export class FileChunker {
  /**
   * Cède temporairement le contrôle au thread UI pour éviter tout gel
   */
  static async yieldToUI() {
    if (typeof globalThis.scheduler?.yield === 'function') {
      await globalThis.scheduler.yield();
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /**
   * Traite un fichier (File ou Blob) avec gestion mémoire streaming O(1)
   * Compatible fichiers multi-gigaoctets sans saturation du tas V8.
   */
  static async processFile(file, onProgress = null, options = {}) {
    const totalSize = file.size;
    const minSize = options.minSize || CONFIG.DRIVE?.CDC_MIN_SIZE || 32 * 1024;
    const avgSize = options.avgSize || CONFIG.DRIVE?.CHUNK_SIZE || 128 * 1024;
    const maxSize = options.maxSize || CONFIG.DRIVE?.CDC_MAX_SIZE || 512 * 1024;
    const algorithm = options.algorithm || CONFIG.DRIVE?.CHUNKING_ALGO || 'fastcdc';

    // Pour les petits fichiers (<= 16 Mo), traitement direct en mémoire tampon
    // Pour les gros fichiers (> 16 Mo), lecture fenêtrée par tranches pour garantir O(1) RAM
    const WINDOW_SIZE = 8 * 1024 * 1024; // Fenêtre glissante de 8 Mo

    const chunksMeta = [];
    const chunkHashes = [];
    let processedBytes = 0;
    let chunkIndex = 0;

    let fileOffset = 0;
    let carryOverBuffer = new Uint8Array(0);

    while (fileOffset < totalSize || carryOverBuffer.length > 0) {
      const sliceEnd = Math.min(fileOffset + WINDOW_SIZE, totalSize);
      const fileSliceBlob = file.slice(fileOffset, sliceEnd);
      const sliceArrayBuffer = await fileSliceBlob.arrayBuffer();
      const sliceBytes = new Uint8Array(sliceArrayBuffer);
      fileOffset = sliceEnd;

      // Concaténation avec le reliquat du tour précédent
      let activeBuffer;
      if (carryOverBuffer.length > 0) {
        activeBuffer = new Uint8Array(carryOverBuffer.length + sliceBytes.length);
        activeBuffer.set(carryOverBuffer, 0);
        activeBuffer.set(sliceBytes, carryOverBuffer.length);
      } else {
        activeBuffer = sliceBytes;
      }

      const isLastWindow = fileOffset >= totalSize;

      let slices;
      if (algorithm === 'fixed') {
        const fixedSize = CONFIG.DRIVE?.CHUNK_SIZE || 128 * 1024;
        slices = [];
        let cur = 0;
        while (cur < activeBuffer.length) {
          const len = Math.min(fixedSize, activeBuffer.length - cur);
          if (!isLastWindow && cur + len === activeBuffer.length && len < fixedSize) {
            break; // reporter sur la prochaine fenêtre
          }
          slices.push({ offset: cur, length: len });
          cur += len;
        }
      } else {
        slices = FastCDC.chunk(activeBuffer, { minSize, avgSize, maxSize });
      }

      // Si ce n'est pas la dernière fenêtre, le dernier bloc incomplet est reporté
      let cutCount = slices.length;
      if (!isLastWindow && slices.length > 1) {
        cutCount = slices.length - 1; // On garde le dernier bloc potentiel en report
      }

      let lastConsumedOffset = 0;

      for (let i = 0; i < cutCount; i++) {
        const { offset, length } = slices[i];
        // Vue exacte sur le chunk (Uint8Array)
        const rawChunkSlice = activeBuffer.subarray(offset, offset + length);

        // ✅ CORRECTION CRITIQUE : Hachage de la vue Uint8Array (et NON rawChunkSlice.buffer)
        const rawHash = await CryptoVault.hashSHA256(rawChunkSlice);
        chunkHashes.push(rawHash);

        // Déduplication & Sauvegarde locale résiliente
        const alreadyExists = await dbManager.hasChunk(rawHash);
        if (!alreadyExists) {
          const { payload } = await StreamCompressor.compressAdaptiveBinary(rawChunkSlice);
          // Payload binaire dédié
          await dbManager.saveChunk(rawHash, payload.buffer || payload);
        }

        chunksMeta.push({
          index: chunkIndex++,
          hash: rawHash,
          rawSize: length,
          size: length,
          offset: processedBytes
        });

        processedBytes += length;
        lastConsumedOffset = offset + length;

        if (onProgress && totalSize > 0) {
          onProgress(Math.min(100, Math.round((processedBytes / totalSize) * 100)));
        }

        // Anti-Freeze UI : Yield toutes les 16 itérations
        if (chunkIndex % 16 === 0) {
          await FileChunker.yieldToUI();
        }
      }

      // Calcul du reliquat restant pour la prochaine itération
      if (lastConsumedOffset < activeBuffer.length) {
        carryOverBuffer = activeBuffer.slice(lastConsumedOffset);
      } else {
        carryOverBuffer = new Uint8Array(0);
      }

      if (isLastWindow && carryOverBuffer.length === 0) {
        break;
      }
    }

    // Racine Merkle RFC 6962
    const rootMerkleHash = await MerkleTree.computeRoot(chunkHashes);

    return {
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      algorithm,
      totalChunks: chunksMeta.length,
      rootMerkleHash,
      chunks: chunksMeta
    };
  }

  /**
   * Récupère et décompresse un bloc unitaire depuis le stockage local
   */
  static async getDecompressedChunk(hash) {
    const rawStoredBuffer = await dbManager.getChunk(hash);
    if (!rawStoredBuffer) return null;

    const bytes = new Uint8Array(rawStoredBuffer);
    if (bytes.length > 0 && (bytes[0] === StreamCompressor.MAGIC_RAW || bytes[0] === StreamCompressor.MAGIC_DEFLATE_RAW)) {
      const decompressed = await StreamCompressor.decompressAdaptiveBinary(bytes);
      return decompressed.buffer;
    }
    return rawStoredBuffer;
  }

  /**
   * Reconstitue un fichier complet en mémoire (Blob)
   */
  static async assembleFile(chunksMeta, mimeType = 'application/octet-stream') {
    const buffers = [];
    const sorted = [...chunksMeta].sort((a, b) => a.index - b.index);
    for (const chunk of sorted) {
      const buffer = await FileChunker.getDecompressedChunk(chunk.hash);
      if (!buffer) throw new Error(`Chunk manquant: index ${chunk.index} (${chunk.hash})`);
      buffers.push(buffer);
    }
    return new Blob(buffers, { type: mimeType });
  }

  /**
   * Reconstitue un fichier en streaming OPFS avec nettoyage déterministe
   */
  static async assembleFileStreaming(chunksMeta, mimeType = 'application/octet-stream', fileName = 'download.bin') {
    const sorted = [...chunksMeta].sort((a, b) => a.index - b.index);

    if (!dbManager.opfsRoot) {
      return FileChunker.assembleFile(sorted, mimeType);
    }

    const tmpName = `assembled_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const handle = await dbManager.opfsRoot.getFileHandle(tmpName, { create: true });
    const writable = await handle.createWritable();

    try {
      for (const chunk of sorted) {
        const buffer = await FileChunker.getDecompressedChunk(chunk.hash);
        if (!buffer) throw new Error(`Chunk manquant: index ${chunk.index} (${chunk.hash})`);
        await writable.write(buffer);
      }
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch {}
      try { await dbManager.opfsRoot.removeEntry(tmpName); } catch {}
      throw e;
    }

    const file = await handle.getFile();
    const typed = new File([file], fileName, { type: mimeType });
    typed._opfsCleanup = async () => {
      try {
        await dbManager.opfsRoot.removeEntry(tmpName);
      } catch (err) {
        logger.debug('Drive', `Erreur suppression tmp OPFS ${tmpName}:`, err);
      }
    };

    return typed;
  }
}
