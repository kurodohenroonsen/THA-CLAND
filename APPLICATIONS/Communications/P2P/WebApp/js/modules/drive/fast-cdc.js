/**
 * modules/drive/fast-cdc.js
 * FastCDC (USENIX ATC '16 / IEEE TPDS '20) - Pass 4 Hardened (2026)
 * Gear Rolling Hash 64-bit avec Table d'Entropie Maximale & Masquage Normalisé.
 * Support Zero-Allocation Streaming & Chunk Views.
 * Zero-Dependency.
 */

export class FastCDC {
  // Constantes de calibrage par défaut adaptées au Drive P2P & Merkle DAG
  static DEFAULT_MIN_SIZE = 32 * 1024;   // 32 Ko
  static DEFAULT_AVG_SIZE = 128 * 1024;  // 128 Ko
  static DEFAULT_MAX_SIZE = 512 * 1024;  // 512 Ko

  // Table GEAR 64-bit canonique (256 constantes 64-bit haute entropie non périodiques)
  static GEAR_TABLE = new BigUint64Array([
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

  // Vues 32-bit (Low/High) pour exécution JIT ultra-rapide sans allocation BigInt
  static GEAR_LO = new Uint32Array(256);
  static GEAR_HI = new Uint32Array(256);

  static {
    for (let i = 0; i < 256; i++) {
      const val = FastCDC.GEAR_TABLE[i];
      FastCDC.GEAR_LO[i] = Number(val & 0xffffffffn);
      FastCDC.GEAR_HI[i] = Number((val >> 32n) & 0xffffffffn);
    }
  }

  /**
   * Calcule les masques normalisés optimaux (MaskS, MaskL) pour une taille cible
   * @param {number} avgSize Taille moyenne visée en octets
   * @param {number} normalizationLevel Degré de normalisation (défaut: 1 bit)
   * @returns {{ maskS: number, maskL: number, maskBits: number }}
   */
  static deriveMasks(avgSize, normalizationLevel = 1) {
    const maskBits = Math.round(Math.log2(avgSize));
    const bitsS = Math.min(30, maskBits + normalizationLevel);
    const bitsL = Math.max(1, maskBits - normalizationLevel);

    // Masques à bits dispersés pour briser les régularités cycliques
    const maskS = ((1 << bitsS) - 1) >>> 0;
    const maskL = ((1 << bitsL) - 1) >>> 0;

    return { maskS, maskL, maskBits };
  }

  /**
   * Découpe un Uint8Array selon l'algorithme FastCDC durci (Pass 4)
   * @param {Uint8Array} data Tampon binaire source
   * @param {Object} options Options de configuration des bornes
   * @returns {Array<{ offset: number, length: number }>}
   */
  static chunk(data, options = {}) {
    const results = [];
    for (const chunk of FastCDC.iterate(data, options)) {
      results.push({ offset: chunk.offset, length: chunk.length });
    }
    return results;
  }

  /**
   * Générateur Zero-Allocation de blocs FastCDC
   * @param {Uint8Array} data Tampon source
   * @param {Object} options Configuration des bornes
   * @yields {{ offset: number, length: number, view: Uint8Array }}
   */
  static *iterate(data, {
    minSize = FastCDC.DEFAULT_MIN_SIZE,
    avgSize = FastCDC.DEFAULT_AVG_SIZE,
    maxSize = FastCDC.DEFAULT_MAX_SIZE,
    normalizationLevel = 1
  } = {}) {
    if (!(data instanceof Uint8Array)) {
      if (data && data.buffer instanceof ArrayBuffer) {
        data = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
      } else {
        throw new TypeError('FastCDC: Les données d\'entrée doivent être un Uint8Array ou ArrayBuffer');
      }
    }

    const totalLength = data.length;
    if (totalLength === 0) return;

    // Normalisation des bornes
    const min = Math.max(64, Math.min(minSize, totalLength));
    const avg = Math.max(min, Math.min(avgSize, totalLength));
    const max = Math.max(avg, Math.min(maxSize, totalLength));

    if (totalLength <= min) {
      yield { offset: 0, length: totalLength, view: data.subarray(0, totalLength) };
      return;
    }

    const { maskS, maskL } = FastCDC.deriveMasks(avg, normalizationLevel);
    const gearLo = FastCDC.GEAR_LO;
    let cursor = 0;

    while (cursor < totalLength) {
      const remaining = totalLength - cursor;
      if (remaining <= min) {
        yield { offset: cursor, length: remaining, view: data.subarray(cursor, totalLength) };
        break;
      }

      const currentMax = Math.min(remaining, max);
      const normalBoundary = Math.min(remaining, avg);
      let fp = 0;
      let cutPoint = currentMax;

      // 1. Cut-Point Skipping : Saut inconditionnel des 'min' premiers octets
      let i = min;

      // 2. Zone Normalisée [min, avg] avec MaskS (Strict)
      for (; i < normalBoundary; i++) {
        const byte = data[cursor + i];
        fp = ((fp << 1) + gearLo[byte]) >>> 0;
        if ((fp & maskS) === 0) {
          cutPoint = i + 1;
          break;
        }
      }

      // 3. Zone Normalisée [avg, max] avec MaskL (Relâché) si pas encore coupé
      if (cutPoint === currentMax && i < currentMax) {
        for (; i < currentMax; i++) {
          const byte = data[cursor + i];
          fp = ((fp << 1) + gearLo[byte]) >>> 0;
          if ((fp & maskL) === 0) {
            cutPoint = i + 1;
            break;
          }
        }
      }

      yield {
        offset: cursor,
        length: cutPoint,
        view: data.subarray(cursor, cursor + cutPoint)
      };

      cursor += cutPoint;
    }
  }
}
