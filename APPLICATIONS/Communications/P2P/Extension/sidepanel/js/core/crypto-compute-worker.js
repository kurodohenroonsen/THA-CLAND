/**
 * crypto-compute-worker.js - Worker Dédié de Calcul Cryptographique, FastCDC & Compression
 * P2P Mesh Workspace (Pass 4 - 2026)
 * - Découpage FastCDC 64-bit Gear Hash (Zero-Allocation)
 * - Hachage SHA-256 & Arbre de Merkle RFC 6962
 * - Compression / Décompression Deflate-Raw & Entropie de Shannon
 * - Pipeline Cryptographique E2EE / DupLESS (HKDF + HMAC IV + AES-GCM-256)
 * - Zero-Copy Transferable Objects
 */

const GEAR_TABLE_64 = new BigUint64Array([
  0x3b5d3c7d207e37dc0n, 0x784d68ba91123086n, 0xcd52880f882e7298n, 0x6331de67015a8bf1n,
  0xa3a758783d987d6dn, 0x22be14bd38d6df02n, 0x9fb4ec32e36d4f6en, 0x13c7eeaa6c478644n,
  0xf85743329f697471n, 0x93309a47da696016n, 0x4e6b22c7104d49d9n, 0xdbcf4010a30b53ffn,
  0x5d9b6264585c571fn, 0x05b2257d07921a22n, 0x9953b018b14a275bn, 0x7ae5a18a93e36e65n,
  0xb3bc87e14d6ea6ebn, 0x23a78912e75e9b88n, 0x90f23de7d77a0601n, 0x61a7a13c9c9f4d1fn,
  0x403d6d6fb35a3962n, 0xa5bc328d4d8ef2e2n, 0x64cf4110de8a1682n, 0x2f901170138d8a63n,
  0x19934bbff7d97b97n, 0x00f7b9f2762a4d33n, 0xf6c535793e25b184n, 0x190807b5380cdce7n,
  0x8797f1f005d5ecb7n, 0x056be94437194cb0n, 0x6d9f8e401b4c9fa5n, 0x51c72f7e34d6a5cbn,
  0x95972ec6e4d293d0n, 0x3d70bb78461b24bfn, 0x82f4e85dc4f71a06n, 0x651c6c06a382c40cn,
  0xb5bb471676f4e6ecn, 0x52488e0a3f890cf2n, 0x36cfb591b6f049een, 0x507119280d908ff9n,
  0x546747514a3822a7n, 0x2a3e0f9b6c0e7d58n, 0x8673896500b467bdn, 0x6f31a24d5e236dc9n,
  0x37a6b7d2f9a14902n, 0xb842a2ec967265a0n, 0x86036814de72851en, 0x9ae6dfd90a614746n,
  0xa0e768b556942ad7n, 0x3f5c71d0d9f4857an, 0x5b306b9b329486c4n, 0x2475476a26cfbc6dn,
  0x028d7a6e1f0e4b85n, 0x0e1f7457497d391cn, 0xc754bd19c72c9186n, 0x5776a382c9f560dan,
  0x1c8b32e1858e7276n, 0x8ff62df155452fcfn, 0x63eb139f408801d0n, 0x48e1a74288040d6bn,
  0xb655b3f170c0c6b1n, 0xee7416ecdf46b14bn, 0x2e0eb0092305a415n, 0xd0ffda87747e9bc4n,
  0x2c64b54019a716c6n, 0x1d368e7d0a273bcfn, 0x93309a47da696016n, 0x76c3746e594d2ab4n,
  0x88981297594d0c14n, 0x56a4cf882877a5efn, 0x1c5905d4e414c278n, 0x8e5f2cfc3a1059f0n,
  0x403b22cf334e36d4n, 0xae793e25b6a7a0b3n, 0x4e667d4f933f7c11n, 0x574a0c8b2c45017dn,
  0x39dc53d2d9b23193n, 0x4642ab6b3d4f8d55n, 0x59902df35c754d92n, 0x1994ec31b54a20b7n,
  0x280e2277d19a4b2dn, 0xb03b749d2c418704n, 0x05b768c2a8f94644n, 0xb738870198de7e5an,
  0x61e38942b08a5cb6n, 0x58c089f257d0794en, 0x69f041d0a52b1236n, 0xd7815cf139d10e6fn,
  0x39a089d5a9d46927n, 0x7e868772e2cfbc39n, 0x56bc168b9d36a445n, 0x76878b40d58a2d1fn,
  0x25a3d00194857b42n, 0x2287900b3e5c941an, 0x446d6b8b0e77428an, 0x180d3b664d509f63n,
  0x89dc8455018b3294n, 0x546e7f22b7a94025n, 0x3d0b2844de348821n, 0xa4b2c1d93a7c6f05n,
  0x31568297ea40b618n, 0x794b638a90124d55n, 0x29af468c8e310052n, 0x47e2b10a3987cd94n,
  0x3c7e096417fa2b67n, 0x8a927d31b0cfb2e6n, 0x50f931d87c24095an, 0x3247c95e108ba63fn,
  0x6b847321a0e945c7n, 0xd1b4398f5a2e6790n, 0x74a053c892b1467en, 0x2897ec0a1d4f8263n,
  0xa3f2187b5c40e9d6n, 0x410a597c28e6b3afn, 0x897c45d203b176ean, 0x12d906fb574a38c1n,
  0x96c0547b31a8ef25n, 0x48a3e792b0c164d8n, 0x2a9b3d4f1087ce52n, 0x6e7b8a9245c310dfn,
  0x1c8e3b5a940f27d6n, 0x59a107e328c4bf65n, 0x3e29f847b105a6cdn, 0x72c589043a1fe7b2n,
  0x40b39e6a71d825c0n, 0x81dfa52b047c9e36n, 0x2d48c0f593a17e6bn, 0x63a92548e10b7cd4n,
  0x97e10b4f358a2d6cn, 0x34c892015e7fb0a3n, 0x5a1b6c7038e92f4dn, 0x18df4a927b05c6e3n,
  0x82b950c4e137a86fn, 0x24e07891a5b3cd62n, 0x4681f20a9d3cb5e7n, 0x79a3b680124e95d1n,
  0x30c5e947f8a12b64n, 0x6e2897b054c301a9n, 0x53f1a04d287be69cn, 0x17b94c25a0e83df6n,
  0x8a032d6f5c7194ebn, 0x4d79b01538e26ac0n, 0x23f6e87a91c0b54dn, 0x6b1045a2789fcd3en,
  0x95c27038b4a1e96fn, 0x38e1b54a72d069c4n, 0x5a907e21c38f4ba6n, 0x12f46b895a0dc7e3n,
  0x87d903a54b2c16e0n, 0x29c4e8701a5fb3d6n, 0x41a72b093e86c59fn, 0x7df0389c254a10e6n,
  0x36b2c954e0187fa3n, 0x68a510d739b42e0fn, 0x50e493b827cf1a65n, 0x14d872c05a963eb1n,
  0x89c03fa417b5e26dn, 0x2d61b89053a47ce2n, 0x4fa27e0591b6c83dn, 0x75b801c428a9ef30n,
  0x38a4d7915f02c6ben, 0x6c1e95b037482a0dn, 0x51b7428e90c63af5n, 0x15a963d204e871fbn,
  0x8e2c047b19a53f6dn, 0x217fa8345b90ce42n, 0x43b06e917d25a8cfn, 0x78d4925031b6e0a7n,
  0x3f6a15c894e02b7dn, 0x65b8390712a4dc9fn, 0x5c7201e938bf46a1n, 0x10e587a3294c6df2n,
  0x8b394160d5e27a08n, 0x27c0e95138a41b6fn, 0x49d5a8206f137eb4n, 0x7e163b49028dc5a0n,
  0x35f8c0729a416bedn, 0x6b24791508e3d2afn, 0x52a09e374b168c4dn, 0x19df24835a706be1n,
  0x8c6b17053e92a4dfn, 0x25a83b4970c1d6e2n, 0x4b71e09528f4a3c6n, 0x70d952613a8be41fn,
  0x3e1784d095c26bafn, 0x64c0297851b3ea0dn, 0x5df6381207a94c5en, 0x13a290547b68d1ebn,
  0x87fb430159d26cean, 0x2b64089e14a753dfn, 0x4d9152738a0bce6fn, 0x72a8c04913e659b4n,
  0x31eb946057d2a8cfn, 0x68d3710529a4be10n, 0x59a428c130ef67d2n, 0x16b087e594d23ca9n,
  0x8fa93c0428b175den, 0x24c718593a60de21n, 0x4ce0579178b2a34fn, 0x71b56a4209df18c3n,
  0x37a09c254b18ef6dn, 0x6df4180a25b39c7en, 0x58c3729014ae6b51n, 0x1b0e56728a493df0n,
  0x80d724953c16a8ebn, 0x2e9b407158d23cfan, 0x42f895a037b16ce4n, 0x79c13e5806a4d2b1n,
  0x33b8a40715ef926dn, 0x67e1529048a3bd0cn, 0x5a2d049187cb3fe5n, 0x1ef97b5320c486a1n,
  0x84a053c917de2b46n, 0x28df19b450c37ae2n, 0x4a187e0293b6d5c1n, 0x7fb24083659a1ce7n,
  0x3c907154a8b23de6n, 0x61a842b039df7e15n, 0x57d903a428c16eb2n, 0x1a4fb682570ce93dn,
  0x8e5039a721b4df6cn, 0x22c1b74059a863efn, 0x46d8905312fb4a7en, 0x70ef241938a5b6c0n,
  0x34a5d8916b072fe3n, 0x69b0324758e1cdafn, 0x5f8120c437a9be16n, 0x15c9a70248d36eb1n,
  0x88e14b0932f75ca6n, 0x2c0f738914b5da2en, 0x407be19358ca26dfn, 0x7be4902156a31c8fn,
  0x32df085469b17ac3n, 0x66c891054a37ebd2n, 0x5db4218097e3a6cfn, 0x11a58e4732b09c56n,
  0x85f094b216a73cden, 0x29e4720158c3ab9fn, 0x4dc10b9324e75a80n, 0x73a849206b15efc2n,
  0x39b2548701e6a3dcn, 0x6da7103852b94fe1n, 0x54e09b2738c1a65fn, 0x18c35a9042d71e8bn,
  0x82d07e419b532ca6n, 0x2ea5b90417c83f61n, 0x48f321b059da6e74n, 0x71a943820e5c1bf6n,
  0x3bb049285fa71ecdn, 0x6e5204b138d97ac0n, 0x50c97e1324a8bf56n, 0x17dfa50942b36c81n,
  0x8bd4207915e396can, 0x23a1f86059c47bedn, 0x47e90b5231c8da26n, 0x7c4f183920e5a6b0n
]);

