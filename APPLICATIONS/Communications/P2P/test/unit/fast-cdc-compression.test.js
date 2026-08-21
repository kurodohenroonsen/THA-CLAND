/**
 * test/unit/fast-cdc-compression.test.js
 * Validation unitaire & benchmark de déduplication FastCDC et d'entropie
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { FastCDC } from '../../Extension/sidepanel/js/modules/drive/fast-cdc.js';
import { StreamCompressor } from '../../Extension/sidepanel/js/core/stream-compressor.js';

describe('🧩 G2.P8 - FastCDC & Compression Conditionnelle', () => {
  it('doit calculer correctement l\'entropie de Shannon', () => {
    const zeroEntropy = new Uint8Array(1024).fill(0x41);
    assert.strictEqual(StreamCompressor.calculateShannonEntropy(zeroEntropy), 0);

    const textData = new TextEncoder().encode('Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(50));
    const textEntropy = StreamCompressor.calculateShannonEntropy(textData);
    assert.ok(textEntropy > 2.5 && textEntropy < 5.5, `Entropie texte attendue [2.5, 5.5], obtenue: ${textEntropy}`);

    const randomData = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) randomData[i] = Math.floor(Math.random() * 256);
    const randEntropy = StreamCompressor.calculateShannonEntropy(randomData);
    assert.ok(randEntropy > 7.7, `Entropie aléatoire attendue > 7.7, obtenue: ${randEntropy}`);
  });

  it('doit dédupliquer efficacement lors d\'un décalage d\'octets (Boundary-Shift Invariance)', () => {
    const baseData = new Uint8Array(1024 * 1024);
    for (let i = 0; i < baseData.length; i++) baseData[i] = (i ^ (i >> 8)) & 0xff;

    const modifiedData = new Uint8Array(baseData.length + 5);
    modifiedData.set([0xaa, 0xbb, 0xcc, 0xdd, 0xee], 0);
    modifiedData.set(baseData, 5);

    const chunksV1 = FastCDC.chunk(baseData, { minSize: 16 * 1024, avgSize: 64 * 1024, maxSize: 128 * 1024 });
    const chunksV2 = FastCDC.chunk(modifiedData, { minSize: 16 * 1024, avgSize: 64 * 1024, maxSize: 128 * 1024 });

    assert.ok(chunksV1.length > 5, 'V1 doit être découpée en plusieurs blocs');
    assert.ok(chunksV2.length > 5, 'V2 doit être découpée en plusieurs blocs');

    const lengthsV1 = new Set(chunksV1.map(c => c.length));
    let matching = 0;
    for (const c of chunksV2) {
      if (lengthsV1.has(c.length)) matching++;
    }
    const matchRatio = matching / chunksV2.length;
    assert.ok(matchRatio >= 0.70, `Taux de déduplication FastCDC attendu >= 70%, obtenu: ${(matchRatio * 100).toFixed(1)}%`);
  });

  it('doit compresser et décompresser sans perte avec deflate-raw et quota de sécurité', async () => {
    const original = 'Message CRDT répliqué avec compression de flux '.repeat(200);
    const comp = await StreamCompressor.compress(original);
    assert.ok(comp.byteLength < original.length, 'Le buffer compressé doit être plus petit');

    const decomp = await StreamCompressor.decompress(comp);
    const decoded = new TextDecoder().decode(decomp);
    assert.strictEqual(decoded, original);
  });
});
