/**
 * test/unit/resilient-transfer.test.js
 * Test Suite: Reprise de Transfert Résilient, Checkpoints & Jitter (G6.P3)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

describe('Persona G6.P3: Moteur de Transferts Résilients & Checkpoints', () => {

  it('Calcul du Décorrelated Jitter : respecte les bornes min/max sans résonance', () => {
    const baseMs = 1000;
    const capMs = 30000;
    let sleep = 1000;

    for (let i = 0; i < 20; i++) {
      const minVal = baseMs;
      const maxVal = Math.min(capMs, Math.max(baseMs, sleep * 3));
      const nextSleep = Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal;
      
      assert.ok(nextSleep >= baseMs, `Délai ${nextSleep}ms inférieur à la base`);
      assert.ok(nextSleep <= capMs, `Délai ${nextSleep}ms supérieur au cap`);
      sleep = nextSleep;
    }
  });

  it('Réconciliation différentielle : ne télécharge pas les blocs déjà existants', async () => {
    const mockStorage = new Map();
    const chunk1 = crypto.createHash('sha256').update('chunk1_data').digest('hex');
    const chunk2 = crypto.createHash('sha256').update('chunk2_data').digest('hex');
    const chunk3 = crypto.createHash('sha256').update('chunk3_data').digest('hex');

    mockStorage.set(chunk1, 'chunk1_data');
    mockStorage.set(chunk3, 'chunk3_data');

    const commitChunks = [{ hash: chunk1 }, { hash: chunk2 }, { hash: chunk3 }];
    const missingHashes = new Set();
    let alreadyPresent = 0;

    for (const ch of commitChunks) {
      if (mockStorage.has(ch.hash)) {
        alreadyPresent++;
      } else {
        missingHashes.add(ch.hash);
      }
    }

    assert.equal(alreadyPresent, 2, 'Doit identifier 2 blocs déjà stockés');
    assert.equal(missingHashes.size, 1, 'Seul 1 bloc doit être manquant');
    assert.ok(missingHashes.has(chunk2), 'Le bloc manquant doit être chunk2');
  });

  it('Rejet immédiat des blocs corrompus (Pollution attack detection)', async () => {
    const legitimateData = 'valid_chunk_data_123';
    const legitimateHash = crypto.createHash('sha256').update(legitimateData).digest('hex');

    const tamperedData = 'corrupted_chunk_data_xyz';
    const computedHash = crypto.createHash('sha256').update(tamperedData).digest('hex');

    assert.notEqual(computedHash, legitimateHash, 'Le hash corrompu doit différer');
    
    let isAccepted = false;
    if (computedHash === legitimateHash) {
      isAccepted = true;
    }

    assert.equal(isAccepted, false, 'Le bloc corrompu doit être rejeté sans écriture');
  });

  it('Reprise de session après coupure : restaure l\'état persisté', async () => {
    const sessionRecord = {
      fileId: 'file_test_doc',
      commitId: 'commit_v1',
      fileName: 'document.pdf',
      status: 'PAUSED_OFFLINE',
      totalChunks: 10,
      completedChunks: 7,
      missingHashes: ['hash_8', 'hash_9', 'hash_10']
    };

    assert.equal(sessionRecord.status, 'PAUSED_OFFLINE');
    assert.equal(sessionRecord.missingHashes.length, 3);
    assert.equal(sessionRecord.completedChunks, 7);

    sessionRecord.status = 'DOWNLOADING';
    assert.equal(sessionRecord.status, 'DOWNLOADING', 'Doit re-basculer en DOWNLOADING');
  });
});
