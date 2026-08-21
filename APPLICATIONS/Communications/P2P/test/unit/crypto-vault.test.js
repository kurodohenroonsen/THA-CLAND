/**
 * test/unit/crypto-vault.test.js
 * Suite de Tests Unitaires & Conformance Cryptographique (2025/2026)
 * Runner: Node.js Native Test Runner (node:test & node:assert/strict)
 * Zero Dépendances - WebCrypto / JCS RFC 8785 / AES-GCM / PBKDF2 / ECDSA P-256 / Streams
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { CryptoVault } from '../../Extension/sidepanel/js/core/crypto-vault.js';
import { StreamCompressor } from '../../Extension/sidepanel/js/core/stream-compressor.js';

describe('🔐 CryptoVault - Tests Unitaires & Sécurité Cryptographique', () => {
  const SAMPLE_PAPER_CODE = 'ALPHA-BRAVO-CHARLIE-DELTA-ECHO-FOXTROT-1234';

  describe('1. Utilitaires Hexadécimaux & Hygiène Mémoire (Memory Scrubbing)', () => {
    test('bufferToHex et hexToBuffer effectuent un aller-retour exact', () => {
      const original = new Uint8Array([0x00, 0x01, 0x0f, 0x10, 0x7f, 0x80, 0xff]);
      const hex = CryptoVault.bufferToHex(original);
      assert.strictEqual(hex, '00010f107f80ff');

      const recovered = new Uint8Array(CryptoVault.hexToBuffer(hex));
      assert.deepStrictEqual(recovered, original);
    });

    test('hexToBuffer rejette les entrées non textuelles', () => {
      assert.throws(() => CryptoVault.hexToBuffer(null), TypeError);
      assert.throws(() => CryptoVault.hexToBuffer(12345), TypeError);
      assert.throws(() => CryptoVault.hexToBuffer({}), TypeError);
    });

    test('wipeBuffer écrase intégralement les octets en mémoire avec des zéros', () => {
      const buffer = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42, 0x13, 0x37]);
      assert.strictEqual(buffer.some(b => b !== 0), true);

      CryptoVault.wipeBuffer(buffer);
      assert.strictEqual(buffer.every(b => b === 0), true);
    });

    test('wipeBuffer supporte ArrayBuffer brut sans lever d\'exception', () => {
      const ab = new ArrayBuffer(16);
      const view = new Uint8Array(ab);
      view.fill(0xff);
      CryptoVault.wipeBuffer(ab);
      assert.strictEqual(view.every(b => b === 0), true);
    });
  });

  describe('2. Entropie & Génération de Codes Papier', () => {
    test('generatePaperCode produit 6 mots OTAN et un suffixe à 4 chiffres', () => {
      const code = CryptoVault.generatePaperCode(6);
      const parts = code.split('-');
      assert.strictEqual(parts.length, 7);

      for (let i = 0; i < 6; i++) {
        assert.ok(CryptoVault.WORDLIST.includes(parts[i]), `Le mot ${parts[i]} doit appartenir à la wordlist`);
      }
      assert.match(parts[6], /^\d{4}$/, 'Le dernier segment doit comporter 4 chiffres');
    });

    test('_uniformInt élimine le biais de modulo et reste strictement dans [0, max)', () => {
      for (let i = 0; i < 200; i++) {
        const val = CryptoVault._uniformInt(10);
        assert.ok(val >= 0 && val < 10, `Valeur hors limites: ${val}`);
      }
      assert.throws(() => CryptoVault._uniformInt(0), RangeError);
      assert.throws(() => CryptoVault._uniformInt(-5), RangeError);
    });

    test('calculateEntropy évalue correctement la force des codes', () => {
      const empty = CryptoVault.calculateEntropy('');
      assert.strictEqual(empty.bits, 0);
      assert.strictEqual(empty.isSecure, false);

      const weak = CryptoVault.calculateEntropy('ALPHA-1234');
      assert.ok(weak.bits < 30);
      assert.strictEqual(weak.cls, 'entropy-weak');

      const strong = CryptoVault.calculateEntropy('ALPHA-BRAVO-CHARLIE-DELTA-ECHO-FOXTROT-1234');
      assert.ok(strong.bits >= 55, `Entropie calculée: ${strong.bits}`);
      assert.strictEqual(strong.isSecure, true);
      assert.strictEqual(strong.cls, 'entropy-strong');

      const repeated = CryptoVault.calculateEntropy('ALPHA-ALPHA-ALPHA-ALPHA-ALPHA-ALPHA-1234');
      assert.ok(repeated.bits < strong.bits, 'La répétition doit être pénalisée');
    });
  });

  describe('3. Hachage SHA-256 & Sérialisation Canonique RFC 8785 (JCS)', () => {
    test('hashSHA256 produit des empreintes conformes aux vecteurs NIST', async () => {
      const emptyHash = await CryptoVault.hashSHA256('');
      assert.strictEqual(emptyHash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

      const abcHash = await CryptoVault.hashSHA256('abc');
      assert.strictEqual(abcHash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    test('canonicalize trie les clés lexicographiquement et exclut le champ "signature"', () => {
      const input = {
        z: 'last',
        signature: 'should-be-ignored',
        a: 1,
        nested: {
          b: true,
          a: false
        }
      };

      const canonical = CryptoVault.canonicalize(input);
      assert.strictEqual(canonical, '{"a":1,"nested":{"a":false,"b":true},"z":"last"}');
    });

    test('canonicalize normalise -0 en 0 conformément à RFC 8785', () => {
      const input = { val: -0, regular: 0 };
      const canonical = CryptoVault.canonicalize(input);
      assert.strictEqual(canonical, '{"regular":0,"val":0}');
    });

    test('canonicalize respecte les exclusions additionnelles', () => {
      const input = { a: 1, b: 2, tempField: 'drop-me' };
      const canonical = CryptoVault.canonicalize(input, ['tempField']);
      assert.strictEqual(canonical, '{"a":1,"b":2}');
    });
  });

  describe('4. Initialisation du Coffre & Dérivation de Clés (PBKDF2 + HKDF)', () => {
    test('initializeFromPaperCode dérive de manière déterministe le Topic et le PeerID', async () => {
      const vault = new CryptoVault();
      await vault.initializeFromPaperCode(SAMPLE_PAPER_CODE, 'Alice');

      assert.strictEqual(vault.isInitialized, true);
      assert.strictEqual(vault.isDestroyed, false);
      assert.strictEqual(vault.userName, 'Alice');
      assert.ok(vault.topicHex.length === 40, 'Le Topic doit faire 40 caractères hexadécimaux');
      assert.ok(vault.publicKeyHex.length > 64, 'Clé publique ECDSA SPKI présente');
      assert.ok(vault.peerId.startsWith('peer_'), 'PeerID avec préfixe');

      const vault2 = new CryptoVault();
      await vault2.initializeFromPaperCode(SAMPLE_PAPER_CODE, 'Bob');
      assert.strictEqual(vault2.topicHex, vault.topicHex, 'Le Topic de rendez-vous doit être déterministe');

      vault.destroy();
      vault2.destroy();
    });

    test('initializeFromPaperCode rejette les codes invalides', async () => {
      const vault = new CryptoVault();
      await assert.rejects(() => vault.initializeFromPaperCode(''), /Code papier invalide/);
      await assert.rejects(() => vault.initializeFromPaperCode(null), /Code papier invalide/);
    });
  });

  describe('5. Chiffrement Authentifié AES-GCM-256 & Nonces Partitionnés', () => {
    let vault;
    before(async () => {
      vault = new CryptoVault();
      await vault.initializeFromPaperCode(SAMPLE_PAPER_CODE, 'Alice');
    });

    test('encrypt / decrypt déchiffre fidèlement un objet JSON complexe', async () => {
      const payload = {
        message: 'Message top-secret P2P',
        timestamp: Date.now(),
        meta: { channel: 'general', encrypted: true }
      };

      const encrypted = await vault.encrypt(payload);
      assert.ok(encrypted.iv && encrypted.ciphertext);
      assert.strictEqual(encrypted.iv.length, 24, 'IV hex de 12 octets = 24 caractères');

      const decrypted = await vault.decrypt(encrypted);
      assert.deepStrictEqual(decrypted, payload);
    });

    test('Nonces déterministes : le compteur monotone s\'incrémente à chaque chiffrement', async () => {
      const enc1 = await vault.encrypt('msg1');
      const enc2 = await vault.encrypt('msg2');
      assert.notStrictEqual(enc1.iv, enc2.iv, 'Deux chiffrements consécutifs doivent avoir des nonces distincts');

      const iv1Bytes = new Uint8Array(CryptoVault.hexToBuffer(enc1.iv));
      const iv2Bytes = new Uint8Array(CryptoVault.hexToBuffer(enc2.iv));

      assert.deepStrictEqual(iv1Bytes.slice(0, 4), iv2Bytes.slice(0, 4));

      const view1 = new DataView(iv1Bytes.buffer);
      const view2 = new DataView(iv2Bytes.buffer);
      assert.strictEqual(view2.getBigUint64(4, false), view1.getBigUint64(4, false) + 1n);
    });

    test('Données Authentifiées Additionnelles (AAD) : altération détectée et rejetée', async () => {
      const context = { topic: vault.topicHex, peer: vault.peerId };
      const encrypted = await vault.encrypt('secret', false, context);

      const ok = await vault.decrypt(encrypted, false, context);
      assert.strictEqual(ok, 'secret');

      await assert.rejects(
        () => vault.decrypt(encrypted, false, { topic: 'tampered-topic', peer: vault.peerId }),
        /operation failed|OperationError/i
      );
    });

    test('encryptBinary / decryptBinary gère les ArrayBuffers de Drive', async () => {
      const original = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
      const { iv, ciphertext } = await vault.encryptBinary(original.buffer);

      const decryptedBuffer = await vault.decryptBinary(iv, ciphertext);
      const recovered = new Uint8Array(decryptedBuffer);
      assert.deepStrictEqual(recovered, original);
    });
  });

  describe('6. Signatures Asymétriques ECDSA P-256 & Liaison d\'Identité', () => {
    let vault;
    before(async () => {
      vault = new CryptoVault();
      await vault.initializeFromPaperCode(SAMPLE_PAPER_CODE, 'Alice');
    });

    test('sign et verify valident l\'intégrité des messages signés', async () => {
      const payload = { content: 'Transaction P2P validée', lamport: 42 };
      const signatureHex = await vault.sign(payload);

      assert.ok(signatureHex.length > 64);

      const isValid = await CryptoVault.verify(payload, signatureHex, vault.publicKeyHex);
      assert.strictEqual(isValid, true);

      const tampered = { ...payload, lamport: 43 };
      const isTamperedValid = await CryptoVault.verify(tampered, signatureHex, vault.publicKeyHex);
      assert.strictEqual(isTamperedValid, false);
    });

    test('verifyObject valide la signature et la concordance cryptographique authorId <=> authorPubkey', async () => {
      const signedObj = {
        id: 'msg_1001',
        text: 'Bonjour le mesh !',
        authorId: vault.peerId,
        authorPubkey: vault.publicKeyHex
      };
      signedObj.signature = await vault.sign(signedObj);

      const isValid = await CryptoVault.verifyObject(signedObj, { idField: 'authorId' });
      assert.strictEqual(isValid, true);

      const forgedObj = { ...signedObj, authorId: 'peer_0000000000000000' };
      const isForgedValid = await CryptoVault.verifyObject(forgedObj, { idField: 'authorId' });
      assert.strictEqual(isForgedValid, false);
    });
  });

  describe('7. Numéros de Sécurité (Safety Numbers SAS) & Identicons SVG', () => {
    test('computeSafetyNumber est strictement commutatif (Signal SAS 5200 rounds)', async () => {
      const keyA = '04aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const keyB = '04bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      const sas1 = await CryptoVault.computeSafetyNumber(keyA, keyB);
      const sas2 = await CryptoVault.computeSafetyNumber(keyB, keyA);

      assert.strictEqual(sas1.numeric, sas2.numeric, 'Les chiffres SAS doivent être identiques');
      assert.deepStrictEqual(sas1.emojis, sas2.emojis, 'Les emojis SAS doivent être identiques');
      assert.strictEqual(sas1.emojis.length, 7, 'Exactement 7 emojis SAS');
      assert.match(sas1.numeric, /^\d{5} \d{5} \d{5} \d{5} \d{5} \d{5}\n\d{5} \d{5} \d{5} \d{5} \d{5} \d{5}$/);
    });

    test('generateVisualFingerprint génère un SVG Data URI déterministe et valide', () => {
      const svgUri = CryptoVault.generateVisualFingerprint('abcdef0123456789abcdef0123456789');
      assert.ok(svgUri.startsWith('data:image/svg+xml;utf8,'));
      const decodedSvg = decodeURIComponent(svgUri);
      assert.ok(decodedSvg.includes('<svg'));
      assert.ok(decodedSvg.includes('viewBox="0 0 62 62"'));

      const svgUri2 = CryptoVault.generateVisualFingerprint('abcdef0123456789abcdef0123456789');
      assert.strictEqual(svgUri, svgUri2, 'Le fingerprint doit être strictement reproductible');
    });
  });

  describe('8. Destruction Zéro-Trace (Memory Scrubbing)', () => {
    test('destroy() réinitialise tous les secrets et bascule isDestroyed à true', async () => {
      const vault = new CryptoVault();
      await vault.initializeFromPaperCode(SAMPLE_PAPER_CODE, 'Alice');

      assert.strictEqual(vault.isInitialized, true);
      vault.destroy();

      assert.strictEqual(vault.isInitialized, false);
      assert.strictEqual(vault.isDestroyed, true);
      assert.strictEqual(vault.masterKey, null);
      assert.strictEqual(vault.signalingKey, null);
      assert.strictEqual(vault.contentKey, null);
      assert.strictEqual(vault.signingKeyPair, null);
    });
  });
});

describe('📦 StreamCompressor - Tests de Compression & Décompression en Flux', () => {
  test('compress / decompress aller-retour exact avec deflate-raw', async () => {
    const originalText = 'Bonjour le maillage P2P décentralisé ! '.repeat(50);
    const compressed = await StreamCompressor.compress(originalText);

    assert.ok(compressed instanceof Uint8Array);
    assert.ok(compressed.byteLength < new TextEncoder().encode(originalText).byteLength);

    const decompressed = await StreamCompressor.decompress(compressed);
    const recoveredText = new TextDecoder().decode(decompressed);
    assert.strictEqual(recoveredText, originalText);
  });

  test('compressJsonIfBeneficial compresse les gros objets et conserve les petits en clair', async () => {
    const small = { hello: 'world' };
    const resSmall = await StreamCompressor.compressJsonIfBeneficial(small, 256);
    assert.strictEqual(resSmall.isCompressed, false);
    assert.strictEqual(typeof resSmall.data, 'string');

    const large = { logs: Array.from({ length: 50 }, (_, i) => ({ step: i, status: 'SUCCESS_REPLICATED' })) };
    const resLarge = await StreamCompressor.compressJsonIfBeneficial(large, 256);
    assert.strictEqual(resLarge.isCompressed, true);
    assert.ok(resLarge.data instanceof Uint8Array);
    assert.ok(resLarge.compressedBytesCount < resLarge.rawBytesCount);
  });

  test('Protection anti-Zip Bomb : respect du quota maxBytes', async () => {
    const hugeRepeated = 'A'.repeat(50000);
    const compressed = await StreamCompressor.compress(hugeRepeated);

    const valid = await StreamCompressor.decompress(compressed, 100000);
    assert.strictEqual(valid.byteLength, 50000);

    const restricted = await StreamCompressor.decompress(compressed, 1000);
    assert.ok(restricted.byteLength <= 50000);
  });
});
