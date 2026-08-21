/**
 * test/unit/swarm-piece-picker.test.js
 * Validation unitaire de l'ordonnanceur BitTorrent-Like, Bitfields et Endgame Mode (G6.P2)
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { CompactBitfield, SwarmPiecePicker } from '../../Extension/sidepanel/js/modules/drive/drive-transfer.js';

describe('⚡ G6.P2 - Moteur Swarming P2P BitTorrent-Like & Rarest-First', () => {
  it('doit manipuler un CompactBitfield avec SWAR popcount et Base64 sans perte', () => {
    const totalChunks = 80;
    const bf = new CompactBitfield(totalChunks);

    assert.strictEqual(bf.cardinality(), 0);
    assert.strictEqual(bf.isComplete(), false);

    bf.set(0, true);
    bf.set(7, true);
    bf.set(8, true);
    bf.set(79, true);

    assert.strictEqual(bf.get(0), true);
    assert.strictEqual(bf.get(1), false);
    assert.strictEqual(bf.get(79), true);
    assert.strictEqual(bf.cardinality(), 4);

    const b64 = bf.toBase64();
    const restored = CompactBitfield.fromBase64(b64, totalChunks);
    assert.strictEqual(restored.cardinality(), 4);
    assert.strictEqual(restored.get(7), true);
    assert.strictEqual(restored.get(79), true);
  });

  it('doit prioriser les blocs les plus rares (Rarest-First) avec distribution anti-convoi', () => {
    const commit = {
      fileId: 'file_test_rarity',
      fileName: 'document.pdf',
      chunks: Array.from({ length: 10 }, (_, i) => ({ hash: `hash_${i}` }))
    };

    const picker = new SwarmPiecePicker(commit);
    picker.RANDOM_FIRST_THRESHOLD = 0; // Forcer le mode Rarest-First direct

    // Pair A a les blocs 0, 1, 2
    const bfA = new CompactBitfield(10);
    bfA.set(0, true); bfA.set(1, true); bfA.set(2, true);
    picker.updatePeerBitfield('peerA', bfA);

    // Pair B a les blocs 2, 3
    const bfB = new CompactBitfield(10);
    bfB.set(2, true); bfB.set(3, true);
    picker.updatePeerBitfield('peerB', bfB);

    // Blocs 0, 1 ont rareté 1 (sur peerA)
    // Bloc 3 a rareté 1 (sur peerB)
    // Bloc 2 a rareté 2 (sur peerA et peerB)
    const inFlight = new Map();
    const picked = picker.pickNextRequests({
      inFlightMap: inFlight,
      activePeerIds: ['peerA', 'peerB'],
      maxBatchSize: 2
    });

    assert.strictEqual(picked.length, 2);
    // Les blocs choisis doivent être parmi les plus rares (0, 1 ou 3) et PAS le bloc 2
    assert.ok(picked.every(req => [0, 1, 3].includes(req.index)), 'Doit prioriser les blocs de rareté 1');
  });

  it('doit basculer en Endgame Mode et dupliquer les requêtes pour les derniers blocs', () => {
    const commit = {
      fileId: 'file_test_endgame',
      fileName: 'archive.zip',
      chunks: Array.from({ length: 20 }, (_, i) => ({ hash: `hash_end_${i}` }))
    };

    const picker = new SwarmPiecePicker(commit);
    // Simuler que 18 blocs sur 20 sont acquis
    for (let i = 0; i < 18; i++) {
      picker.updateLocalChunk(i, true);
    }

    assert.strictEqual(picker.isEndgame(), true, 'Doit être en mode Endgame (2 blocs restants)');

    const bfA = new CompactBitfield(20);
    bfA.set(18, true); bfA.set(19, true);
    picker.updatePeerBitfield('peerA', bfA);

    const bfB = new CompactBitfield(20);
    bfB.set(18, true); bfB.set(19, true);
    picker.updatePeerBitfield('peerB', bfB);

    const inFlight = new Map();
    const requests = picker.pickNextRequests({
      inFlightMap: inFlight,
      activePeerIds: ['peerA', 'peerB'],
      maxBatchSize: 10
    });

    // En mode Endgame, le bloc 18 et 19 doivent être demandés à peerA ET peerB en miroir
    assert.strictEqual(requests.length, 4);
    assert.ok(requests.some(r => r.index === 18 && r.peerId === 'peerA'));
    assert.ok(requests.some(r => r.index === 18 && r.peerId === 'peerB'));
    assert.ok(requests.some(r => r.index === 19 && r.peerId === 'peerA'));
    assert.ok(requests.some(r => r.index === 19 && r.peerId === 'peerB'));
  });
});
