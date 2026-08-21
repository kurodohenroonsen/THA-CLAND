/**
 * core/stream-compressor.js
 * Moteur Intelligent de Compression, Dictionnaire Partagé P2P & Stream Compressor (Pass 4 Hardened - 2026)
 * Standards : W3C Compression Streams / RFC 1951 (deflate-raw) / RFC 9842 (Shared Dictionaries)
 * Persona G7.P3 - Zero-Dependency & Zero-Inflation Guarantee
 */

import { logger } from './logger.js';

export const P2P_STATIC_DICTIONARY = [
  'type', 'action', 'payload', 'authorId', 'authorName', 'authorPubkey',
  'channelId', 'timestamp', 'lamport', 'signature', 'messages', 'threads',
  'commits', 'folders', 'deletions', 'folderDeletions', 'versionVector',
  'messagesSince', 'threadsSince', 'commitsSince', 'foldersSince', 'deletionsSince',
  'CRDT_SYNC_REQ', 'CRDT_SYNC_RESP', 'CHAT_MSG', 'TYPING_SIGNAL', 'FORUM_TOPIC',
  'FORUM_REPLY', 'DRIVE_COMMIT_BROADCAST', 'DRIVE_FOLDER_CREATE', 'DRIVE_FILE_DELETE',
  'PING', 'PONG', 'FAST_PROBE', 'FAST_PROBE_ACK', 'fileId', 'fileName',
  'mimeType', 'fileSize', 'totalChunks', 'rootMerkleHash', 'chunks', 'index', 'hash'
];

export class P2PDictionaryCodec {
  static encodeJson(obj) {
    let str = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (let i = 0; i < P2P_STATIC_DICTIONARY.length; i++) {
      const token = String.fromCharCode(0xE000 + i);
      const keyPattern = `"${P2P_STATIC_DICTIONARY[i]}"`;
      str = str.replaceAll(keyPattern, token);
    }
    return str;
  }

  static decodeJson(str) {
    let result = str;
    for (let i = 0; i < P2P_STATIC_DICTIONARY.length; i++) {
      const token = String.fromCharCode(0xE000 + i);
      const keyPattern = `"${P2P_STATIC_DICTIONARY[i]}"`;
      result = result.replaceAll(token, keyPattern);
    }
    return JSON.parse(result);
  }
}

export class PayloadCompressor {
  static ENTROPY_THRESHOLD = 7.35;
  static MIN_DEFLATE_BYTES = 192;
  static MIN_DICT_BYTES = 64;

  static FORMAT_RAW = 0x00;
  static FORMAT_DEFLATE_RAW = 0x01;
  static FORMAT_DICT_JSON = 0x02;
  static FORMAT_DICT_DEFLATE = 0x03;

  static calculateShannonEntropy(data, sampleLimit = 32768) {
    if (!data || data.byteLength === 0) return 0;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const len = Math.min(bytes.length, sampleLimit);
    if (len === 0) return 0;

    const frequencies = new Uint32Array(256);
    for (let i = 0; i < len; i++) {
      frequencies[bytes[i]]++;
    }

    let entropy = 0;
    const invLen = 1 / len;
    for (let i = 0; i < 256; i++) {
      const count = frequencies[i];
      if (count > 0) {
        const p = count * invLen;
        entropy -= p * Math.log2(p);
      }
    }
    return entropy;
  }

  static async compressRaw(inputBytes) {
    if (typeof CompressionStream === 'undefined') return inputBytes;

    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(inputBytes);
    writer.close();

    const chunks = [];
    const reader = cs.readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  static async decompressRaw(compressedBytes, maxBytes = 32 * 1024 * 1024) {
    if (typeof DecompressionStream === 'undefined') return compressedBytes;

    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(compressedBytes).catch(() => {});
    writer.close().catch(() => {});

    const chunks = [];
    let accumulatedBytes = 0;
    const reader = ds.readable.getReader();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        accumulatedBytes += value.byteLength;
        if (accumulatedBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`Quota de sécurité décompression dépassé (> ${maxBytes} octets, Anti-Zip Bomb)`);
        }
        chunks.push(value);
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }

