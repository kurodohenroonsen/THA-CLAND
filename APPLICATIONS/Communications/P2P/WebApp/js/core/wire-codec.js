/**
 * wire-codec.js - Codec Binaire & Négociation Sémantique RFC-PMESH-001
 * Trame fixe 16 octets, SemVer 2.0 & Bitmask de Capacités
 * P2P Mesh Workspace (Pass 2 - 2026)
 */

export const WIRE_CONSTANTS = {
  MAGIC_BYTE_1: 0x50, // 'P'
  MAGIC_BYTE_2: 0x4D, // 'M'
  HEADER_SIZE: 16,
  CURRENT_PROTO_VER: 0x10, // 1.0
  SEMVER_STRING: '1.3.0',
  MIN_COMPAT_SEMVER: '1.0.0',
  
  OPCODES: {
    HELLO: 0x01,
    HELLO_ACK: 0x02,
    PING: 0x03,
    PONG: 0x04,
    CRDT_SYNC_REQ: 0x10,
    CRDT_SYNC_RESP: 0x11,
    CHAT_MSG: 0x20,
    TYPING_SIGNAL: 0x21,
    CHAT_TOMBSTONE: 0x22,
    FORUM_TOPIC: 0x30,
    FORUM_REPLY: 0x31,
    FORUM_MOD_ACTION: 0x32,
    DRIVE_COMMIT: 0x40,
    DRIVE_FOLDER_CREATE: 0x41,
    DRIVE_FOLDER_DELETE: 0x42,
    DRIVE_FILE_DELETE: 0x43,
    DRIVE_CHUNK_REQ: 0x50,
    DRIVE_CHUNK_AVAIL: 0x51,
    DRIVE_CHUNK_SLICE: 0xFD,
    MEDIA_RENEG_OFFER: 0x60,
    MEDIA_RENEG_ANSWER: 0x61,
    MEDIA_SIGNAL: 0x70,
    EQUIVOCATION_PROOF: 0x80,
    TRUST_VOUCH: 0x90,
    TRUST_REVOKE: 0x91,
    SENDER_KEY_DISTRIBUTION: 0xA0,
    EPOCH_TRANSITION_COMMIT: 0xA1
  },

  FLAGS: {
    ENCRYPTED: 0x0001,
    COMPRESSED: 0x0002,
    GOSSIP: 0x0004,
    EXTENSIONS: 0x0008
  }
};

/**
 * Encodeur et Décodeur de Trames Wire Binaires RFC-PMESH-001
 */
export class WireFrameCodec {
  /**
   * Encode un message en trame binaire avec Header 16 octets
   */
  static encodeFrame({ opcode, flags = 0, seqNum = 0, lamport = 0, payloadBytes }) {
    if (!(payloadBytes instanceof Uint8Array)) {
      throw new TypeError('payloadBytes doit être une instance de Uint8Array');
    }
    const totalSize = WIRE_CONSTANTS.HEADER_SIZE + payloadBytes.byteLength;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // 1. Header (16B)
    bytes[0] = WIRE_CONSTANTS.MAGIC_BYTE_1;
    bytes[1] = WIRE_CONSTANTS.MAGIC_BYTE_2;
    bytes[2] = WIRE_CONSTANTS.CURRENT_PROTO_VER;
    bytes[3] = opcode & 0xFF;

    view.setUint16(4, flags, false); // Big-Endian
    view.setUint16(6, seqNum, false);
    view.setUint32(8, lamport, false);
    view.setUint32(12, payloadBytes.byteLength, false);

    // 2. Payload Zéro-Copie
    bytes.set(payloadBytes, WIRE_CONSTANTS.HEADER_SIZE);

    return buffer;
  }

  /**
   * Décode et valide une trame binaire reçue
   */
  static decodeFrame(buffer) {
    if (!buffer || buffer.byteLength < WIRE_CONSTANTS.HEADER_SIZE) {
      throw new Error('Trame binaire tronquée ou invalide');
    }
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    if (bytes[0] !== WIRE_CONSTANTS.MAGIC_BYTE_1 || bytes[1] !== WIRE_CONSTANTS.MAGIC_BYTE_2) {
      throw new Error(`Magic bytes invalides: 0x${bytes[0].toString(16)} 0x${bytes[1].toString(16)}`);
    }

    const protoVer = bytes[2];
    const opcode = bytes[3];
    const flags = view.getUint16(4, false);
    const seqNum = view.getUint16(6, false);
    const lamport = view.getUint32(8, false);
    const payloadLength = view.getUint32(12, false);

    if (buffer.byteLength < WIRE_CONSTANTS.HEADER_SIZE + payloadLength) {
      throw new Error(`Payload incomplet (attendu: ${payloadLength}, reçu: ${buffer.byteLength - WIRE_CONSTANTS.HEADER_SIZE})`);
    }

    const payloadBytes = new Uint8Array(buffer, WIRE_CONSTANTS.HEADER_SIZE, payloadLength);

    return {
      protoVer,
      opcode,
      flags,
      seqNum,
      lamport,
      payloadLength,
      payloadBytes
    };
  }
}

/**
 * Validateur et Négociateur Sémantique de Versions (SemVer 2.0)
 */
export class SemVerNegotiator {
  static parse(vStr) {
    const parts = (vStr || '').trim().split('.').map(n => parseInt(n, 10));
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0
    };
  }

  /**
   * Vérifie si la version distante est compatible avec la version locale
   */
  static isCompatible(remoteSemverStr, localSemverStr = WIRE_CONSTANTS.SEMVER_STRING) {
    const remote = this.parse(remoteSemverStr);
    const local = this.parse(localSemverStr);

    // Règle SemVer stricte : Versions majeures différentes = Incompatible
    if (remote.major !== local.major) {
      return false;
    }
    return true;
  }

  /**
   * Négocie l'intersection des capacités
   */
  static intersectCapabilities(localCaps = [], remoteCaps = []) {
    const remoteSet = new Set(remoteCaps);
    return localCaps.filter(c => remoteSet.has(c));
  }
}