const GEAR_LO = new Uint32Array(256);
const GEAR_HI = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  const val = GEAR_TABLE_64[i];
  GEAR_LO[i] = Number(val & 0xffffffffn);
  GEAR_HI[i] = Number((val >> 32n) & 0xffffffffn);
}

const BYTE_TO_HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
function bufferToHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += BYTE_TO_HEX[bytes[i]];
  }
  return hex;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

self.onmessage = async function (event) {
  const { id, action, payload } = event.data;
  if (!id || !action) return;

  try {
    let result = null;
    let transferables = [];

    switch (action) {
      case 'FASTCDC_CHUNK': {
        const { buffer, minSize = 32768, avgSize = 131072, maxSize = 524288 } = payload;
        const bytes = new Uint8Array(buffer);
        const slices = executeFastCDC(bytes, minSize, avgSize, maxSize);
        result = { slices, originalByteLength: bytes.byteLength };
        break;
      }

      case 'HASH_SHA256': {
        const { buffer } = payload;
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        result = { hashHex: bufferToHex(digest) };
        break;
      }

      case 'BATCH_HASH_CHUNKS': {
        const { buffer, slices } = payload;
        const bytes = new Uint8Array(buffer);
        const hashes = [];
        for (let i = 0; i < slices.length; i++) {
          const s = slices[i];
          const sub = bytes.subarray(s.offset, s.offset + s.length);
          const digest = await crypto.subtle.digest('SHA-256', sub);
          hashes.push(bufferToHex(digest));
        }
        result = { hashes };
        break;
      }

      case 'COMPRESS_ADAPTIVE': {
        const { buffer, threshold = 7.35 } = payload;
        const inputBytes = new Uint8Array(buffer);
        const entropy = computeShannonEntropy(inputBytes);

        if (inputBytes.byteLength < 128 || entropy >= threshold || typeof CompressionStream === 'undefined') {
          const out = new Uint8Array(1 + inputBytes.byteLength);
          out[0] = 0x00;
          out.set(inputBytes, 1);
          result = { payload: out.buffer, compressed: false, entropy };
          transferables.push(out.buffer);
        } else {
          const cs = new CompressionStream('deflate-raw');
          const writer = cs.writable.getWriter();
          writer.write(inputBytes);
          writer.close();
          const compressedBuf = await new Response(cs.readable).arrayBuffer();
          const compBytes = new Uint8Array(compressedBuf);

          if (compBytes.length >= inputBytes.length) {
            const out = new Uint8Array(1 + inputBytes.byteLength);
            out[0] = 0x00;
            out.set(inputBytes, 1);
            result = { payload: out.buffer, compressed: false, entropy };
            transferables.push(out.buffer);
          } else {
            const out = new Uint8Array(1 + compBytes.length);
            out[0] = 0x01;
            out.set(compBytes, 1);
            result = { payload: out.buffer, compressed: true, entropy };
            transferables.push(out.buffer);
          }
        }
        break;
      }

      case 'DECOMPRESS_ADAPTIVE': {
        const { buffer } = payload;
        const bytes = new Uint8Array(buffer);
        if (bytes.length === 0) {
          result = { payload: new ArrayBuffer(0) };
          break;
        }

        const magic = bytes[0];
        if (magic === 0x00) {
          const raw = bytes.slice(1);
          result = { payload: raw.buffer };
          transferables.push(raw.buffer);
        } else if (magic === 0x01) {
          const ds = new DecompressionStream('deflate-raw');
          const writer = ds.writable.getWriter();
          writer.write(bytes.subarray(1));
          writer.close();
          const decompressedBuf = await new Response(ds.readable).arrayBuffer();
          result = { payload: decompressedBuf };
          transferables.push(decompressedBuf);
        } else {
          result = { payload: buffer };
          transferables.push(buffer);
        }
        break;
      }

      case 'ENCRYPT_CHUNK_DUPLESS': {
        const { buffer, rawChunkHashHex, meta, masterKeyRaw } = payload;
        const chunkData = new Uint8Array(buffer);
        const { ciphertext, cipherHashHex } = await executeEncryptChunk(chunkData, rawChunkHashHex, meta, masterKeyRaw);
        result = { ciphertext: ciphertext.buffer, cipherHashHex };
        transferables.push(ciphertext.buffer);
        break;
      }

      case 'DECRYPT_CHUNK_DUPLESS': {
        const { buffer, rawChunkHashHex, meta, masterKeyRaw } = payload;
        const ciphertextData = new Uint8Array(buffer);
        const decrypted = await executeDecryptChunk(ciphertextData, rawChunkHashHex, meta, masterKeyRaw);
        result = { payload: decrypted.buffer };
        transferables.push(decrypted.buffer);
        break;
      }

      case 'MERKLE_TREE_COMPUTE': {
        const { leafHashes } = payload;
        const root = await computeMerkleRoot(leafHashes);
        result = { root };
        break;
      }

      default:
        throw new Error(`Action Worker non reconnue: ${action}`);
    }

    self.postMessage({ id, success: true, result }, transferables);
  } catch (error) {
    self.postMessage({ id, success: false, error: error.message || String(error) });
  }
};

