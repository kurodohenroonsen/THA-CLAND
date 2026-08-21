/**
 * did-codec.js - Encodage Multibase (Base58-BTC) & Multicodec conforme W3C DID Core 1.0
 * P2P Mesh Workspace (Pass 2 - 2026)
 */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export class Multibase {
  /**
   * Encodage Base58-BTC avec préfixe multibase 'z'
   * @param {Uint8Array|ArrayBuffer} bytes
   * @returns {string}
   */
  static encodeBase58Btc(bytes) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (input.length === 0) return 'z';

    const digits = [0];
    for (let i = 0; i < input.length; i++) {
      let carry = input[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }

    let result = '';
    // Gestion des zéros de tête
    for (let i = 0; i < input.length && input[i] === 0; i++) {
      result += '1';
    }
    for (let i = digits.length - 1; i >= 0; i--) {
      result += B58_ALPHABET[digits[i]];
    }

    return `z${result}`;
  }

  /**
   * Décodage Base58-BTC (retire le préfixe 'z')
   * @param {string} string
   * @returns {Uint8Array}
   */
  static decodeBase58Btc(string) {
    if (!string || !string.startsWith('z')) {
      throw new Error("L'identifiant Multibase doit commencer par 'z'");
    }
    const cleanStr = string.slice(1);
    if (cleanStr.length === 0) return new Uint8Array(0);

    const bytes = [0];
    for (let i = 0; i < cleanStr.length; i++) {
      const char = cleanStr[i];
      const val = B58_ALPHABET.indexOf(char);
      if (val === -1) throw new Error(`Caractère invalide en Base58: ${char}`);

      let carry = val;
      for (let j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }

    let leadingZeros = 0;
    for (let i = 0; i < cleanStr.length && cleanStr[i] === '1'; i++) {
      leadingZeros++;
    }

    const result = new Uint8Array(leadingZeros + bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      result[result.length - 1 - i] = bytes[i];
    }
    return result;
  }
}

export class Multicodec {
  // Codes Multicodec officiels (Varint LEB128)
  static P256_PUB = new Uint8Array([0x80, 0x24]); // 0x1200 en LEB128 Varint
  static ED25519_PUB = new Uint8Array([0xed, 0x01]); // 0xed01
  static X25519_PUB = new Uint8Array([0xec, 0x01]); // 0xec01

  /**
   * Compresse une clé publique NIST P-256 non compressée (65 octets -> 33 octets)
   * @param {Uint8Array} uncompressed65Bytes
   * @returns {Uint8Array}
   */
  static compressP256(uncompressed65Bytes) {
    if (uncompressed65Bytes.length === 33) return uncompressed65Bytes;
    if (uncompressed65Bytes.length === 65 && uncompressed65Bytes[0] === 0x04) {
      const x = uncompressed65Bytes.slice(1, 33);
      const yLastByte = uncompressed65Bytes[64];
      const prefix = (yLastByte % 2 === 0) ? 0x02 : 0x03;
      const compressed = new Uint8Array(33);
      compressed[0] = prefix;
      compressed.set(x, 1);
      return compressed;
    }
    throw new Error('Format de clé NIST P-256 invalide pour compression');
  }

  /**
   * Préfixe une clé publique brute avec son en-tête multicodec
   * @param {Uint8Array} codecHeader
   * @param {Uint8Array} rawKey
   * @returns {Uint8Array}
   */
  static addPrefix(codecHeader, rawKey) {
    const combined = new Uint8Array(codecHeader.length + rawKey.length);
    combined.set(codecHeader, 0);
    combined.set(rawKey, codecHeader.length);
    return combined;
  }
}