    const result = new Uint8Array(accumulatedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  static async compressAdaptive(input) {
    let rawBytes;
    let isJsonObject = false;
    let tokenizedString = null;

    if (typeof input === 'object' && !(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) {
      isJsonObject = true;
      tokenizedString = P2PDictionaryCodec.encodeJson(input);
      rawBytes = new TextEncoder().encode(JSON.stringify(input));
    } else if (typeof input === 'string') {
      rawBytes = new TextEncoder().encode(input);
    } else {
      rawBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    }

    const rawSize = rawBytes.byteLength;

    if (rawSize < PayloadCompressor.MIN_DICT_BYTES) {
      const output = new Uint8Array(rawSize + 1);
      output[0] = PayloadCompressor.FORMAT_RAW;
      output.set(rawBytes, 1);
      return { format: PayloadCompressor.FORMAT_RAW, data: output, rawSize, compressedSize: rawSize + 1, ratio: 1.0 };
    }

    const entropy = PayloadCompressor.calculateShannonEntropy(rawBytes);
    if (entropy >= PayloadCompressor.ENTROPY_THRESHOLD) {
      const output = new Uint8Array(rawSize + 1);
      output[0] = PayloadCompressor.FORMAT_RAW;
      output.set(rawBytes, 1);
      return { format: PayloadCompressor.FORMAT_RAW, data: output, rawSize, compressedSize: rawSize + 1, ratio: 1.0 };
    }

    if (isJsonObject && tokenizedString) {
      const tokenizedBytes = new TextEncoder().encode(tokenizedString);
      
      if (tokenizedBytes.byteLength >= PayloadCompressor.MIN_DEFLATE_BYTES) {
        const compressed = await PayloadCompressor.compressRaw(tokenizedBytes);
        if (compressed.byteLength + 1 < rawSize) {
          const output = new Uint8Array(compressed.byteLength + 1);
          output[0] = PayloadCompressor.FORMAT_DICT_DEFLATE;
          output.set(compressed, 1);
          return {
            format: PayloadCompressor.FORMAT_DICT_DEFLATE,
            data: output,
            rawSize,
            compressedSize: output.byteLength,
            ratio: output.byteLength / rawSize
          };
        }
      }

      if (tokenizedBytes.byteLength + 1 < rawSize) {
        const output = new Uint8Array(tokenizedBytes.byteLength + 1);
        output[0] = PayloadCompressor.FORMAT_DICT_JSON;
        output.set(tokenizedBytes, 1);
        return {
          format: PayloadCompressor.FORMAT_DICT_JSON,
          data: output,
          rawSize,
          compressedSize: output.byteLength,
          ratio: output.byteLength / rawSize
        };
      }
    }

    if (rawSize >= PayloadCompressor.MIN_DEFLATE_BYTES) {
      const compressed = await PayloadCompressor.compressRaw(rawBytes);
      if (compressed.byteLength + 1 < rawSize) {
        const output = new Uint8Array(compressed.byteLength + 1);
        output[0] = PayloadCompressor.FORMAT_DEFLATE_RAW;
        output.set(compressed, 1);
        return {
          format: PayloadCompressor.FORMAT_DEFLATE_RAW,
          data: output,
          rawSize,
          compressedSize: output.byteLength,
          ratio: output.byteLength / rawSize
        };
      }
    }

    const output = new Uint8Array(rawSize + 1);
    output[0] = PayloadCompressor.FORMAT_RAW;
    output.set(rawBytes, 1);
    return { format: PayloadCompressor.FORMAT_RAW, data: output, rawSize, compressedSize: rawSize + 1, ratio: 1.0 };
  }

  static async decompressAdaptive(prefixedBuffer, asJson = false) {
    const bytes = prefixedBuffer instanceof Uint8Array ? prefixedBuffer : new Uint8Array(prefixedBuffer);
    if (!bytes || bytes.byteLength === 0) return asJson ? null : new Uint8Array(0);

    const format = bytes[0];
    const payload = bytes.subarray(1);

    let decompressedBytes;

    switch (format) {
      case PayloadCompressor.FORMAT_RAW:
        decompressedBytes = payload;
        break;

      case PayloadCompressor.FORMAT_DEFLATE_RAW:
        decompressedBytes = await PayloadCompressor.decompressRaw(payload);
        break;

      case PayloadCompressor.FORMAT_DICT_JSON: {
        const tokenizedStr = new TextDecoder().decode(payload);
        return P2PDictionaryCodec.decodeJson(tokenizedStr);
      }

      case PayloadCompressor.FORMAT_DICT_DEFLATE: {
        const tokenizedBytes = await PayloadCompressor.decompressRaw(payload);
        const tokenizedStr = new TextDecoder().decode(tokenizedBytes);
        return P2PDictionaryCodec.decodeJson(tokenizedStr);
      }

      default:
        decompressedBytes = payload;
        break;
    }

    if (asJson) {
      const jsonStr = new TextDecoder().decode(decompressedBytes);
      return JSON.parse(jsonStr);
    }

    return decompressedBytes;
  }

  static createCompressionTransform() {
    return new CompressionStream('deflate-raw');
  }

  static createDecompressionTransform() {
    return new DecompressionStream('deflate-raw');
  }
}

export class StreamCompressor {
  static async compress(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    return PayloadCompressor.compressRaw(bytes);
  }

  static async decompress(compressedBytes, maxBytes = 32 * 1024 * 1024) {
    try {
      return await PayloadCompressor.decompressRaw(compressedBytes, maxBytes);
    } catch (err) {
      if (err && err.message && err.message.includes('Quota de sécurité')) {
        return new Uint8Array(0);
      }
      throw err;
    }
  }

  static calculateShannonEntropy(data, sampleLimit = 32768) {
    return PayloadCompressor.calculateShannonEntropy(data, sampleLimit);
  }

  static async compressAdaptiveBinary(inputBytes) {
    const res = await PayloadCompressor.compressAdaptive(inputBytes);
    return {
      isCompressed: res.format !== PayloadCompressor.FORMAT_RAW,
      format: res.format,
      payload: res.data,
      originalSize: res.rawSize,
      compressedSize: res.compressedSize
    };
  }

  static async decompressAdaptiveBinary(prefixedBuffer) {
    return PayloadCompressor.decompressAdaptive(prefixedBuffer, false);
  }

  static async compressJsonIfBeneficial(obj, minSize = 256) {
    const jsonString = typeof obj === 'string' ? obj : JSON.stringify(obj);
    const rawBytes = new TextEncoder().encode(jsonString);

    if (rawBytes.byteLength < minSize) {
      return {
        isCompressed: false,
        data: jsonString,
        rawBytesCount: rawBytes.byteLength,
        compressedBytesCount: rawBytes.byteLength
      };
    }

    const compressed = await PayloadCompressor.compressRaw(rawBytes);
    if (compressed.byteLength < rawBytes.byteLength) {
      return {
        isCompressed: true,
        data: compressed,
        rawBytesCount: rawBytes.byteLength,
        compressedBytesCount: compressed.byteLength
      };
    }

    return {
      isCompressed: false,
      data: jsonString,
      rawBytesCount: rawBytes.byteLength,
      compressedBytesCount: rawBytes.byteLength
    };
  }

  static async decompressJsonPayload(data, asJson = true) {
    return PayloadCompressor.decompressAdaptive(data, asJson);
  }
}
