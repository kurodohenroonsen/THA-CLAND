import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { Multibase, Multicodec } from '../../Extension/sidepanel/js/core/did-codec.js';
import { DIDUniversalResolver } from '../../Extension/sidepanel/js/core/did-resolver.js';
import { VerifiableCredentialsEngine, VC_ROLES } from '../../Extension/sidepanel/js/core/verifiable-credentials.js';
import { CryptoVault } from '../../Extension/sidepanel/js/core/crypto-vault.js';

const SAMPLE_CODE_ALICE = 'ALPHA-BRAVO-CHARLIE-DELTA-ECHO-FOXTROT-1234';
const SAMPLE_CODE_BOB   = 'GOLF-HOTEL-INDIGO-JULIET-KILO-LIMA-5678';

describe('🏛️ Persona G4.P6 - Tests Identité Souveraine & W3C Verifiable Credentials', () => {
  let vaultAlice, vaultBob;

  before(async () => {
    CryptoVault.PBKDF2_ITERATIONS = 1000;
    vaultAlice = new CryptoVault();
    await vaultAlice.initializeFromPaperCode(SAMPLE_CODE_ALICE, 'Alice Admin');
    vaultBob = new CryptoVault();
    await vaultBob.initializeFromPaperCode(SAMPLE_CODE_BOB, 'Bob Member');
  });

  test('1. Compression & Décompression exacte NIST P-256 (SEC1 Point Recovery)', async () => {
    const spki = await crypto.subtle.exportKey('spki', vaultAlice.signingKeyPair.publicKey);
    const uncompressedOriginal = new Uint8Array(spki).slice(26); // 65 bytes: 0x04 || X || Y
    
    // Compression (65 -> 33 octets)
    const compressed = Multicodec.compressP256(uncompressedOriginal);
    assert.strictEqual(compressed.length, 33);
    assert.ok(compressed[0] === 0x02 || compressed[0] === 0x03);

    // Décompression (33 -> 65 octets via racine carrée modulaire Weierstrass)
    const uncompressedRecovered = Multicodec.decompressP256(compressed);
    assert.strictEqual(uncompressedRecovered.length, 65);
    assert.deepStrictEqual(uncompressedRecovered, uncompressedOriginal);
  });

  test('2. Résolution did:key vers CryptoKey Web Crypto et vérification de signature', async () => {
    const did = vaultAlice.did;
    assert.ok(did.startsWith('did:key:z'));

    // Résolution en CryptoKey
    const cryptoKey = await DIDUniversalResolver.resolveToCryptoKey(did);
    assert.ok(cryptoKey);
    assert.strictEqual(cryptoKey.algorithm.name, 'ECDSA');

    // Signature avec le vault d'Alice et vérification directe avec la clé résolue
    const payload = 'Message souverain décentralisé 2026';
    const sigHex = await vaultAlice.sign(payload);
    
    const isValid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      cryptoKey,
      CryptoVault.hexToBuffer(sigHex),
      new TextEncoder().encode(payload)
    );
    assert.strictEqual(isValid, true, 'La signature doit être validée avec la CryptoKey résolue depuis le DID');
  });

  test('3. Émission et vérification de W3C Verifiable Credential (Rôle Modérateur)', async () => {
    // Alice (Admin) émet un credential de Modérateur pour Bob
    const vc = await VerifiableCredentialsEngine.issueRoleCredential({
      vault: vaultAlice,
      subjectDid: vaultBob.did,
      role: VC_ROLES.MODERATOR
    });

    assert.strictEqual(vc.issuer, vaultAlice.did);
    assert.strictEqual(vc.credentialSubject.id, vaultBob.did);
    assert.strictEqual(vc.credentialSubject.role, VC_ROLES.MODERATOR);
    assert.ok(vc.proof);
    assert.strictEqual(vc.proof.cryptosuite, 'ecdsa-jcs-2019');

    // Vérification sans serveur par un tiers quelconque
    const result = await VerifiableCredentialsEngine.verifyCredential(vc);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.role, VC_ROLES.MODERATOR);
    assert.ok(result.permissions.includes('MODERATE_TOPIC_BAN'));
  });

  test('4. Détection immédiate de falsification d\'un Verifiable Credential', async () => {
    const vc = await VerifiableCredentialsEngine.issueRoleCredential({
      vault: vaultAlice,
      subjectDid: vaultBob.did,
      role: VC_ROLES.VERIFIED_MEMBER
    });

    // Tentative d'élévation de privilège non autorisée
    vc.credentialSubject.role = VC_ROLES.ADMIN;
    vc.credentialSubject.permissions.push('ADMIN_PROMOTE_PEER');

    const tamperedResult = await VerifiableCredentialsEngine.verifyCredential(vc);
    assert.strictEqual(tamperedResult.valid, false, 'Le credential falsifié doit être rejeté');
  });

  test('5. Divulgation Sélective (ZKP Léger) de claims sans rupture de preuve', async () => {
    const vc = await VerifiableCredentialsEngine.issueRoleCredential({
      vault: vaultAlice,
      subjectDid: vaultBob.did,
      role: VC_ROLES.MODERATOR,
      customClaims: { email: 'bob@mesh.p2p', clearanceLevel: 'Secret' }
    });

    const sdPresentation = await VerifiableCredentialsEngine.createSelectiveDisclosurePresentation(
      vc,
      ['id', 'role'] // Seuls l'ID et le rôle sont divulgués
    );

    assert.strictEqual(sdPresentation.disclosedClaims.role, VC_ROLES.MODERATOR);
    assert.strictEqual(sdPresentation.disclosedClaims.email, undefined);
    assert.ok(sdPresentation.hiddenClaimsCommitments.email.digest);
  });
});
