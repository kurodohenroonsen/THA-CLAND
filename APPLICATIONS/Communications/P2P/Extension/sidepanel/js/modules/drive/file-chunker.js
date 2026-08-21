/**
 * Module de Découpage de Fichiers (Chunking) & Merkle Hashing SHA-256
 * Découpe les fichiers en blocs de 512 Ko, calcule les empreintes cryptographiques et stocke en local.
 */

import { CONFIG } from '../../core/config.js';
import { CryptoVault } from '../../core/crypto-vault.js';
import { dbManager } from '../../core/local-storage.js';

export class FileChunker {
  /**
   * Traite un fichier brut (File ou Blob) : découpe en chunks et enregistre en local
   */
  static async processFile(file, onProgress = null) {
    const CHUNK_SIZE = CONFIG.DRIVE.CHUNK_SIZE;
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

      // Sauvegarde du chunk binaire dans le stockage local
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

    // Calcul du Merkle Root Hash
    const rootMerkleHash = await CryptoVault.hashSHA256(chunkHashes.join(':'));

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
   * Reconstitue un fichier complet sous forme de Blob à partir de ses chunks.
   * ⚠️ Charge tout en mémoire : réservé aux petits fichiers. Pour les gros
   * fichiers, préférer assembleFileStreaming (cf. audit §OOM > 1 Go).
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
   * Reconstitue un fichier en FLUX vers un fichier temporaire OPFS, sans jamais
   * détenir plus d'un bloc à la fois en mémoire. Renvoie un objet File adossé au
   * disque (OPFS), utilisable directement avec URL.createObjectURL.
   *
   * CORRECTIF (audit §OOM > 1 Go) : l'ancien assembleFile construisait un Blob à
   * partir de TOUS les buffers simultanément -> OOM garanti au-delà de ~1-2 Go
   * même si les blocs étaient stockés en OPFS.
   */
  static async assembleFileStreaming(chunksMeta, mimeType = 'application/octet-stream', fileName = 'download.bin') {
    const sorted = [...chunksMeta].sort((a, b) => a.index - b.index);

    // Repli mémoire si OPFS indisponible (petits fichiers uniquement).
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
        await writable.write(buffer); // écriture séquentielle sur disque
      }
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch {}
      try { await dbManager.opfsRoot.removeEntry(tmpName); } catch {}
      throw e;
    }

    // File adossé au disque : createObjectURL n'aspire pas tout en RAM.
    const file = await handle.getFile();
    const typed = new File([file], fileName, { type: mimeType });
    // Nettoyage best-effort du fichier temporaire après un délai (le File reste
    // valide le temps du téléchargement navigateur).
    typed._opfsCleanup = async () => { try { await dbManager.opfsRoot.removeEntry(tmpName); } catch {} };
    return typed;
  }
}
