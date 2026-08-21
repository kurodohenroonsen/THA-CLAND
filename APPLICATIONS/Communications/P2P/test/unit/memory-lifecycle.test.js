/**
 * test/unit/memory-lifecycle.test.js
 * Tests du Cycle de Vie Mémoire, Détection de Fuites & Pools Zero-Allocation (Pass 4)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLeakDetector, AutoCleanupTracker } from '../../Extension/sidepanel/js/core/memory-leak-detector.js';
import { BinaryBufferPool, SWAR, FastHex } from '../../Extension/sidepanel/js/core/binary-buffer-pool.js';
import { SIMDVectorAccelerator } from '../../Extension/sidepanel/js/core/simd-vector-accelerator.js';

describe('🧠 Groupe 7 - Cycle de Vie Mémoire & Zero-Allocation Pools', () => {

  it('AutoCleanupTracker : Annule les timers, écouteurs et libère les ressources sur dispose()', () => {
    const tracker = new AutoCleanupTracker();
    let intervalRan = 0;
    let timeoutRan = 0;
    let listenerRan = 0;
    let disposableRan = 0;

    const intervalId = tracker.setInterval(() => intervalRan++, 10);
    const timeoutId = tracker.setTimeout(() => timeoutRan++, 50);

    const target = new EventTarget();
    tracker.addEventListener(target, 'test-event', () => listenerRan++);

    tracker.addDisposable(() => disposableRan++);

    target.dispatchEvent(new Event('test-event'));
    assert.strictEqual(listenerRan, 1);

    tracker.destroy();

    target.dispatchEvent(new Event('test-event'));
    assert.strictEqual(listenerRan, 1, 'L\'écouteur ne doit plus se déclencher après destroy()');
    assert.strictEqual(disposableRan, 1, 'Le disposable doit avoir été exécuté');
  });

  it('BinaryBufferPool : Alloue, réutilise et sature sans fuite de backing store', () => {
    const pool = new BinaryBufferPool({ maxPerBucket: 4 });

    const p1 = pool.acquire(16 * 1024);
    assert.strictEqual(p1.bucketSize, 16 * 1024);
    assert.strictEqual(p1.isAcquired, true);
    assert.strictEqual(pool.metrics.activeInUse, 1);

    pool.release(p1);
    assert.strictEqual(p1.isAcquired, false);
    assert.strictEqual(pool.metrics.activeInUse, 0);
    assert.strictEqual(pool.metrics.totalReleased, 1);

    const p2 = pool.acquire(16 * 1024);
    assert.strictEqual(p2.buffer, p1.buffer, 'Le buffer libéré doit être réutilisé (Pool Hit)');
    assert.strictEqual(pool.metrics.poolHits, 1);
    pool.release(p2);
  });

  it('SWAR : Popcount 32-bit vectorisé calcule correctement la cardinalité du Bitfield', () => {
    const bytes = new Uint8Array([0xFF, 0x0F, 0x00, 0x55]); // 8 + 4 + 0 + 4 = 16 bits
    const count = SWAR.fastBitfieldCardinality(bytes, 32);
    assert.strictEqual(count, 16);
  });

  it('FastHex : Encode et décode sans allocation de chaînes intermédiaires', () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67]);
    const hex = FastHex.encode(original);
    assert.strictEqual(hex, 'deadbeef01234567');

    const decoded = new Uint8Array(8);
    FastHex.decodeToBuffer(hex, decoded);
    assert.deepStrictEqual(decoded, original);
  });

  it('SIMDVectorAccelerator : Détecte le support Wasm SIMD et exécute les opérations vectorisées', () => {
    const support = SIMDVectorAccelerator.detectSupport();
    assert.strictEqual(typeof support, 'boolean');

    const audioBuf = new Float32Array([0.5, -0.5, 0.25, -0.25, 0.1, -0.1, 0.05, -0.05]);
    const rms = SIMDVectorAccelerator.computeRmsF32(audioBuf);
    assert.ok(rms > 0, 'Le RMS calculé doit être positif');

    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const c = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9]);
    assert.strictEqual(SIMDVectorAccelerator.constantTimeEqual(a, b), true);
    assert.strictEqual(SIMDVectorAccelerator.constantTimeEqual(a, c), false);
  });
});
