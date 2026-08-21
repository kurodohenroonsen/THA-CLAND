import { logger } from '../../core/logger.js';
import { CONFIG } from '../../core/config.js';
import { CryptoVault } from '../../core/crypto-vault.js';
import { dbManager } from '../../core/local-storage.js';
import { MerkleTree } from './merkle-tree.js';

/**
 * Module de Découpage de Fichiers (Chunking) & Merkle Hashing SHA-256 (RFC 6962)
 * Découpe les fichiers en blocs, calcule les empreintes cryptographiques et gère l'assemblage streaming.
 */

export class FileChunker {
  /**
   * Traite un fichier brut (File ou Blob) : découpe en chunks et enregistre en local
   */
  static async processFile(file, onProgress = null) {
    const CHUNK_SIZE = CONFIG.DRIVE.CHUNK_SIZE || 512 * 1024;
    const totalSize = file.size;
    const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
    const chunksMeta = [];
    const chunkHashes = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize);
      const slice = file.slice(start, end);
      const arrayBuffer = await slice.arrayBuffer();

      // Calcul du hash SHA-256 du chunk
      const hash = await CryptoVault.hashSHA256(arrayBuffer);
      chunkHashes.push(hash);

      // Sauvegarde du chunk binaire dans le stockage local (OPFS / IndexedDB)
      await dbManager.saveChunk(hash, arrayBuffer);

      chunksMeta.push({
        index: i,
        hash,
        size: arrayBuffer.byteLength
      });

      if (onProgress) {
        onProgress(Math.round(((i + 1) / totalChunks) * 100));
      }
    }

    // Calcul de la racine Merkle hiérarchique conforme RFC 6962
    const rootMerkleHash = await MerkleTree.computeRoot(chunkHashes);

    return {
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      rootMerkleHash,
      chunks: chunksMeta
    };
  }

  /**
   * Reconstitue un fichier complet sous forme de Blob à partir de ses chunks (petits fichiers)
   */
  static async assembleFile(chunksMeta, mimeType = 'application/octet-stream') {
    const buffers = [];
    const sorted = [...chunksMeta].sort((a, b) => a.index - b.index);
    for (const chunk of sorted) {
      const buffer = await dbManager.getChunk(chunk.hash);
      if (!buffer) throw new Error(`Chunk manquant: index ${chunk.index} (${chunk.hash})`);
      buffers.push(buffer);
    }
    return new Blob(buffers, { type: mimeType });
  }

  /**
   * Reconstitue un fichier en FLUX vers un fichier temporaire OPFS sans saturer la RAM (gros fichiers > 1 Go)
   */
  static async assembleFileStreaming(chunksMeta, mimeType = 'application/octet-stream', fileName = 'download.bin') {
    const sorted = [...chunksMeta].sort((a, b) => a.index - b.index);

    // Repli mémoire si OPFS indisponible
    if (!dbManager.opfsRoot) {
      const buffers = [];
      for (const chunk of sorted) {
        const buffer = await dbManager.getChunk(chunk.hash);
        if (!buffer) throw new Error(`Chunk manquant: index ${chunk.index} (${chunk.hash})`);
        buffers.push(buffer);
      }
      return new Blob(buffers, { type: mimeType });
    }

    const tmpName = `assembled_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const handle = await dbManager.opfsRoot.getFileHandle(tmpName, { create: true });
    const writable = await handle.createWritable();

    try {
      for (const chunk of sorted) {
        const buffer = await dbManager.getChunk(chunk.hash);
        if (!buffer) throw new Error(`Chunk manquant: index ${chunk.index} (${chunk.hash})`);
        await writable.write(buffer);
      }
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch (err) { logger.debug('Drive', 'Erreur abort writable:', err); }
      try { await dbManager.opfsRoot.removeEntry(tmpName); } catch (err) { logger.debug('Drive', `Erreur suppression tmp OPFS ${tmpName}:`, err); }
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
