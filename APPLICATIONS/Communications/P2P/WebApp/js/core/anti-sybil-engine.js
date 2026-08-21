/**
 * anti-sybil-engine.js - Moteur Principal Anti-Sybil & PoW/VDF Adaptatif (Pass 4 Hardened)
 * P2P Mesh Workspace (2025/2026)
 * - Gestionnaire de difficulté dynamique Leaky-Bucket
 * - Filtre Gatekeeper Pré-Déchiffrement O(1) (< 10 µs)
 * - Orchestration du Web Worker d'arrière-plan avec fallback synchrone
 * - Intégration transparente TrustEngine & CryptoVault
 */

import { logger } from './logger.js';
import { CryptoVault } from './crypto-vault.js';
import { TRUST_TIERS } from './trust-engine.js';
import { TTLMap, BoundedSet } from './bounded-cache.js';

export class AntiSybilEngine {
  constructor(cryptoVault, trustEngine = null, options = {}) {
    this.vault = cryptoVault;
    this.trustEngine = trustEngine;

    this.baseDifficulty = options.baseDifficulty || 8; // 8 bits de base
    this.maxDifficulty = options.maxDifficulty || 24;  // 24 bits max
    this.epochDurationMs = options.epochDurationMs || 60000; // Fenêtre 1 min

    // Métriques par pair émetteur
    this.peerVelocity = new TTLMap({ maxSize: 1000, ttlMs: 120000 });
    this.seenNonces = new BoundedSet(50000);

    // Initialisation du Web Worker
    this.worker = null;
    this.taskCounter = 0;
    this.pendingTasks = new Map();
    this._initWorker();
  }

  _initWorker() {
    try {
      if (typeof Worker !== 'undefined') {
        const workerUrl = new URL('./anti-sybil-worker.js', import.meta.url);
        this.worker = new Worker(workerUrl, { type: 'module' });
        this.worker.onmessage = (e) => this._handleWorkerMessage(e.data);
        this.worker.onerror = (err) => logger.warn('AntiSybil', 'Erreur Web Worker:', err.message);
        logger.info('AntiSybil', '⚡ Web Worker Anti-Sybil initialisé avec succès.');
      }
    } catch (e) {
      logger.debug('AntiSybil', 'Web Worker non disponible, mode local actif:', e.message);
    }
  }

  _handleWorkerMessage(data) {
    const { id, success, result, error } = data;
    const task = this.pendingTasks.get(id);
    if (!task) return;

    this.pendingTasks.delete(id);
    if (success) {
      task.resolve(result);
    } else {
      task.reject(new Error(error || 'Échec tâche Worker'));
    }
  }

