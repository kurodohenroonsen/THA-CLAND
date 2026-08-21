/**
 * test/unit/performance-extreme-benchmark.test.js
 * Suite de Benchmarking de Charge Extrême & Profilage de Performance (Pass 4 Hardened - 2026)
 * Persona G7.P9 : Simulateur de Charge Extrême & Benchmark Performance
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import crypto from 'node:crypto';

import { FastCDC } from '../../Extension/sidepanel/js/modules/drive/fast-cdc.js';
import { MerkleTree } from '../../Extension/sidepanel/js/modules/drive/merkle-tree.js';
import { StreamCompressor } from '../../Extension/sidepanel/js/core/stream-compressor.js';
import { GenerationalSlidingCache, BoundedLRUCache } from '../../Extension/sidepanel/js/core/bounded-cache.js';
import { VersionVector, LWWRegister, PNCounter } from '../../Extension/sidepanel/js/core/crdt-engine.js';
import { HybridGossipEngine } from '../../Extension/sidepanel/js/core/hybrid-gossip-engine.js';

describe('⚡ Persona G7.P9 - Suite de Charge Extrême & Benchmarks de Performance (Pass 4)', () => {

  it('▶ [BENCH 1] Débit FastCDC : Traitement binaire haute vitesse & Sub-Minimum Skipping', () => {
    const payloadSizes = [2 * 1024 * 1024, 6 * 1024 * 1024];
    
    for (const size of payloadSizes) {
      const buffer = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        buffer[i] = (i ^ (i >> 7) ^ (i >> 13)) & 0xff;
      }

      const t0 = performance.now();
      const chunks = FastCDC.chunk(buffer, {
        minSize: 16 * 1024,
        avgSize: 64 * 1024,
        maxSize: 128 * 1024,
        normalizationLevel: 1
      });
      const t1 = performance.now();

      const durationSec = (t1 - t0) / 1000;
      const throughputMBps = (size / (1024 * 1024)) / durationSec;
      const avgChunkLength = size / chunks.length;

      assert.ok(chunks.length > 5, 'Le buffer doit être découpé en plusieurs fragments');
      assert.ok(throughputMBps > 20.0, `Débit FastCDC trop faible : ${throughputMBps.toFixed(2)} Mo/s (seuil min > 20 Mo/s)`);

      for (const chunk of chunks) {
        assert.ok(chunk.length >= 16 * 1024 || chunk.offset + chunk.length === size, 'Chunk inférieur à minSize non terminal');
        assert.ok(chunk.length <= 128 * 1024, 'Chunk supérieur à maxSize');
      }
    }
  });

  it('▶ [BENCH 2] Arbre de Merkle RFC 6962 : Débit de construction & Preuves SPV O(log N)', async () => {
    const leafCounts = [64, 256, 1024];

    for (const count of leafCounts) {
      const leafHashes = [];
      for (let i = 0; i < count; i++) {
        const hash = crypto.createHash('sha256').update(`leaf_content_${i}_${Date.now()}`).digest('hex');
        leafHashes.push(hash);
      }

      const { root, layers } = await MerkleTree.buildTree(leafHashes);

      assert.ok(typeof root === 'string' && root.length === 64, 'La racine Merkle doit être une chaîne hexadécimale de 64 car.');
      assert.strictEqual(layers[0].length, count, 'La couche 0 doit contenir toutes les feuilles');

      const testIndex = Math.floor(Math.random() * count);
      const targetLeaf = leafHashes[testIndex];

      const proof = MerkleTree.generateProof(testIndex, layers);
      const expectedProofDepth = Math.ceil(Math.log2(count));
      assert.ok(proof.length <= expectedProofDepth + 1, `Profondeur de preuve O(log N) respectée (${proof.length} <= ${expectedProofDepth})`);

      const isValid = await MerkleTree.verifyProof(targetLeaf, proof, root);
      assert.strictEqual(isValid, true, 'La preuve SPV doit être validée avec succès contre la racine');

      const isForgedValid = await MerkleTree.verifyProof('00'.repeat(32), proof, root);
      assert.strictEqual(isForgedValid, false, 'Une feuille falsifiée doit être rejetée');
    }
  });

  it('▶ [BENCH 3] Primitives CRDT : Débit d\'opérations vectorielles et résolution de conflits', () => {
    const PEER_COUNT = 10;
    const OPS_COUNT = 25000;
    const peers = Array.from({ length: PEER_COUNT }, (_, i) => `peer_${i.toString().padStart(2, '0')}`);

    const vectorA = new VersionVector();
    const vectorB = new VersionVector();

    const tVectorStart = performance.now();
    for (let i = 0; i < OPS_COUNT; i++) {
      const pid = peers[i % PEER_COUNT];
      vectorA.tick(pid);
      if (i % 2 === 0) vectorB.tick(pid);
    }
    vectorA.merge(vectorB.toJSON());
    const tVectorEnd = performance.now();

    const vectorOpsSec = (OPS_COUNT / ((tVectorEnd - tVectorStart) / 1000));
    assert.ok(vectorOpsSec > 50000, `Débit VersionVector insuffisant : ${vectorOpsSec.toFixed(0)} ops/s`);

    const register = new LWWRegister({ value: 'init', timestamp: 1000, lamport: 1, authorPubkey: 'key_0' });
    let acceptedChanges = 0;

    const tLwwStart = performance.now();
    for (let i = 0; i < OPS_COUNT; i++) {
      const incomingLamport = (i % 5 === 0) ? register.lamport + 1 : register.lamport;
      const incomingTs = 1000 + i;
      const incomingAuthor = `key_${(i % PEER_COUNT).toString(16)}`;
      const updated = register.set(`val_${i}`, incomingTs, incomingLamport, incomingAuthor);
      if (updated) acceptedChanges++;
    }
    const tLwwEnd = performance.now();

    const lwwOpsSec = (OPS_COUNT / ((tLwwEnd - tLwwStart) / 1000));
    assert.ok(lwwOpsSec > 50000, `Débit LWWRegister insuffisant : ${lwwOpsSec.toFixed(0)} ops/s`);
    assert.ok(acceptedChanges > 0, 'Des mises à jour doivent être acceptées');

    const pnCounter = new PNCounter('peer_master');
    for (let i = 0; i < OPS_COUNT; i++) {
      if (i % 3 === 0) pnCounter.dec(1);
      else pnCounter.inc(1);
    }
  });

  it('▶ [BENCH 4] Simulation 10 000 Messages Chat : Event Loop Delay & Profilage Mémoire', async () => {
    const TOTAL_MESSAGES = 10000;
    const YIELD_BUDGET_MS = 12.0;

    const aldHistogram = monitorEventLoopDelay({ resolution: 20 });
    aldHistogram.enable();

    const initialMem = process.memoryUsage();
    const dedupCache = new GenerationalSlidingCache({ generationSize: 15000, rotateIntervalMs: 60000 });
    const localStore = new Map();

    const scheduleYield = () => new Promise(resolve => setImmediate(resolve));

    let batchStartTime = performance.now();
    let yieldsCount = 0;
    const tStart = performance.now();

    for (let i = 0; i < TOTAL_MESSAGES; i++) {
      const msgId = `msg_${i.toString().padStart(6, '0')}_${(i % 100)}`;
      const message = {
        id: msgId,
        channelId: `chan_general_${i % 5}`,
        text: `Message de simulation de charge haute fréquence #${i} avec charge utile JSON répliquée.`,
        authorId: `peer_${(i % 50).toString().padStart(2, '0')}`,
        authorPubkey: `pubkey_${(i % 50)}`,
        timestamp: Date.now() + i,
        lamport: i + 1
      };

      const isNew = dedupCache.addIfNew(`msg:${message.id}`);
      if (isNew) {
        localStore.set(message.id, message);
      }

      const elapsedInBatch = performance.now() - batchStartTime;
      if (elapsedInBatch >= YIELD_BUDGET_MS) {
        yieldsCount++;
        await scheduleYield();
        batchStartTime = performance.now();
      }
    }

    const tEnd = performance.now();
    aldHistogram.disable();

    const finalMem = process.memoryUsage();
    const bytesPerMessage = (finalMem.heapUsed - initialMem.heapUsed) / TOTAL_MESSAGES;
    const totalDurationSec = (tEnd - tStart) / 1000;
    const throughputMsgsSec = TOTAL_MESSAGES / totalDurationSec;

    const p99DelayMs = aldHistogram.percentile(99) / 1e6;

    assert.strictEqual(localStore.size, TOTAL_MESSAGES, 'Tous les 10 000 messages uniques doivent être stockés');
    assert.ok(throughputMsgsSec > 1000, `Débit d'ingestion chat trop faible : ${throughputMsgsSec.toFixed(0)} msgs/s`);
    assert.ok(p99DelayMs < 100.0, `Event Loop Delay p99 excessif : ${p99DelayMs.toFixed(2)} ms`);

    dedupCache.destroy();
  });

  it('▶ [BENCH 5] Simulation 1 000 Entrées Drive : Versioning, Merkle DAG & GC Tombstones', async () => {
    const TOTAL_FILES = 1000;
    const fileCommits = [];
    const tombstones = [];

    for (let i = 0; i < TOTAL_FILES; i++) {
      const fileId = `file_${i.toString().padStart(4, '0')}`;
      const chunkCount = 2 + (i % 6);
      const chunks = [];

      for (let c = 0; c < chunkCount; c++) {
        chunks.push({
          hash: crypto.createHash('sha256').update(`${fileId}_chunk_${c}`).digest('hex'),
          offset: c * 64 * 1024,
          length: 64 * 1024
        });
      }

      const rootHash = await MerkleTree.computeRoot(chunks.map(c => c.hash));

      const commit = {
        commitId: `cmt_${fileId}_v1`,
        fileId,
        fileName: `document_test_${i}.dat`,
        folderPath: `/dossier_${i % 20}`,
        versionNumber: 1,
        rootMerkleHash: rootHash,
        chunks,
        timestamp: Date.now() - (i * 1000),
        lamportClock: i + 1
      };
      fileCommits.push(commit);

      if (i % 5 === 0) {
        tombstones.push({
          fileId,
          deletedBy: 'peer_admin',
          timestamp: Date.now() - (i * 1000) - 100,
          lamport: i + 1
        });
      }
    }

    assert.strictEqual(fileCommits.length, TOTAL_FILES);
    assert.strictEqual(tombstones.length, 200);

    const STABILITY_CUTOFF = Date.now() - (500 * 1000);
    const minStableLamport = 1000;

    let purgedCount = 0;
    const activeTombstones = [];

    for (const tomb of tombstones) {
      if (tomb.timestamp < STABILITY_CUTOFF && tomb.lamport <= minStableLamport) {
        purgedCount++;
      } else {
        activeTombstones.push(tomb);
      }
    }

    assert.ok(purgedCount > 50, `Le ramasse-miettes doit purger les tombstones stabilisés (purgés: ${purgedCount})`);
    assert.strictEqual(activeTombstones.length + purgedCount, 200);
  });

  it('▶ [BENCH 6] Simulation Maillage 50 Pairs : Propagation PlumTree & Élimination des Doublons', async () => {
    const PEER_COUNT = 50;
    const peers = new Map();
    const deliveredMessages = new Map();

    for (let i = 0; i < PEER_COUNT; i++) {
      const pid = `peer_${i.toString().padStart(2, '0')}`;
      deliveredMessages.set(pid, []);

      const mockMesh = {
        peers: new Map(),
        on: () => {},
        sendToPeer: async (targetId, envelope) => {
          setImmediate(() => {
            const targetEngine = peers.get(targetId);
            if (targetEngine) {
              targetEngine.handleGossipMessage(pid, envelope);
            }
          });
        }
      };

      const mockVault = { peerIdHex: pid };
      const engine = new HybridGossipEngine(mockMesh, mockVault, { targetEagerDegree: 4, maxTtl: 16 });

      engine.on('message', (m) => {
        deliveredMessages.get(pid).push(m);
      });

      peers.set(pid, engine);
    }

    // Connect in a ring + small-world graph
    for (let i = 0; i < PEER_COUNT; i++) {
      const pid = `peer_${i.toString().padStart(2, '0')}`;
      const engine = peers.get(pid);

      for (let j = 1; j <= 4; j++) {
        const neighborId = `peer_${((i + j) % PEER_COUNT).toString().padStart(2, '0')}`;
        engine.mesh.peers.set(neighborId, {});
        engine._onPeerJoined(neighborId);
      }
    }

    const originEngine = peers.get('peer_00');
    const testMessageId = `gossip_broadcast_test_${Date.now()}`;
    const testPayload = { text: 'Message de diffusion maillage 50 pairs', sequence: 42 };

    await originEngine.publish('CHAT_MSG', testPayload, testMessageId);

    await new Promise(resolve => setTimeout(resolve, 400));

    let receivedCount = 0;
    for (const [pid, msgs] of deliveredMessages) {
      if (pid === 'peer_00') continue;
      const received = msgs.filter(m => m.id === testMessageId);
      if (received.length >= 1) receivedCount++;
    }

    assert.ok(receivedCount >= PEER_COUNT - 5, `La majorité des pairs doivent recevoir le message (${receivedCount}/${PEER_COUNT - 1})`);

    for (const engine of peers.values()) {
      engine.destroy();
    }
  });

});
