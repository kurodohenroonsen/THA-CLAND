/**
 * did-codec.js - Encodage Multibase, Multicodec & Décompression Cryptographique P-256/Ed25519
 * Conforme W3C DID Core 1.0 & SEC1 v2.0
 */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Uint8Array(256).fill(255);
for (let i = 0; i < B58_ALPHABET.length; i++) {
  B58_MAP[B58_ALPHABET.charCodeAt(i)] = i;
}

// Paramètres de la courbe NIST P-256 (secp256r1 / prime256v1)
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_A = 0xffffffff00000001000000000000000000000000fffffffffffffffffffffffcn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const P256_EXP = (P256_P + 1n) / 4n;

export class Multibase {
  /**
   * Encodage Base58-BTC avec préfixe multibase 'z'
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
   */
  static decodeBase58Btc(string) {
    if (!string || typeof string !== 'string' || !string.startsWith('z')) {
      throw new Error("L'identifiant Multibase Base58-BTC doit commencer par 'z'");
    }
    const cleanStr = string.slice(1);
    if (cleanStr.length === 0) return new Uint8Array(0);

    const bytes = [0];
    for (let i = 0; i < cleanStr.length; i++) {
      const val = B58_MAP[cleanStr.charCodeAt(i)];
      if (val === 255) throw new Error(`Caractère invalide en Base58: ${cleanStr[i]}`);

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
  // Constantes Multicodec officielles
  static P256_PUB = new Uint8Array([0x80, 0x24]); // 0x1200 en LEB128 Varint
  static ED25519_PUB = new Uint8Array([0xed, 0x01]); // 0xed01
  static X25519_PUB = new Uint8Array([0xec, 0x01]); // 0xec01

  static CODE_P256 = 0x1200;      // p256-pub
  static CODE_ED25519 = 0xed;     // ed25519-pub
  static CODE_X25519 = 0xec;      // x25519-pub
  static CODE_SECP256K1 = 0xe7;   // secp256k1-pub

  /**
   * Encode un entier en LEB128 Varint Multicodec
   */
  static encodeVarint(code) {
    const bytes = [];
    let val = code;
    while (val >= 0x80) {
      bytes.push((val & 0x7f) | 0x80);
      val >>>= 7;
    }
    bytes.push(val & 0x7f);
    return new Uint8Array(bytes);
  }

  /**
   * Décode un préfixe LEB128 Varint Multicodec
   */
  static decodeVarint(bytes) {
    let code = 0;
    let shift = 0;
    let offset = 0;
    while (offset < bytes.length) {
      const byte = bytes[offset++];
      code |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return { code, offset, rawKey: bytes.slice(offset) };
  }

  /**
   * Compresse une clé NIST P-256 non compressée (65 octets -> 33 octets SEC1)
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
   * Décompresse une clé NIST P-256 SEC1 (33 octets -> 65 octets uncompressed 0x04||X||Y)
   */
  static decompressP256(compressed33Bytes) {
    if (compressed33Bytes.length === 65 && compressed33Bytes[0] === 0x04) {
      return compressed33Bytes;
    }
    if (compressed33Bytes.length !== 33) {
      throw new Error(`Taille de clé compressée invalide: ${compressed33Bytes.length} octets`);
    }

    const prefix = compressed33Bytes[0];
    if (prefix !== 0x02 && prefix !== 0x03) {
      throw new Error(`Préfixe de compression SEC1 invalide: 0x${prefix.toString(16)}`);
    }

    const xBytes = compressed33Bytes.slice(1, 33);
    let x = 0n;
    for (let i = 0; i < 32; i++) {
      x = (x << 8n) | BigInt(xBytes[i]);
    }

    // Calcul y^2 = x^3 + a*x + b (mod p)
    const x3 = (x * x % P256_P) * x % P256_P;
    const ax = P256_A * x % P256_P;
    const y2 = (x3 + ax + P256_B) % P256_P;

    // Racine carrée modulaire : y = y2^((p+1)/4) mod p
    let y = Multicodec._modPow(y2, P256_EXP, P256_P);

    // Vérification que le point est bien sur la courbe
    if ((y * y % P256_P) !== (y2 % P256_P)) {
      throw new Error('La clé publique P-256 ne correspond à aucun point valide sur la courbe');
    }

    // Alignement de parité avec le préfixe
    const isEven = (y & 1n) === 0n;
    const expectedEven = (prefix === 0x02);
    if (isEven !== expectedEven) {
      y = (P256_P - y) % P256_P;
    }

    const uncompressed = new Uint8Array(65);
    uncompressed[0] = 0x04;
    uncompressed.set(xBytes, 1);

    // Écriture de Y en 32 octets Big-Endian
    let tempY = y;
    for (let i = 64; i >= 33; i--) {
      uncompressed[i] = Number(tempY & 0xffn);
      tempY >>= 8n;
    }

    return uncompressed;
  }

  /**
   * Exponentiation modulaire rapide BigInt
   */
  static _modPow(base, exponent, modulus) {
    let res = 1n;
    let b = base % modulus;
    let e = exponent;
    while (e > 0n) {
      if (e & 1n) res = (res * b) % modulus;
      b = (b * b) % modulus;
      e >>= 1n;
    }
    return res;
  }

  /**
   * Convertit une clé publique décompressée P-256 en DER SPKI (91 octets) pour Web Crypto
   */
  static p256UncompressedToSPKI(uncompressed65) {
    const spkiHeader = new Uint8Array([
      0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
    ]);
    const spki = new Uint8Array(spkiHeader.length + 65);
    spki.set(spkiHeader, 0);
    spki.set(uncompressed65, spkiHeader.length);
    return spki;
  }

  /**
   * Convertit une clé publique décompressée P-256 en JWK standard pour Web Crypto
   */
  static p256UncompressedToJWK(uncompressed65) {
    const x = uncompressed65.slice(1, 33);
    const y = uncompressed65.slice(33, 65);
    return {
      kty: 'EC',
      crv: 'P-256',
      x: Multicodec._bytesToBase64Url(x),
      y: Multicodec._bytesToBase64Url(y),
      ext: true
    };
  }

  static _bytesToBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  static addPrefix(codecHeader, rawKey) {
    const combined = new Uint8Array(codecHeader.length + rawKey.length);
    combined.set(codecHeader, 0);
    combined.set(rawKey, codecHeader.length);
    return combined;
  }
}
