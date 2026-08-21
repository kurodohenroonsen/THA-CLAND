/**
 * Core/StreamCompressor.js
 * Moteur de Compression & Décompression en Flux Natifs (Streams API 2025/2026)
 * Format RFC 1951 (deflate-raw) zéro overhead pour WebRTC P2P, deltas CRDT & stockage
 */

import { logger } from './logger.js';

export class StreamCompressor {
  /**
   * Compresse une chaîne UTF-8 ou un Uint8Array avec deflate-raw
   * @param {string|Uint8Array|ArrayBuffer} data 
   * @returns {Promise<Uint8Array>}
   */
  static async compress(data) {
    if (!data) return new Uint8Array(0);
    const input = typeof data === 'string' 
      ? new TextEncoder().encode(data) 
      : (data instanceof Uint8Array ? data : new Uint8Array(data));

    if (typeof CompressionStream === 'undefined') {
      // Fallback si environnement sans CompressionStream
      return input;
    }

    try {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      writer.write(input);
      writer.close();

      const chunks = [];
      const reader = cs.readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    } catch (err) {
      logger.warn('Compressor', 'Erreur compression deflate-raw, fallback brut:', err);
      return input;
    }
  }

  /**
   * Décompresse un Uint8Array compressé avec deflate-raw
   * @param {Uint8Array|ArrayBuffer} compressedData 
   * @param {number} maxBytes Protection anti-Zip Bomb (défaut: 32 Mo)
   * @returns {Promise<Uint8Array>}
   */
  static async decompress(compressedData, maxBytes = 32 * 1024 * 1024) {
    if (!compressedData || compressedData.byteLength === 0) return new Uint8Array(0);
    const input = compressedData instanceof Uint8Array ? compressedData : new Uint8Array(compressedData);

    if (typeof DecompressionStream === 'undefined') {
      return input;
    }

    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(input);
      writer.close();

      const chunks = [];
      let accumulatedBytes = 0;
      const reader = ds.readable.getReader();
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        accumulatedBytes += value.byteLength;
        if (accumulatedBytes > maxBytes) {
          throw new Error(`Dépassement du quota de sécurité décompression : > ${maxBytes} octets`);
        }
        chunks.push(value);
      }

      const result = new Uint8Array(accumulatedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    } catch (err) {
      logger.warn('Compressor', 'Erreur décompression deflate-raw:', err);
      return input;
    }
  }

  /**
   * Compresse et renvoie un payload JSON optimisé si le gain est effectif
   */
  static async compressJsonIfBeneficial(obj, minThreshold = 256) {
    const rawJson = JSON.stringify(obj);
    const rawBytes = new TextEncoder().encode(rawJson);
    if (rawBytes.byteLength < minThreshold) {
      return { isCompressed: false, data: rawJson, rawBytesCount: rawBytes.byteLength };
    }
    const compressed = await StreamCompressor.compress(rawBytes);
    if (compressed.byteLength < rawBytes.byteLength) {
      return { isCompressed: true, data: compressed, rawBytesCount: rawBytes.byteLength, compressedBytesCount: compressed.byteLength };
    }
    return { isCompressed: false, data: rawJson, rawBytesCount: rawBytes.byteLength };
  }
}