function executeFastCDC(buffer, minSize, avgSize, maxSize) {
  const len = buffer.length;
  if (len === 0) return [];
  if (len <= minSize) return [{ offset: 0, length: len }];

  const maskBits = Math.round(Math.log2(avgSize));
  const maskS = (1 << (maskBits + 1)) - 1;
  const maskL = (1 << (maskBits - 1)) - 1;

  const chunks = [];
  let chunkStart = 0;

  while (chunkStart < len) {
    const remaining = len - chunkStart;
    if (remaining <= minSize) {
      chunks.push({ offset: chunkStart, length: remaining });
      break;
    }

    const maxChunkLen = Math.min(maxSize, remaining);
    let splitPos = maxChunkLen;
    let fpLo = 0;
    let fpHi = 0;

    const midPoint = Math.min(avgSize, maxChunkLen);
    const searchLimit = chunkStart + maxChunkLen;

    let i = chunkStart + minSize;
    const midAbs = chunkStart + midPoint;

    while (i < midAbs) {
      const b = buffer[i];
      const nextLo = ((fpLo << 1) | (fpHi >>> 31)) ^ GEAR_LO[b];
      const nextHi = (fpHi << 1) ^ GEAR_HI[b];
      fpLo = nextLo >>> 0;
      fpHi = nextHi >>> 0;

      if ((fpLo & maskS) === 0) {
        splitPos = (i - chunkStart) + 1;
        break;
      }
      i++;
    }

    if (splitPos === maxChunkLen) {
      while (i < searchLimit) {
        const b = buffer[i];
        const nextLo = ((fpLo << 1) | (fpHi >>> 31)) ^ GEAR_LO[b];
        const nextHi = (fpHi << 1) ^ GEAR_HI[b];
        fpLo = nextLo >>> 0;
        fpHi = nextHi >>> 0;

        if ((fpLo & maskL) === 0) {
          splitPos = (i - chunkStart) + 1;
          break;
        }
        i++;
      }
    }

    chunks.push({ offset: chunkStart, length: splitPos });
    chunkStart += splitPos;
  }

  return chunks;
}

