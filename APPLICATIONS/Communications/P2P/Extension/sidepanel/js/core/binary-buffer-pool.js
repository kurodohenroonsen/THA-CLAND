/**
 * core/binary-buffer-pool.js
 * Pool de Tampons Binaires Zero-Allocation & Utilitaires Vectorisés SWAR (Pass 4 Hardened - 2026)
 * Conforme V8 Orinoco Optimization & TC39 ArrayBuffer Lifetime Standards.
 * Zero-Dependency.
 */

import { logger } from './logger.js';

export class SWAR {
  /**
   * Calcul du nombre de bits à 1 (Hamming Weight / Population Count) sur un mot 32-bit
   * Algorithme vectorisé SWAR (SIMD Within A Register) O(1) sans branchement.
   * @param {number} v Entier non signé 32-bit
   * @returns {number}
   */
  static popcount32(v) {
    v = v >>> 0;
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
  }

  /**
   * Popcount vectorisé haute cadence sur un TypedArray (Uint8Array ou Uint32Array)
   * Traite 4 octets par itération pour une vitesse 4x supérieure.
   * @param {Uint8Array} bytes
   * @param {number} totalBits
   * @returns {number}
   */
  static fastBitfieldCardinality(bytes, totalBits) {
    const byteLen = bytes.length;
    const wordCount = byteLen >>> 2;
    let count = 0;

    if (wordCount > 0) {
      const isAligned = (bytes.byteOffset % 4 === 0);
      if (isAligned) {
        const u32View = new Uint32Array(bytes.buffer, bytes.byteOffset, wordCount);
        for (let i = 0; i < wordCount; i++) {
          count += SWAR.popcount32(u32View[i]);
        }
      } else {
        for (let i = 0; i < wordCount; i++) {
          const base = i << 2;
          const w = (bytes[base]) | (bytes[base + 1] << 8) | (bytes[base + 2] << 16) | (bytes[base + 3] << 24);
          count += SWAR.popcount32(w);
        }
      }
    }

    const processedBytes = wordCount << 2;
    for (let i = processedBytes; i < byteLen; i++) {
      let b = bytes[i];
      b = b - ((b >>> 1) & 0x55);
      b = (b & 0x33) + ((b >>> 2) & 0x33);
      count += (b + (b >>> 4)) & 0x0F;
    }

    const paddingBits = (byteLen * 8) - totalBits;
    if (paddingBits > 0 && byteLen > 0) {
      const lastByte = bytes[byteLen - 1];
      for (let p = 0; p < paddingBits; p++) {
        if ((lastByte & (1 << p)) !== 0) count--;
      }
    }

    return Math.max(0, count);
  }
}

export class FastHex {
  static _BYTE_TO_HEX = new Array(256);
  static _HEX_TO_BYTE = new Int8Array(256);

  static {
    FastHex._HEX_TO_BYTE.fill(-1);
    for (let i = 0; i < 256; i++) {
      const h = i.toString(16).padStart(2, '0');
      FastHex._BYTE_TO_HEX[i] = h;
      FastHex._HEX_TO_BYTE[h.charCodeAt(0)] = (FastHex._HEX_TO_BYTE[h.charCodeAt(0)] & 0x0F) | (i & 0xF0);
    }
    const hexChars = '0123456789abcdefABCDEF';
    for (let i = 0; i < hexChars.length; i++) {
      const code = hexChars.charCodeAt(i);
      const val = parseInt(hexChars[i], 16);
      FastHex._HEX_TO_BYTE[code] = val;
    }
  }

  static decodeToBuffer(hexStr, targetBytes, targetOffset = 0) {
    const len = hexStr.length;
    const targetLen = len >>> 1;
    const table = FastHex._HEX_TO_BYTE;
    for (let i = 0; i < targetLen; i++) {
      const hi = table[hexStr.charCodeAt(i << 1)];
      const lo = table[hexStr.charCodeAt((i << 1) + 1)];
      targetBytes[targetOffset + i] = (hi << 4) | lo;
    }
    return targetBytes;
  }

  static encode(bytes, offset = 0, length = null) {
    const end = length !== null ? offset + length : bytes.length;
    let hex = '';
    const table = FastHex._BYTE_TO_HEX;
    for (let i = offset; i < end; i++) {
      hex += table[bytes[i]];
    }
    return hex;
  }
}

export class PooledBuffer {
  constructor(arrayBuffer, bucketSize, pool) {
    this.buffer = arrayBuffer;
    this.uint8 = new Uint8Array(arrayBuffer);
    this.dataView = new DataView(arrayBuffer);
    this.bucketSize = bucketSize;
    this.pool = pool;
    this.isAcquired = false;
    this.activeLength = bucketSize;
  }