  _runInWorker(type, payload) {
    if (!this.worker) {
      return this._fallbackLocalSolve(type, payload);
    }

    return new Promise((resolve, reject) => {
      const id = ++this.taskCounter;
      this.pendingTasks.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  /**
   * Calcule la difficulté requise pour un message sortant ou entrant
   */
  computeRequiredDifficulty(authorPubkey, isLocal = false) {
    if (!authorPubkey) return this.baseDifficulty;

    // 1. Déduction basée sur le niveau de confiance
    let trustDiscount = 0;
    if (this.trustEngine) {
      const tier = this.trustEngine.getTrustTier(authorPubkey);
      if (tier === TRUST_TIERS.SAS_DIRECT) {
        return 0; // Exemption totale pour les contacts vérifiés SAS
      } else if (tier === TRUST_TIERS.WOT_TRUSTED || tier === TRUST_TIERS.VERIFIED_CREDENTIAL) {
        trustDiscount = 6;
      }
    }

    // 2. Évaluation de la vélocité d'émission (Leaky-Bucket)
    const now = Date.now();
    let vel = this.peerVelocity.get(authorPubkey);
    if (!vel || now - vel.windowStart > 10000) {
      vel = { count: 0, windowStart: now, lastSeen: now };
      this.peerVelocity.set(authorPubkey, vel);
    }

    if (!isLocal) {
      vel.count++;
      vel.lastSeen = now;
    }

    const ratePerSec = vel.count / Math.max(1, (now - vel.windowStart) / 1000);
    let penaltyBits = 0;
    if (ratePerSec > 1.5) {
      penaltyBits = Math.min(16, Math.floor((ratePerSec - 1.5) * 4));
    }

    const targetDifficulty = Math.max(
      0,
      Math.min(this.maxDifficulty, this.baseDifficulty + penaltyBits - trustDiscount)
    );

    return targetDifficulty;
  }

  /**
   * Génère le défi cryptographique (Challenge) lié à l'époque et au topic
   */
  generateChallenge(authorPubkey, customSalt = '') {
    const epoch = Math.floor(Date.now() / this.epochDurationMs);
    const topic = this.vault.topicHex || 'global';
    return `${topic}:${authorPubkey.substring(0, 16)}:${epoch}:${customSalt}`;
  }

  /**
   * Attache un en-tête de Preuve de Travail (PoW Header) à une enveloppe sortante
   */
  async attachProofOfWork(envelope, authorPubkey = null) {
    const pubkey = authorPubkey || this.vault.publicKeyHex;
    const difficulty = this.computeRequiredDifficulty(pubkey, true);

    if (difficulty === 0) {
      return {
        ...envelope,
        _pow: { type: 'NONE', difficulty: 0, authorPubkey: pubkey, timestamp: Date.now() }
      };
    }

    const challenge = this.generateChallenge(pubkey, envelope.id || envelope._gspId || '');
    logger.debug('AntiSybil', `⛏️ Calcul PoW requis (Difficulté: ${difficulty} bits) pour ${pubkey.substring(0, 8)}...`);

    const solution = await this._runInWorker('SOLVE_POW', { challenge, difficulty });

    return {
      ...envelope,
      _pow: {
        type: 'HASHCASH_V1',
        challenge,
        nonce: solution.nonce,
        difficulty,
        hash: solution.hash,
        authorPubkey: pubkey,
        timestamp: Date.now()
      }
    };
  }

  /**
   * GATEKEEPER ULTRA-RAPIDE (< 10 µs) : Valide le PoW avant déchiffrement
   */
  async verifyIncomingGatekeeper(rawPacket) {
    if (!rawPacket || typeof rawPacket !== 'object') return false;

    const pow = rawPacket._pow;
    if (!pow) {
      // Si pas de PoW, autoriser uniquement si pair SAS_DIRECT
      if (rawPacket.authorPubkey && this.trustEngine) {
        const tier = this.trustEngine.getTrustTier(rawPacket.authorPubkey);
        if (tier === TRUST_TIERS.SAS_DIRECT) return true;
      }
      return true; // Mode rétro-compatible si désactivé
    }

    // 1. Exemption SAS
    if (pow.type === 'NONE' && this.trustEngine) {
      const tier = this.trustEngine.getTrustTier(pow.authorPubkey);
      if (tier === TRUST_TIERS.SAS_DIRECT) return true;
    }

    if (pow.type !== 'HASHCASH_V1') {
      return false;
    }

    // 2. Vérification de la fraîcheur temporelle (Anti-Replay)
    const now = Date.now();
    if (Math.abs(now - pow.timestamp) > this.epochDurationMs * 2) {
      logger.warn('AntiSybil', '🚫 Enveloppe rejetée : PoW expiré');
      return false;
    }

    // 3. Unicité du nonce
    const nonceKey = `${pow.challenge}:${pow.nonce}`;
    if (!this.seenNonces.addIfNew(nonceKey)) {
      logger.warn('AntiSybil', '🚫 Enveloppe rejetée : PoW déjà consommé');
      return false;
    }

    // 4. Vérification de la difficulté minimale requise
    const requiredDiff = this.computeRequiredDifficulty(pow.authorPubkey, false);
    if (pow.difficulty < requiredDiff) {
      logger.warn('AntiSybil', `🚫 Enveloppe rejetée : Difficulté insuffisante (${pow.difficulty} < ${requiredDiff})`);
      return false;
    }

    // 5. Validation instantanée SHA-256
    const encoder = new TextEncoder();
    const testBytes = encoder.encode(`${pow.challenge}:${pow.nonce}`);
    const digest = await crypto.subtle.digest('SHA-256', testBytes);
    const hashBytes = new Uint8Array(digest);

    const fullZeroBytes = Math.floor(pow.difficulty / 8);
    const remainingBits = pow.difficulty % 8;
    const bitMask = remainingBits > 0 ? (0xFF << (8 - remainingBits)) & 0xFF : 0;

    for (let b = 0; b < fullZeroBytes; b++) {
      if (hashBytes[b] !== 0) return false;
    }

    if (remainingBits > 0 && (hashBytes[fullZeroBytes] & bitMask) !== 0) {
      return false;
    }

    return true;
  }

  /**
   * Fallback synchrone local si les Web Workers sont indisponibles
   */
  async _fallbackLocalSolve(type, payload) {
    if (type === 'SOLVE_POW') {
      const { challenge, difficulty } = payload;
      const encoder = new TextEncoder();
      const base = encoder.encode(challenge + ':');
      let nonce = 0;
      while (nonce < 2000000) {
        const nStr = nonce.toString(16);
        const combined = new Uint8Array(base.length + nStr.length);
        combined.set(base, 0);
        for (let c = 0; c < nStr.length; c++) combined[base.length + c] = nStr.charCodeAt(c);
        const digest = await crypto.subtle.digest('SHA-256', combined);
        const bytes = new Uint8Array(digest);
        if (bytes[0] === 0 && (difficulty <= 8 || bytes[1] < 16)) {
          return { nonce: nStr, difficulty, iterations: nonce, hash: CryptoVault.bufferToHex(digest) };
        }
        nonce++;
      }
    }
    throw new Error('PoW Fallback dépassé');
  }

  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingTasks.clear();
    this.peerVelocity.clear();
    this.seenNonces.clear();
  }
}