function computeShannonEntropy(bytes, sampleLimit = 65536) {
  const len = Math.min(bytes.length, sampleLimit);
  if (len === 0) return 0;

  const frequencies = new Uint32Array(256);
  for (let i = 0; i < len; i++) frequencies[bytes[i]]++;

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

async function deriveDriveMasterKeys(masterKeyRaw) {
  const encoder = new TextEncoder();
  const driveSalt = encoder.encode('PMESH_DRIVE_ROOM_SALT_V4');
  const driveInfo = encoder.encode('pmesh-drive-prk-v1');

  const baseMasterKey = await crypto.subtle.importKey(
    'raw',
    masterKeyRaw,
    { name: 'HKDF' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const prkBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: driveSalt, info: driveInfo },
    baseMasterKey,
    256
  );

  const drivePrkKey = await crypto.subtle.importKey(
    'raw',
    prkBits,
    { name: 'HKDF' },
    false,
    ['deriveKey', 'deriveBits']
  );

  const hmacIvKey = await crypto.subtle.importKey(
    'raw',
    prkBits,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  return { drivePrkKey, hmacIvKey };
}

async function executeEncryptChunk(chunkPayload, rawChunkHashHex, meta, masterKeyRaw) {
  const { drivePrkKey, hmacIvKey } = await deriveDriveMasterKeys(masterKeyRaw);

  const encoder = new TextEncoder();
  const info = new Uint8Array(20 + 32);
  info.set(encoder.encode('PMESH_CHUNK_KEY_V1:'), 0);
  info.set(hexToBytes(rawChunkHashHex), 19);

  const chunkKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    drivePrkKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const indexBuf = new ArrayBuffer(4);
  new DataView(indexBuf).setUint32(0, meta.chunkIndex ?? 0, false);
  const hashBytes = hexToBytes(rawChunkHashHex);
  const hmacPayload = new Uint8Array(hashBytes.length + 4);
  hmacPayload.set(hashBytes, 0);
  hmacPayload.set(new Uint8Array(indexBuf), hashBytes.length);

  const sig = await crypto.subtle.sign('HMAC', hmacIvKey, hmacPayload);
  const iv = new Uint8Array(sig, 0, 12);

  const additionalData = encoder.encode(JSON.stringify({
    chunkIndex: meta.chunkIndex ?? 0,
    fileId: String(meta.fileId || ''),
    offset: meta.offset ?? 0,
    rawSize: meta.rawSize ?? 0,
    rootMerkleHash: String(meta.rootMerkleHash || '')
  }));

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    chunkKey,
    chunkPayload
  );

  const ciphertext = new Uint8Array(encryptedBuffer);
  const digest = await crypto.subtle.digest('SHA-256', ciphertext);

  return { ciphertext, cipherHashHex: bufferToHex(digest) };
}

async function executeDecryptChunk(ciphertextBuffer, rawChunkHashHex, meta, masterKeyRaw) {
  const { drivePrkKey, hmacIvKey } = await deriveDriveMasterKeys(masterKeyRaw);

  const encoder = new TextEncoder();
  const info = new Uint8Array(20 + 32);
  info.set(encoder.encode('PMESH_CHUNK_KEY_V1:'), 0);
  info.set(hexToBytes(rawChunkHashHex), 19);

  const chunkKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    drivePrkKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const indexBuf = new ArrayBuffer(4);
  new DataView(indexBuf).setUint32(0, meta.chunkIndex ?? 0, false);
  const hashBytes = hexToBytes(rawChunkHashHex);
  const hmacPayload = new Uint8Array(hashBytes.length + 4);
  hmacPayload.set(hashBytes, 0);
  hmacPayload.set(new Uint8Array(indexBuf), hashBytes.length);

  const sig = await crypto.subtle.sign('HMAC', hmacIvKey, hmacPayload);
  const iv = new Uint8Array(sig, 0, 12);

  const additionalData = encoder.encode(JSON.stringify({
    chunkIndex: meta.chunkIndex ?? 0,
    fileId: String(meta.fileId || ''),
    offset: meta.offset ?? 0,
    rawSize: meta.rawSize ?? 0,
    rootMerkleHash: String(meta.rootMerkleHash || '')
  }));

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    chunkKey,
    ciphertextBuffer
  );

  return new Uint8Array(decryptedBuffer);
}

async function computeMerkleRoot(leafHashes) {
  if (!leafHashes || leafHashes.length === 0) {
    const emptyDigest = await crypto.subtle.digest('SHA-256', new Uint8Array(0));
    return bufferToHex(emptyDigest);
  }

  let currentLayer = leafHashes.slice();
  while (currentLayer.length > 1) {
    const nextLayer = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      const leftBytes = hexToBytes(currentLayer[i]);
      const rightBytes = (i + 1 < currentLayer.length) ? hexToBytes(currentLayer[i + 1]) : leftBytes;

      const combined = new Uint8Array(1 + 32 + 32);
      combined[0] = 0x01; // RFC 6962 Node prefix
      combined.set(leftBytes, 1);
      combined.set(rightBytes, 33);

      const digest = await crypto.subtle.digest('SHA-256', combined);
      nextLayer.push(bufferToHex(digest));
    }
    currentLayer = nextLayer;
  }

  return currentLayer[0];
}
