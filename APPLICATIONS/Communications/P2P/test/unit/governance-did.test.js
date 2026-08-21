import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { Multibase, Multicodec } from '../../Extension/sidepanel/js/core/did-codec.js';
import { DIDDocumentResolver } from '../../Extension/sidepanel/js/core/did-resolver.js';
import { WireFrameCodec, WIRE_CONSTANTS, SemVerNegotiator } from '../../Extension/sidepanel/js/core/wire-codec.js';
import { SenderKeysManager } from '../../Extension/sidepanel/js/core/sender-keys.js';
import { TrustEngine, TRUST_TIERS } from '../../Extension/sidepanel/js/core/trust-engine.js';
import { EquivocationEngine } from '../../Extension/sidepanel/js/core/equivocation-engine.js';
import { CryptoVault } from '../../Extension/sidepanel/js/core/crypto-vault.js';

const SAMPLE_CODE = 'ALPHA-BRAVO-CHARLIE-DELTA-ECHO-FOXTROT-1234';

describe('🏛️ Gouvernance, DID & Spécification Protocole (Groupe 8 - Pass 2)', () => {
  before(() => {
    CryptoVault.PBKDF2_ITERATIONS = 1000;
  });
  describe('1. Multibase & Multicodec (W3C DID Core 1.0)', () => {
    test('Multibase encode et décode Base58-BTC avec préfixe "z"', () => {
      const data = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x42]);
      const encoded = Multibase.encodeBase58Btc(data);
      assert.ok(encoded.startsWith('z'), 'Doit avoir le préfixe z');

      const decoded = Multibase.decodeBase58Btc(encoded);
      assert.deepStrictEqual(decoded, data, 'Décodage exact');
    });

    test('Multicodec compresse une clé NIST P-256 de 65 à 33 octets', () => {
      const uncompressed = new Uint8Array(65);
      uncompressed[0] = 0x04;
      uncompressed.fill(0xaa, 1, 33); // X
      uncompressed.fill(0xbb, 33, 64);
      uncompressed[64] = 0x02; // Y pair

      const compressed = Multicodec.compressP256(uncompressed);
      assert.strictEqual(compressed.length, 33);
      assert.strictEqual(compressed[0], 0x02);
    });
  });

  describe('2. DID Document Resolver (did:key & did:peer:2)', () => {
    test('Résout did:key en Document DID W3C conforme localement sans réseau', () => {
      const rawKey = new Uint8Array(33);
      rawKey[0] = 0x02;
      rawKey.fill(0x11, 1);
      const prefixed = Multicodec.addPrefix(Multicodec.P256_PUB, rawKey);
      const mb = Multibase.encodeBase58Btc(prefixed);
      const did = `did:key:${mb}`;

      const { didDocument } = DIDDocumentResolver.resolve(did);
      assert.strictEqual(didDocument.id, did);
      assert.ok(Array.isArray(didDocument.verificationMethod));
      assert.strictEqual(didDocument.verificationMethod[0].publicKeyMultibase, mb);
      assert.ok(didDocument.authentication.includes(didDocument.verificationMethod[0].id));
    });

    test('Crée et résout un did:peer:2 avec service endpoint de signalement', () => {
      const didPeer = DIDDocumentResolver.createDidPeer2({
        signingMultibase: 'zDnaerDaTF5BXEavCrfRZEPrimitive',
        signalingEndpoint: 'pmesh://topic/abc123'
      });
      assert.ok(didPeer.startsWith('did:peer:2.VzDnaerDa'));

      const { didDocument } = DIDDocumentResolver.resolve(didPeer);
      assert.strictEqual(didDocument.id, didPeer);
      assert.ok(didDocument.service.length >= 1);
      assert.strictEqual(didDocument.service[0].serviceEndpoint, 'pmesh://topic/abc123');
    });
  });

  describe('3. Codec Wire Frame Binaire RFC-PMESH-001 (16B Header)', () => {
    test('encodeFrame et decodeFrame préservent les métadonnées et le payload', () => {
      const payload = new TextEncoder().encode('Hello P2P Mesh Protocol 2026!');
      const frameBuffer = WireFrameCodec.encodeFrame({
        opcode: WIRE_CONSTANTS.OPCODES.CHAT_MSG,
        flags: WIRE_CONSTANTS.FLAGS.ENCRYPTED,
        seqNum: 42,
        lamport: 1337,
        payloadBytes: payload
      });

      assert.strictEqual(frameBuffer.byteLength, 16 + payload.length);

      const decoded = WireFrameCodec.decodeFrame(frameBuffer);
      assert.strictEqual(decoded.opcode, WIRE_CONSTANTS.OPCODES.CHAT_MSG);
      assert.strictEqual(decoded.flags, WIRE_CONSTANTS.FLAGS.ENCRYPTED);
      assert.strictEqual(decoded.seqNum, 42);
      assert.strictEqual(decoded.lamport, 1337);
      assert.strictEqual(decoded.payloadLength, payload.length);
      assert.strictEqual(new TextDecoder().decode(decoded.payloadBytes), 'Hello P2P Mesh Protocol 2026!');
    });

    test('SemVerNegotiator valide la compatibilité des versions de protocole', () => {
      assert.strictEqual(SemVerNegotiator.isCompatible('1.3.0', '1.0.0'), true);
      assert.strictEqual(SemVerNegotiator.isCompatible('2.0.0', '1.3.0'), false);
    });
  });

  describe('4. Chiffrement de Groupe Signal Sender Keys O(1)', () => {
    let vaultAlice, vaultBob;

    before(async () => {
      vaultAlice = new CryptoVault();
      await vaultAlice.initializeFromPaperCode(SAMPLE_CODE, 'Alice');
      vaultBob = new CryptoVault();
      await vaultBob.initializeFromPaperCode(SAMPLE_CODE, 'Bob');

      // Échange de clés de diffusion initial
      const skdmAlice = await vaultAlice.senderKeys.getLocalDistributionMessage();
      await vaultBob.senderKeys.handleInboundSenderKey(skdmAlice);
    });

    test('Alice chiffre en O(1) et Bob déchiffre avec succès', async () => {
      const originalMsg = { text: 'Bonjour le maillage sécurisé', count: 123 };
      const envelope = await vaultAlice.senderKeys.encryptGroupMessage('general', originalMsg);

      assert.strictEqual(envelope.senderId, vaultAlice.peerId);
      assert.strictEqual(envelope.channelId, 'general');
      assert.ok(envelope.ciphertext);
      assert.ok(envelope.signature);

      const decrypted = await vaultBob.senderKeys.decryptGroupMessage(envelope);
      assert.deepStrictEqual(decrypted, originalMsg);
    });

    test('Déchiffrement hors-ordre via Skipped Keys Store', async () => {
      // Alice produit msg 1, 2, 3
      const env1 = await vaultAlice.senderKeys.encryptGroupMessage('general', { seq: 1 });
      const env2 = await vaultAlice.senderKeys.encryptGroupMessage('general', { seq: 2 });
      const env3 = await vaultAlice.senderKeys.encryptGroupMessage('general', { seq: 3 });

      // Bob reçoit d'abord msg 3 (sautant msg 1 et 2)
      const dec3 = await vaultBob.senderKeys.decryptGroupMessage(env3);
      assert.deepStrictEqual(dec3, { seq: 3 });

      // Bob reçoit ensuite msg 1 en retard (qui doit être déchiffré via le store de clés sautées)
      const dec1 = await vaultBob.senderKeys.decryptGroupMessage(env1);
      assert.deepStrictEqual(dec1, { seq: 1 });

      // Bob reçoit ensuite msg 2
      const dec2 = await vaultBob.senderKeys.decryptGroupMessage(env2);
      assert.deepStrictEqual(dec2, { seq: 2 });
    });
  });

  describe('5. Réputation Souveraine & Personalized EigenTrust', () => {
    test('Personalized EigenTrust converge et accorde les tiers de confiance', async () => {
      const vault = new CryptoVault();
      await vault.initializeFromPaperCode(SAMPLE_CODE, 'Alice');

      const trustEngine = new TrustEngine(vault);
      const peerA = '04' + 'a'.repeat(64);
      const peerB = '04' + 'b'.repeat(64);

      // Alice valide peerA en SAS direct
      trustEngine.directSeeds.add(peerA);

      // peerA émet une attestation pour peerB
      trustEngine._addAttestationMemory({
        issuerPubkey: peerA,
        subjectPubkey: peerB,
        trustScore: 0.9,
        expiresAt: Date.now() + 100000
      });

      trustEngine.computeEigenTrust();

      assert.strictEqual(trustEngine.getTrustTier(peerA), TRUST_TIERS.SAS_DIRECT);
      assert.strictEqual(trustEngine.getTrustTier(peerB), TRUST_TIERS.WOT_TRUSTED);
      assert.strictEqual(trustEngine.getTrustTier('04' + 'c'.repeat(64)), TRUST_TIERS.UNKNOWN);
    });
  });

  describe('6. Anti-Équivocation Byzantine & Preuve Objective (PoEq)', () => {
    test('Détecte une double signature contradictoire et génère une PoEq', async () => {
      const vault = new CryptoVault();
      await vault.initializeFromPaperCode(SAMPLE_CODE, 'MaliciousPeer');

      const mockMesh = {
        broadcast: async () => {},
        peers: new Map()
      };

      const equivEngine = new EquivocationEngine(mockMesh);

      const commitA = {
        fileId: 'file_1',
        versionNumber: 1,
        contentHash: 'hash_A',
        authorPubkey: vault.publicKeyHex
      };
      commitA.signature = await vault.sign(commitA);

      // Premier commit légitime
      const rejected1 = await equivEngine.inspectCommit(commitA);
      assert.strictEqual(rejected1, false, 'Le premier commit doit être accepté');

      // Deuxième commit contradictoire pour le même contextKey (file_1:v1)
      const commitB = {
        fileId: 'file_1',
        versionNumber: 1,
        contentHash: 'hash_B_EQUIVOCATED',
        authorPubkey: vault.publicKeyHex
      };
      commitB.signature = await vault.sign(commitB);

      const rejected2 = await equivEngine.inspectCommit(commitB);
      assert.strictEqual(rejected2, true, 'L\'équivocation doit être interceptée et rejetée');
      assert.strictEqual(equivEngine.isPeerBanned(vault.publicKeyHex), true, 'L\'auteur doit être banni');
    });
  });
});
