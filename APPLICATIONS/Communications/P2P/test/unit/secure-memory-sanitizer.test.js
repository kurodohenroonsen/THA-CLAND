/**
 * test/unit/secure-memory-sanitizer.test.js
 * Tests Unitaires & Profilage d'Hygiène Mémoire (Pass 4 - 2026)
 * Runner : Node.js Native Test Runner (node:test & node:assert/strict)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecureMemorySanitizer, SecureScope, RevocableCryptoKey } from '../../Extension/sidepanel/js/core/secure-memory-sanitizer.js';

describe('🧼 SecureMemorySanitizer - Tests d\'Hygiène Mémoire & Anti-DCE', () => {

  it('1. wipe() écrase intégralement les octets avec des zéros', () => {
    const secret = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
    assert.strictEqual(secret.some(b => b !== 0), true);

    const success = SecureMemorySanitizer.wipe(secret);
    assert.strictEqual(success, true);
    assert.strictEqual(secret.every(b => b === 0), true, 'Tous les octets doivent être à 0x00');
  });

  it('2. wipe() respecte scrupuleusement les sous-vues et offsets (byteOffset & byteLength)', () => {
    const parentBuffer = new ArrayBuffer(64);
    const parentView = new Uint8Array(parentBuffer);
    parentView.fill(0xff);

    // Vue découpée de l'offset 16 à 48 (longueur 32)
    const subView = new Uint8Array(parentBuffer, 16, 32);
    assert.strictEqual(subView.every(b => b === 0xff), true);

    SecureMemorySanitizer.wipe(subView);

    // Vérification de la zone ciblée
    assert.strictEqual(subView.every(b => b === 0x00), true, 'La sous-vue doit être à 0x00');

    // Vérification des zones adjacentes (ne doivent pas avoir été écrasées par erreur)
    const prefixView = new Uint8Array(parentBuffer, 0, 16);
    const suffixView = new Uint8Array(parentBuffer, 48, 16);
    assert.strictEqual(prefixView.every(b => b === 0xff), true, 'Le préfixe doit rester intact');
    assert.strictEqual(suffixView.every(b => b === 0xff), true, 'Le suffixe doit rester intact');
  });

  it('3. wipeAll() assainit une collection variadique de tampons', () => {
    const b1 = new Uint8Array([1, 2, 3]);
    const b2 = new Uint32Array([0x12345678, 0x9abcdef0]);
    const ab = new ArrayBuffer(8);
    new Uint8Array(ab).fill(0xaa);

    SecureMemorySanitizer.wipeAll(b1, b2, ab, null, undefined);

    assert.strictEqual(b1.every(b => b === 0), true);
    assert.strictEqual(new Uint8Array(b2.buffer).every(b => b === 0), true);
    assert.strictEqual(new Uint8Array(ab).every(b => b === 0), true);
  });

  it('4. withSecureBuffer() exécute le traitement et détruit le buffer inconditionnellement', async () => {
    let capturedBuffer = null;

    const result = await SecureMemorySanitizer.withSecureBuffer(32, (buf) => {
      capturedBuffer = buf;
      buf.fill(0x42);
      return 'CALCULATION_DONE';
    });

    assert.strictEqual(result, 'CALCULATION_DONE');
    assert.ok(capturedBuffer !== null);
    assert.strictEqual(capturedBuffer.every(b => b === 0), true, 'Le buffer doit être à zéro après sortie');
  });

  it('5. withSecureBuffer() garantit la destruction même en cas d\'exception levée', async () => {
    let capturedBuffer = null;

    await assert.rejects(async () => {
      await SecureMemorySanitizer.withSecureBuffer(16, (buf) => {
        capturedBuffer = buf;
        buf.fill(0x99);
        throw new Error('CRASH_SIMULATED');
      });
    }, /CRASH_SIMULATED/);

    assert.ok(capturedBuffer !== null);
    assert.strictEqual(capturedBuffer.every(b => b === 0), true, 'Le buffer doit être à zéro malgré l\'erreur');
  });

  it('6. SecureScope détruit tous les tampons alloués et trackés à la fermeture', async () => {
    let b1, b2;

    await SecureMemorySanitizer.withSecureScope((scope) => {
      b1 = scope.alloc(16);
      b1.fill(0x11);
      
      b2 = new Uint8Array(8);
      b2.fill(0x22);
      scope.track(b2);

      assert.strictEqual(b1[0], 0x11);
      assert.strictEqual(b2[0], 0x22);
    });

    assert.strictEqual(b1.every(b => b === 0), true, 'b1 doit être détruit');
    assert.strictEqual(b2.every(b => b === 0), true, 'b2 doit être détruit');
  });

  it('7. RevocableCryptoKey interdit l\'accès après révocation', async () => {
    const rawKey = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' },
      true,
      ['sign']
    );

    const revocable = new RevocableCryptoKey(rawKey, 'session-hmac');
    assert.strictEqual(revocable.isRevoked, false);
    assert.strictEqual(revocable.key, rawKey);

    revocable.revoke();
    assert.strictEqual(revocable.isRevoked, true);
    assert.throws(() => revocable.key, /révoquée/);
  });
});
