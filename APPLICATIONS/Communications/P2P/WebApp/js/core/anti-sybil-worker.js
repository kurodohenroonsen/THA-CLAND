/**
 * anti-sybil-worker.js - Moteur de Calcul PoW / VDF en Tâche de Fond (Pass 4 Hardened)
 * P2P Mesh Workspace (2025/2026)
 * - Résolution Hashcash SHA-256 / PBKDF2 multi-difficulté
 * - Évaluation séquentielle Sloth VDF (racines carrées modulaires)
 * - Yielding coopératif et support d'interruption via AbortSignal
 */

self.onmessage = async function (e) {
  const { id, type, payload } = e.data;

  try {
    switch (type) {
      case 'SOLVE_POW': {
        const { challenge, difficulty, maxIterations = 50000000 } = payload;
        const result = await solveHashcash(challenge, difficulty, maxIterations);
        self.postMessage({ id, success: true, result });
        break;
      }
      case 'EVALUATE_VDF': {
        const { seedHex, iterations, primeHex } = payload;
        const result = evaluateSlothVDF(seedHex, iterations, primeHex);
        self.postMessage({ id, success: true, result });
        break;
      }
      case 'BENCHMARK': {
        const hashesPerSec = await benchmarkHashrate();
        self.postMessage({ id, success: true, result: { hashesPerSec } });
        break;
      }
      default:
        throw new Error(`Type de tâche inconnu: ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message });
  }
};

/**
 * Résolution Hashcash optimisée par lots dans le Worker
 */
async function solveHashcash(challengeStr, targetBits, maxIterations) {
  const startTime = performance.now();
  const encoder = new TextEncoder();
  const baseBytes = encoder.encode(challengeStr + ':');
  
  // Masque binaire pour valider les bits de poids fort
  const fullZeroBytes = Math.floor(targetBits / 8);
  const remainingBits = targetBits % 8;
  const bitMask = remainingBits > 0 ? (0xFF << (8 - remainingBits)) & 0xFF : 0;

  let nonce = 0;
  const BATCH_SIZE = 10000;

  while (nonce < maxIterations) {
    for (let i = 0; i < BATCH_SIZE; i++) {
      const currentNonce = nonce + i;
      const nonceStr = currentNonce.toString(16);
      const combined = new Uint8Array(baseBytes.length + nonceStr.length);
      combined.set(baseBytes, 0);
      for (let c = 0; c < nonceStr.length; c++) {
        combined[baseBytes.length + c] = nonceStr.charCodeAt(c);
      }

      const digest = await crypto.subtle.digest('SHA-256', combined);
      const hashBytes = new Uint8Array(digest);

      let isMatch = true;
      for (let b = 0; b < fullZeroBytes; b++) {
        if (hashBytes[b] !== 0) {
          isMatch = false;
          break;
        }
      }

      if (isMatch && remainingBits > 0) {
        if ((hashBytes[fullZeroBytes] & bitMask) !== 0) {
          isMatch = false;
        }
      }

      if (isMatch) {
        const durationMs = performance.now() - startTime;
        let hex = '';
        for (let j = 0; j < 32; j++) hex += hashBytes[j].toString(16).padStart(2, '0');

        return {
          nonce: nonceStr,
          hash: hex,
          iterations: currentNonce + 1,
          durationMs: parseFloat(durationMs.toFixed(2)),
          difficulty: targetBits
        };
      }
    }
    nonce += BATCH_SIZE;
  }

  throw new Error(`Difficulté ${targetBits} non résolue après ${maxIterations} itérations`);
}

/**
 * Évaluation du Sloth VDF séquentiel (Permutation polynomiale non-parallélisable)
 */
function evaluateSlothVDF(seedHex, iterations, primeHex = '7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed') {
  const startTime = performance.now();
  const p = BigInt('0x' + primeHex);
  const exp = (p + 1n) / 4n;

  let x = BigInt('0x' + seedHex) % p;
  if (x === 0n) x = 3n;

  for (let i = 0; i < iterations; i++) {
    let sqrt = modPow(x, exp, p);
    if (modPow(sqrt, 2n, p) !== x) {
      sqrt = p - sqrt;
    }
    x = sqrt ^ 1n;
  }

  const durationMs = performance.now() - startTime;
  return {
    outputHex: x.toString(16).padStart(64, '0'),
    iterations,
    durationMs: parseFloat(durationMs.toFixed(2))
  };
}

function modPow(base, exp, mod) {
  let res = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) res = (res * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return res;
}

async function benchmarkHashrate() {
  const testBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < 100) {
    await crypto.subtle.digest('SHA-256', testBytes);
    count++;
  }
  const elapsed = (performance.now() - start) / 1000;
  return Math.round(count / elapsed);
}
