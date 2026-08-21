/**
 * test/unit/crypto-hlc.test.js
 * Validation Formelle des Invariants Crypto-HLC (Pass 4 Hardened)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CryptoHLC } from '../../Extension/sidepanel/js/core/crypto-hlc.js';

describe('⏱️ Persona G4.P8 - Tests Crypto-HLC & Horodatage Causal', () => {

  it('1. Monotonicité locale & Hash Chaining SHA-256', async () => {
    const hlc = new CryptoHLC({ actorPubkey: 'pub_alice_01', peerId: 'peer_alice' });
    const t1 = await hlc.tick({ msg: 'Premier message' });
    const t2 = await hlc.tick({ msg: 'Deuxième message' });
    const t3 = await hlc.tick({ msg: 'Troisième message' });

    assert.ok(CryptoHLC.happensBefore(t1, t2), 't1 doit précéder t2');
    assert.ok(CryptoHLC.happensBefore(t2, t3), 't2 doit précéder t3');
    assert.equal(t2.prevHash, t1.h, 't2.prevHash doit correspondre à t1.h');
    assert.equal(t3.prevHash, t2.h, 't3.prevHash doit correspondre à t2.h');
    assert.equal(t3.seq, 3, 'La séquence locale doit être incrémentée à 3');
  });

  it('2. Échange inter-pairs et synchronisation causale', async () => {
    const alice = new CryptoHLC({ actorPubkey: 'pub_alice', peerId: 'peer_alice' });
    const bob = new CryptoHLC({ actorPubkey: 'pub_bob', peerId: 'peer_bob' });

    const msgAlice = { text: 'Hello Bob' };
    const tAlice = await alice.tick(msgAlice);

    const receiveResult = await bob.receive(tAlice, msgAlice);
    assert.equal(receiveResult.valid, true, 'Bob doit accepter le tick valide d\'Alice');

    const msgBob = { text: 'Hello Alice, bien reçu' };
    const tBob = await bob.tick(msgBob);

    assert.ok(CryptoHLC.happensBefore(tAlice, tBob), 'La réponse de Bob doit être strictement postérieure');
  });

  it('3. Défense BFT contre le Clock Jacking (> maxDriftMs)', async () => {
    const bob = new CryptoHLC({ actorPubkey: 'pub_bob', peerId: 'peer_bob', maxDriftMs: 5000 });

    const futureTimestamp = {
      l: Date.now() + 100000, // +100 secondes dans le futur
      c: 0,
      seq: 1,
      h: 'dummy_hash',
      prevHash: 'genesis',
      actor: 'pub_mallory',
      peerId: 'peer_mallory'
    };

    const res = await bob.receive(futureTimestamp, { attack: true });
    assert.equal(res.valid, false, 'Le tick futuriste doit être rejeté');
    assert.match(res.error, /Dérive temporelle physique excessive/, 'Message d\'erreur explicite');
  });

  it('4. Détection formelle d\'équivocation temporelle (PoEq)', async () => {
    const bob = new CryptoHLC({ actorPubkey: 'pub_bob', peerId: 'peer_bob' });

    const payloadA = { vote: 'OPTION_A' };
    const payloadB = { vote: 'OPTION_B' };

    const forgedL = Date.now();
    const forgedC = 4;
    const digestA = await CryptoHLC.sha256(JSON.stringify(payloadA));
    const digestB = await CryptoHLC.sha256(JSON.stringify(payloadB));

    const hashA = await CryptoHLC.sha256(`genesis:${forgedL}:${forgedC}:1:pub_mallory:${digestA}`);
    const hashB = await CryptoHLC.sha256(`genesis:${forgedL}:${forgedC}:1:pub_mallory:${digestB}`);

    const tickMalloryA = {
      l: forgedL, c: forgedC, seq: 1, h: hashA, prevHash: 'genesis', actor: 'pub_mallory', peerId: 'peer_mallory'
    };
    const tickMalloryB = {
      l: forgedL, c: forgedC, seq: 1, h: hashB, prevHash: 'genesis', actor: 'pub_mallory', peerId: 'peer_mallory'
    };

    const resA = await bob.receive(tickMalloryA, payloadA);
    assert.equal(resA.valid, true, 'Premier message accepté');

    const resB = await bob.receive(tickMalloryB, payloadB);
    assert.equal(resB.valid, false, 'Second message avec même tick mais payload différent rejeté');
    assert.equal(resB.isEquivocation, true, 'Flag d\'équivocation activé');
  });
});
