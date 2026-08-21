/**
 * binary-frame-router.js - Multiplexeur / Démultiplexeur Binaire Zero-Copy Haute Cadence
 * Conforme RFC 8831 / RFC 8832 / W3C Compression Streams / TC39 ArrayBuffer Transfer
 * Standard P2P Mesh Workspace (Pass 4 Hardened - 2026)
 */

import { StreamCompressor } from './stream-compressor.js';
import { logger } from './logger.js';

export const FRAME_TYPES = {
  CONTROL_SIGNAL: 0x01,
  PING_PONG:      0x02,
  CRDT_DELTA:     0x10,
  CHAT_BURST:     0x20,
  DRIVE_SLICE:    0x40,
  AUDIO_BURST:    0x50,
  VIDEO_BURST:    0x51,
  TRUST_ASSERT:   0x60
};

export const FRAME_FLAGS = {
  NONE:       0x00,
  ENCRYPTED:  0x01,
  COMPRESSED: 0x02,
  SIGNED:     0x04,
  PRIORITY:   0x08
};

export const ROUTER_CONSTANTS = {
  MAGIC_BYTE: 0x50, // 'P'
  PROTOCOL_VERSION: 0x02,
  BASE_HEADER_SIZE: 12,
  SIGNATURE_SIZE: 64,
  MAX_FRAME_SIZE: 16 * 1024 * 1024
};

export class BinaryFrameRouter {
  constructor(options = {}) {
    this.vault = options.vault || null;
    this.handlers = new Map();
    this.metrics = {
      framesSent: 0,
      framesReceived: 0,
      bytesProcessed: 0,
      decompressedCount: 0
    };
  }

  registerHandler(frameType, handler) {
    if (!this.handlers.has(frameType)) {
      this.handlers.set(frameType, new Set());
    }
    this.handlers.get(frameType).add(handler);
    return () => this.handlers.get(frameType)?.delete(handler);
  }

  async encodeFrame({
    type,
    payload,
    flags = FRAME_FLAGS.NONE,
    streamId = 0,
    compressIfBeneficial = false,
    signKey = null
  }) {
    let payloadBytes;
    if (payload instanceof Uint8Array) {
      payloadBytes = payload;
    } else if (payload instanceof ArrayBuffer) {
      payloadBytes = new Uint8Array(payload);
    } else if (typeof payload === 'string') {
      payloadBytes = new TextEncoder().encode(payload);
    } else if (typeof payload === 'object') {
      payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    } else {
      payloadBytes = new Uint8Array(0);
    }

    let appliedFlags = flags;

    if (compressIfBeneficial && payloadBytes.byteLength >= StreamCompressor.MIN_COMPRESS_BYTES) {
      if (StreamCompressor.shouldCompress(payloadBytes)) {
        const compressed = await StreamCompressor.compress(payloadBytes);
        if (compressed.byteLength < payloadBytes.byteLength) {
          payloadBytes = compressed;
          appliedFlags |= FRAME_FLAGS.COMPRESSED;
        }
      }
    }

    const hasSignature = Boolean((appliedFlags & FRAME_FLAGS.SIGNED) && signKey);
    const signatureLength = hasSignature ? ROUTER_CONSTANTS.SIGNATURE_SIZE : 0;
    const headerSize = ROUTER_CONSTANTS.BASE_HEADER_SIZE + signatureLength;
    const totalSize = headerSize + payloadBytes.byteLength;

    const frameBuffer = new ArrayBuffer(totalSize);
    const frameBytes = new Uint8Array(frameBuffer);
    const view = new DataView(frameBuffer);

    frameBytes[0] = ROUTER_CONSTANTS.MAGIC_BYTE;
    frameBytes[1] = type & 0xFF;
    frameBytes[2] = appliedFlags & 0xFF;
    frameBytes[3] = ROUTER_CONSTANTS.PROTOCOL_VERSION;
    view.setUint32(4, streamId, false);
    view.setUint32(8, payloadBytes.byteLength, false);

    frameBytes.set(payloadBytes, headerSize);

    if (hasSignature) {
      const sigData = frameBytes.subarray(headerSize);
      const signatureBytes = await this._signBytes(sigData, signKey);
      frameBytes.set(signatureBytes.subarray(0, ROUTER_CONSTANTS.SIGNATURE_SIZE), ROUTER_CONSTANTS.BASE_HEADER_SIZE);
    }

    this.metrics.framesSent++;
    this.metrics.bytesProcessed += totalSize;

    return frameBuffer;
  }

  async decodeAndRoute(frameBufferOrView, peerId = null) {
    const rawBuffer = frameBufferOrView.buffer ? frameBufferOrView.buffer : frameBufferOrView;
    const byteOffset = frameBufferOrView.byteOffset || 0;
    const byteLength = frameBufferOrView.byteLength || rawBuffer.byteLength;

    if (byteLength < ROUTER_CONSTANTS.BASE_HEADER_SIZE) {
      throw new Error(`Trame trop courte (< ${ROUTER_CONSTANTS.BASE_HEADER_SIZE} octets)`);
    }

    const view = new DataView(rawBuffer, byteOffset, byteLength);
    const magic = view.getUint8(0);
    if (magic !== ROUTER_CONSTANTS.MAGIC_BYTE) {
      throw new Error(`Magic Byte non reconnu : 0x${magic.toString(16)}`);
    }

    const type = view.getUint8(1);
    const flags = view.getUint8(2);
    const version = view.getUint8(3);
    const streamId = view.getUint32(4, false);
    const payloadLength = view.getUint32(8, false);

    const isSigned = (flags & FRAME_FLAGS.SIGNED) !== 0;
    const headerSize = ROUTER_CONSTANTS.BASE_HEADER_SIZE + (isSigned ? ROUTER_CONSTANTS.SIGNATURE_SIZE : 0);

    if (byteLength < headerSize + payloadLength) {
      throw new Error(`Trame incomplète : reçu ${byteLength}, attendu ${headerSize + payloadLength}`);
    }

    let payloadBytes = new Uint8Array(rawBuffer, byteOffset + headerSize, payloadLength);

    if ((flags & FRAME_FLAGS.COMPRESSED) !== 0) {
      payloadBytes = await StreamCompressor.decompress(payloadBytes);
      this.metrics.decompressedCount++;
    }

    const frame = {
      type,
      flags,
      version,
      streamId,
      payloadBytes,
      peerId,
      timestamp: Date.now()
    };

    const handlers = this.handlers.get(type);
    if (handlers && handlers.size > 0) {
      handlers.forEach(fn => {
        try {
          fn(frame);
        } catch (err) {
          logger.error('BinaryRouter', `Erreur handler pour type 0x${type.toString(16)}:`, err);
        }
      });
    }

    this.metrics.framesReceived++;
    this.metrics.bytesProcessed += byteLength;

    return frame;
  }

  async _signBytes(bytes, privateKey) {
    if (typeof crypto === 'undefined' || !crypto.subtle) return new Uint8Array(ROUTER_CONSTANTS.SIGNATURE_SIZE);
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, privateKey, bytes);
    return new Uint8Array(sig);
  }
}