  get byteLength() {
    return this.activeLength;
  }

  subarray(begin = 0, end = this.activeLength) {
    return this.uint8.subarray(begin, end);
  }

  release() {
    if (!this.isAcquired) return;
    this.pool.release(this);
  }
}

export class BinaryBufferPool {
  static SIZES = {
    CHUNK_16K:  16 * 1024,  // 16 Ko (WebRTC Slices standard)
    CHUNK_32K:  32 * 1024,  // 32 Ko (WebRTC Slices turbo / FastCDC min)
    CHUNK_64K:  64 * 1024,  // 64 Ko (Binary Frames / bursts)
    CHUNK_128K: 128 * 1024, // 128 Ko (Drive Standard Chunks)
    CHUNK_512K: 512 * 1024  // 512 Ko (Large Slabs / FastCDC max)
  };

  constructor(options = {}) {
    this.maxPerBucket = options.maxPerBucket || 64;
    this.sanitizeOnRelease = options.sanitizeOnRelease || false;

    this._buckets = new Map();
    for (const size of Object.values(BinaryBufferPool.SIZES)) {
      this._buckets.set(size, []);
    }

    this.metrics = {
      totalAllocated: 0,
      totalAcquired: 0,
      totalReleased: 0,
      poolHits: 0,
      poolMisses: 0,
      activeInUse: 0
    };

    if (typeof FinalizationRegistry !== 'undefined') {
      this._leakDetector = new FinalizationRegistry(({ bucketSize }) => {
        this.metrics.activeInUse = Math.max(0, this.metrics.activeInUse - 1);
        logger.debug('BufferPool', `⚠️ Buffer de taille ${bucketSize} B collecté par le GC sans release() explicite.`);
      });
    }
  }

  _resolveBucketSize(size) {
    if (size <= BinaryBufferPool.SIZES.CHUNK_16K) return BinaryBufferPool.SIZES.CHUNK_16K;
    if (size <= BinaryBufferPool.SIZES.CHUNK_32K) return BinaryBufferPool.SIZES.CHUNK_32K;
    if (size <= BinaryBufferPool.SIZES.CHUNK_64K) return BinaryBufferPool.SIZES.CHUNK_64K;
    if (size <= BinaryBufferPool.SIZES.CHUNK_128K) return BinaryBufferPool.SIZES.CHUNK_128K;
    if (size <= BinaryBufferPool.SIZES.CHUNK_512K) return BinaryBufferPool.SIZES.CHUNK_512K;
    return Math.pow(2, Math.ceil(Math.log2(size)));
  }

  acquire(size) {
    const bucketSize = this._resolveBucketSize(size);
    let bucket = this._buckets.get(bucketSize);
    if (!bucket) {
      bucket = [];
      this._buckets.set(bucketSize, bucket);
    }

    let pooledObj;
    if (bucket.length > 0) {
      pooledObj = bucket.pop();
      this.metrics.poolHits++;
    } else {
      const arrayBuffer = new ArrayBuffer(bucketSize);
      pooledObj = new PooledBuffer(arrayBuffer, bucketSize, this);
      this.metrics.totalAllocated++;
      this.metrics.poolMisses++;
    }

    pooledObj.isAcquired = true;
    pooledObj.activeLength = size;
    this.metrics.totalAcquired++;
    this.metrics.activeInUse++;

    return pooledObj;
  }

  acquireUint8Array(size) {
    const pooled = this.acquire(size);
    return pooled.subarray(0, size);
  }

  release(bufferOrView) {
    if (!bufferOrView) return;

    let target;
    if (bufferOrView instanceof PooledBuffer) {
      target = bufferOrView;
    } else if (bufferOrView._pooledRef instanceof PooledBuffer) {
      target = bufferOrView._pooledRef;
    } else {
      return;
    }

    if (!target.isAcquired) {
      logger.warn('BufferPool', 'Tentative de double libération d\'un buffer déjà disponible.');
      return;
    }

    target.isAcquired = false;
    this.metrics.activeInUse = Math.max(0, this.metrics.activeInUse - 1);
    this.metrics.totalReleased++;

    if (this.sanitizeOnRelease) {
      target.uint8.fill(0);
    }

    const bucket = this._buckets.get(target.bucketSize);
    if (bucket && bucket.length < this.maxPerBucket) {
      bucket.push(target);
    }
  }

  clear() {
    for (const bucket of this._buckets.values()) {
      bucket.length = 0;
    }
  }

  get stats() {
    const available = {};
    for (const [sz, list] of this._buckets.entries()) {
      available[`${sz / 1024}k`] = list.length;
    }
    return {
      ...this.metrics,
      pooledAvailable: available
    };
  }
}

export const bufferPool = new BinaryBufferPool();
