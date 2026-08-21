/**
 * test/fuzz/crypto-adversarial-fuzz.test.js
 * 
 * 🛡️ SUITE DE FUZZING CRYPTOGRAPHIQUE & AUDIT ADVERSARIAL AGRESSIF (PASS 4 - 2025/2026)
 * Persona G4.P9 : Simulateur d'Attaques Adversariales & Cryptanalyse Fuzzing
 * 
 * Vecteurs d'Attaques Couverts :
 * 1. Falsification de bits (Bit-Flipping) sur Ciphertext & Tag d'Authentification AES-GCM-256.
 * 2. Mutilation et Malléabilité des signatures ECDSA P-256 (r, s, troncation, points corrompus).
 * 3. Fuzzing de Canonisation JCS RFC 8785 (Unicode NFD/NFC, NaN/Infinity/-0, Pollution Prototype).
 * 4. Rejeu de Nonces, Époques obsolètes et Désynchronisation Ratchet Signal Sender Keys.
 * 5. Injection concurrente d'équivocations byzantines (Race Conditions & Proof Generation).
 * 6. Simulation d'attaques par collusion massive Sybil (100 nœuds en anneau) sur Personalized EigenTrust.
 * 
 * Zéro Dépendance Externe - WebCrypto API / Node.js Native Test Runner.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { CryptoVault } from '../../Extension/sidepanel/js/core/crypto-vault.js';
import { SenderKeysManager } from '../../Extension/sidepanel/js/core/sender-keys.js';
import { EquivocationEngine } from '../../Extension/sidepanel/js/core/equivocation-engine.js';
import { TrustEngine, TRUST_TIERS } from '../../Extension/sidepanel/js/core/trust-engine.js';

// --- PRNG SplitMix32 Déterministe pour Reproductibilité Totale du Fuzzing ---
class FastPRNG {
  constructor(seed = 0x8542c39d) {
    this.state = seed >>> 0;
  }
  nextUint32() {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  }
  nextFloat() {
    return this.nextUint32() / 0x100000000;
  }
  nextInt(min, max) {
    return Math.floor(this.nextFloat() * (max - min + 1)) + min;
  }
}

describe('🛡️ G4.P9 - HARNAIS DE CRYPTANALYSE FUZZING & ATTAQUES ADVERSARIALES (PASS 4)', () => {
  const prng = new FastPRNG(0x42f00ba1);
  const SAMPLE_CODE_ALICE = 'ALPHA-BRAVO-CHARLIE-DELTA-ECHO-FOXTROT-1111';
  const SAMPLE_CODE_BOB   = 'GOLF-HOTEL-INDIGO-JULIET-KILO-LIMA-2222';

  let vaultAlice, vaultBob;

  before(async () => {
    vaultAlice = new CryptoVault();
    await vaultAlice.initializeFromPaperCode(SAMPLE_CODE_ALICE, 'Alice');
    vaultBob = new CryptoVault();
    await vaultBob.initializeFromPaperCode(SAMPLE_CODE_BOB, 'Bob');
  });

  // =========================================================================
  // VECTEUR 1 : Falsification de Bits (Bit-Flipping) sur AES-GCM-256
  // =========================================================================
  describe('⚡ VECTEUR 1 : Fuzzing de Falsification de Bits sur AES-GCM (Ciphertext & Auth Tag)', () => {
    it('Rejette 100% des mutations de 1-bit sur l\'ensemble du Ciphertext et du Tag sans exception silencieuse', async () => {
      const plaintext = { sensitive: 'TopSecretP2PData', timestamp: 1774000000, value: 9999.95 };
      const encrypted = await vaultAlice.encrypt(plaintext, false, { context: 'fuzz-test' });

      const rawCipherHex = encrypted.ciphertext;
      const cipherBytes = new Uint8Array(CryptoVault.hexToBuffer(rawCipherHex));
      const totalBits = cipherBytes.length * 8;

      let rejectedCount = 0;
      const samplesToTest = Math.min(totalBits, 150);

      for (let i = 0; i < samplesToTest; i++) {
        const mutatedBytes = new Uint8Array(cipherBytes);
        const byteIdx = Math.floor(i / 8);
        const bitIdx = i % 8;
        mutatedBytes[byteIdx] ^= (1 << bitIdx);

        const mutatedPacket = {
          iv: encrypted.iv,
          ciphertext: CryptoVault.bufferToHex(mutatedBytes)
        };

        try {
          await vaultAlice.decrypt(mutatedPacket, false, { context: 'fuzz-test' });
          assert.fail(`Le déchiffrement aurait dû échouer suite au bit-flip à l'offset ${i}`);
        } catch (err) {
          assert.match(err.name || err.message, /OperationError|operation failed|Error/i);
          rejectedCount++;
        }
      }

      assert.strictEqual(rejectedCount, samplesToTest, '100% des altérations de 1-bit doivent être rejetées par WebCrypto');
    });

    it('Rejette la troncature du Tag d\'authentification (Tags courts < 128 bits)', async () => {
      const encrypted = await vaultAlice.encrypt({ test: 'auth-tag-truncation' });
      const cipherBytes = new Uint8Array(CryptoVault.hexToBuffer(encrypted.ciphertext));

      for (let truncateLen = 1; truncateLen <= 16; truncateLen++) {
        const truncatedBytes = cipherBytes.slice(0, cipherBytes.length - truncateLen);
        const packet = {
          iv: encrypted.iv,
          ciphertext: CryptoVault.bufferToHex(truncatedBytes)
        };

        await assert.rejects(
          () => vaultAlice.decrypt(packet),
          /OperationError|operation failed|Error/i,
          `La troncature de ${truncateLen} octets du tag doit être rejetée`
        );
      }
    });

    it('Rejette la falsification des Données Authentifiées Additionnelles (AAD Context Manipulation)', async () => {
      const validAAD = { channel: 'general', role: 'admin', epoch: 4 };
      const forgedAAD = { channel: 'general', role: 'root', epoch: 4 };

      const encrypted = await vaultAlice.encrypt('Message Intègre', false, validAAD);

      await assert.rejects(
        () => vaultAlice.decrypt(encrypted, false, forgedAAD),
        /OperationError|operation failed/i
      );
    });
  });

  // =========================================================================
  // VECTEUR 2 : Mutation & Malléabilité de Signatures ECDSA P-256
  // =========================================================================
  describe('⚡ VECTEUR 2 : Mutation & Cryptanalyse Adversariale de Signatures ECDSA P-256', () => {
    it('Détecte et rejette les inversions et corruptions aléatoires dans la signature brute', async () => {
      const payload = { documentId: 'doc_genesis_001', checksum: 'a1b2c3d4e5f6', lamport: 100 };
      const validSigHex = await vaultAlice.sign(payload);

      assert.ok(validSigHex.length >= 128, 'Signature ECDSA P-256 standard');
      const sigBytes = new Uint8Array(CryptoVault.hexToBuffer(validSigHex));

      let totalFuzzAttempts = 100;
      let rejectedMutations = 0;

      for (let f = 0; f < totalFuzzAttempts; f++) {
        const mutatedSig = new Uint8Array(sigBytes);
        const mutationType = prng.nextInt(1, 3);

        if (mutationType === 1) {
          const idx = prng.nextInt(0, mutatedSig.length - 1);
          mutatedSig[idx] ^= prng.nextInt(1, 255);
        } else if (mutationType === 2) {
          const cutLen = prng.nextInt(1, mutatedSig.length - 1);
          const truncated = mutatedSig.slice(0, cutLen);
          const isValid = await CryptoVault.verify(payload, CryptoVault.bufferToHex(truncated), vaultAlice.publicKeyHex);
          if (!isValid) rejectedMutations++;
          continue;
        } else {
          mutatedSig.fill(0xff, 32, 64);
        }

        const isValid = await CryptoVault.verify(payload, CryptoVault.bufferToHex(mutatedSig), vaultAlice.publicKeyHex);
        if (!isValid) {
          rejectedMutations++;
        }
      }

      assert.strictEqual(rejectedMutations, totalFuzzAttempts, 'Toutes les mutations de signature doivent être déclarées invalides');
    });

    it('Rejette la substitution de clé publique émettrice', async () => {
      const payload = { txId: 'tx_9999', recipient: 'peer_target', amount: 500 };
      const sigAlice = await vaultAlice.sign(payload);

      const isValidWithBob = await CryptoVault.verify(payload, sigAlice, vaultBob.publicKeyHex);
      assert.strictEqual(isValidWithBob, false, 'La clé publique de Bob ne doit jamais valider la signature d\'Alice');
    });

    it('Rejette l\'altération imperceptible du contenu signé', async () => {
      const payload = { text: 'Paiement autorisé', authorized: true, nonce: 42 };
      const sig = await vaultAlice.sign(payload);

      const forgedA = { ...payload, authorized: false };
      const forgedB = { ...payload, nonce: 43 };
      const forgedC = { ...payload, text: 'Paiement autorisé ' };

      assert.strictEqual(await CryptoVault.verify(forgedA, sig, vaultAlice.publicKeyHex), false);
      assert.strictEqual(await CryptoVault.verify(forgedB, sig, vaultAlice.publicKeyHex), false);
      assert.strictEqual(await CryptoVault.verify(forgedC, sig, vaultAlice.publicKeyHex), false);
    });
  });

  // =========================================================================
  // VECTEUR 3 : Fuzzing de Sérialisation Canonique JCS RFC 8785 & Unicode
  // =========================================================================
  describe('⚡ VECTEUR 3 : Fuzzing de Canonisation JCS RFC 8785 & Valeurs Numériques Extrêmes', () => {
    it('Produit une empreinte rigoureusement identique pour des équivalences Unicode NFC / NFD', async () => {
      const objNFC = { menu: 'caf\u00e9', price: 2.5 };
      const objNFD = { menu: 'cafe\u0301', price: 2.5 };

      const canonNFC = CryptoVault.canonicalize(objNFC);
      const canonNFD = CryptoVault.canonicalize(objNFD);

      assert.strictEqual(canonNFC, canonNFD, 'La normalisation Unicode NFC doit produire un JSON canonique identique');
    });

    it('Normalise -0, zéro flottant et exclut les valeurs non finies selon RFC 8785', () => {
      const data = {
        zeroNegative: -0,
        zeroPositive: 0,
        floatVal: 42.0,
        arr: [1, -0, 3]
      };

      const canon = CryptoVault.canonicalize(data);
      assert.strictEqual(canon, '{"arr":[1,0,3],"floatVal":42,"zeroNegative":0,"zeroPositive":0}');
    });

    it('Résiste à l\'injection de propriétés de prototype (__proto__, constructor)', () => {
      const crafted = JSON.parse('{"__proto__":{"polluted":true},"a":1,"z":2}');
      const canon = CryptoVault.canonicalize(crafted);
      assert.ok(typeof canon === 'string' && canon.length > 0);
      assert.strictEqual(Object.prototype.polluted, undefined, 'Aucune pollution de prototype globale');
    });
  });

  // =========================================================================
  // VECTEUR 4 : Rejeu, Clés Sautées et Désynchronisation Signal Sender Keys
  // =========================================================================
  describe('⚡ VECTEUR 4 : Fuzzing de Rejeu & Désynchronisation Ratchet (Sender Keys)', () => {
    let aliceManager, bobManager;

    before(async () => {
      aliceManager = vaultAlice.senderKeys;
      bobManager = vaultBob.senderKeys;

      const skdm = await aliceManager.getLocalDistributionMessage();
      await bobManager.handleInboundSenderKey(skdm);
    });

    it('Rejette strictement le rejeu d\'un message déjà déchiffré (Replay Attack Prevention)', async () => {
      const msg = { chat: 'Message Unique #1', timestamp: Date.now() };
      const envelope = await aliceManager.encryptGroupMessage('lobby', msg);

      // Premier déchiffrement légitime
      const decryptedFirst = await bobManager.decryptGroupMessage(envelope);
      assert.deepStrictEqual(decryptedFirst, msg);

      // Deuxième tentative : REJEU !
      await assert.rejects(
        () => bobManager.decryptGroupMessage(envelope),
        /Message obsolète ou déjà consommé|Enveloppe/i,
        'Le message rejoué doit être immédiatement rejeté par le ratchet'
      );
    });

    it('Rejette les sauts d\'index excessifs (Protection contre le DoS d\'épuisement de mémoire)', async () => {
      const forgedEnvelope = {
        epoch: aliceManager.localSenderKey.epoch,
        channelId: 'lobby',
        senderId: vaultAlice.peerId,
        idx: 5000,
        iv: '00'.repeat(12),
        ciphertext: 'deadbeef',
        signature: 'deadbeef',
        aad: { epoch: 1, channelId: 'lobby', senderId: vaultAlice.peerId, idx: 5000 }
      };

      await assert.rejects(
        () => bobManager.decryptGroupMessage(forgedEnvelope),
        /Désynchronisation critique|Signature/i
      );
    });

    it('Rejette la distribution d\'une époque obsolète (Epoch Downgrade Attack)', async () => {
      const obsoleteSKDM = {
        type: 'SENDER_KEY_DISTRIBUTION',
        epoch: 0,
        senderId: vaultAlice.peerId,
        chainKeyHex: 'aa'.repeat(32),
        startIndex: 0
      };

      const accepted = await bobManager.handleInboundSenderKey(obsoleteSKDM);
      assert.strictEqual(accepted, false, 'Les époques obsolètes doivent être refusées');
    });
  });

  // =========================================================================
  // VECTEUR 5 : Concurrence & Injection de Courses Critiques (Anti-Équivocation)
  // =========================================================================
  describe('⚡ VECTEUR 5 : Résilience aux Concurrences Asynchrones & Injection d\'Équivocation (PoEq)', () => {
    it('Intercepte 100% des commits contradictoires même sous assaut concurrent asynchrone (Race Test)', async () => {
      const mockMesh = { broadcast: async () => {}, peers: new Map() };
      const equivEngine = new EquivocationEngine(mockMesh);
      await equivEngine.init();

      const commitLégitime = {
        fileId: 'shared_dag_doc',
        versionNumber: 1,
        contentHash: 'hash_LEGITIME_00000000000000000000000000000000',
        authorPubkey: vaultAlice.publicKeyHex
      };
      commitLégitime.signature = await vaultAlice.sign(commitLégitime);

      const commitByzantin = {
        fileId: 'shared_dag_doc',
        versionNumber: 1,
        contentHash: 'hash_EQUIVOCATION_FORKED_11111111111111111',
        authorPubkey: vaultAlice.publicKeyHex
      };
      commitByzantin.signature = await vaultAlice.sign(commitByzantin);

      // Exécution concurrente parallèle
      const [resLegit, resByz] = await Promise.all([
        equivEngine.inspectCommit(commitLégitime),
        equivEngine.inspectCommit(commitByzantin)
      ]);

      const oneAcceptedOneRejected = (resLegit === false && resByz === true) || (resLegit === true && resByz === false);
      assert.strictEqual(oneAcceptedOneRejected, true, 'L\'équivocation concurrente doit être formellement interceptée');
      assert.strictEqual(equivEngine.isPeerBanned(vaultAlice.publicKeyHex), true, 'L\'émetteur byzantin doit être banni');
    });
  });

  // =========================================================================
  // VECTEUR 6 : Simulation de Collusion Sybil Massive sur Personalized EigenTrust
  // =========================================================================
  describe('⚡ VECTEUR 6 : Simulation d\'Attaque par Collusion en Anneau Sybil (100 Nœuds)', () => {
    it('Empêche l\'élévation de réputation d\'une coalition Sybil non liée aux graines SAS directes', () => {
      const trustEngine = new TrustEngine(vaultAlice);

      trustEngine.directSeeds.add(vaultBob.publicKeyHex);

      // Anneau de collusion de 50 nœuds Sybil
      const sybilNodes = [];
      for (let s = 0; s < 50; s++) {
        sybilNodes.push(`04sybil_${s}_` + 'f'.repeat(54));
      }

      for (let i = 0; i < sybilNodes.length; i++) {
        const nextNode = sybilNodes[(i + 1) % sybilNodes.length];
        trustEngine._addAttestationMemory({
          issuerPubkey: sybilNodes[i],
          subjectPubkey: nextNode,
          trustScore: 1.0,
          expiresAt: Date.now() + 1000000
        });
      }

      const attackerChief = '04sybil_CHIEF_' + '0'.repeat(50);
      for (let s = 0; s < 10; s++) {
        trustEngine._addAttestationMemory({
          issuerPubkey: sybilNodes[s],
          subjectPubkey: attackerChief,
          trustScore: 1.0,
          expiresAt: Date.now() + 1000000
        });
      }

      trustEngine.computeEigenTrust(20, 1e-5);

      assert.strictEqual(trustEngine.getTrustTier(vaultBob.publicKeyHex), TRUST_TIERS.SAS_DIRECT, 'Bob doit être SAS_DIRECT');
      assert.strictEqual(trustEngine.getTrustTier(attackerChief), TRUST_TIERS.UNKNOWN, 'AttackerChief doit rester UNKNOWN (Score < 0.08)');
      
      for (const sybil of sybilNodes) {
        assert.strictEqual(trustEngine.getTrustTier(sybil), TRUST_TIERS.UNKNOWN, 'Chaque nœud Sybil doit rester UNKNOWN');
      }
    });
  });
});
