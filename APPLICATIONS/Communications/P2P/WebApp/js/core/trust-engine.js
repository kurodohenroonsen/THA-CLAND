/**
 * trust-engine.js - Moteur de Réputation Souveraine & Personalized EigenTrust (Web of Trust)
 * P2P Mesh Workspace (Pass 2 - 2026)
 */

import { CryptoVault } from './crypto-vault.js';
import { dbManager } from './local-storage.js';
import { logger } from './logger.js';

export const TRUST_TIERS = {
  BLOCKED: 0,
  UNKNOWN: 1,
  WOT_TRUSTED: 2,
  SAS_DIRECT: 3
};

export class TrustEngine {
  constructor(cryptoVault) {
    this.vault = cryptoVault;
    this.directSeeds = new Set(); // pubkeys vérifiées physiquement SAS
    this.attestations = new Map(); // issuerPubkey -> Map<subjectPubkey, { score, expiresAt, sig }>
    this.computedScores = new Map(); // pubkey -> float [0.0 - 1.0]
    this.revocations = new Set(); // Set<subjectPubkey>
    this.alpha = 0.15; // Facteur de téléportation anti-Sybil
  }

  async init() {
    try {
      const attestations = await dbManager.getAll('trust_attestations');
      if (Array.isArray(attestations)) {
        for (const att of attestations) {
          if (att.expiresAt > Date.now() && !this.revocations.has(att.subjectPubkey)) {
            if (att.issuerPubkey === this.vault.publicKeyHex) {
              this.directSeeds.add(att.subjectPubkey);
            }
            this._addAttestationMemory(att);
          }
        }
      }
      const revs = await dbManager.getAll('trust_revocations');
      if (Array.isArray(revs)) {
        for (const r of revs) {
          this.revocations.add(r.subjectPubkey);
        }
      }
      this.computeEigenTrust();
      logger.info('Trust', `🛡️ TrustEngine initialisé. ${this.directSeeds.size} graines SAS, ${this.attestations.size} émetteurs.`);
    } catch (e) {
      logger.debug('Trust', 'Initialisation TrustEngine DB:', e);
    }
  }

  _addAttestationMemory(attestation) {
    if (!this.attestations.has(attestation.issuerPubkey)) {
      this.attestations.set(attestation.issuerPubkey, new Map());
    }
    this.attestations.get(attestation.issuerPubkey).set(attestation.subjectPubkey, {
      trustScore: attestation.trustScore || 1.0,
      expiresAt: attestation.expiresAt || (Date.now() + 365 * 86400000),
      signature: attestation.signature
    });
  }

  /**
   * Enregistre une attestation de confiance signée suite à validation SAS
   */
  async createVouchAttestation(subjectPubkey, trustScore = 1.0, validDurationMs = 365 * 86400000) {
    const now = Date.now();
    const attestation = {
      type: 'TRUST_VOUCH_V1',
      issuerPubkey: this.vault.publicKeyHex,
      subjectPubkey,
      trustScore: Math.max(0.0, Math.min(1.0, trustScore)),
      verificationMethod: 'SAS_IN_PERSON',
      timestamp: now,
      expiresAt: now + validDurationMs
    };

    attestation.signature = await this.vault.sign(attestation);
    await dbManager.save('trust_attestations', attestation);

    this.directSeeds.add(subjectPubkey);
    this._addAttestationMemory(attestation);
    this.computeEigenTrust();

    return attestation;
  }

  /**
   * Révoque une attestation de confiance
   */
  async revokeTrust(subjectPubkey, reason = 'UNSPECIFIED') {
    const revocation = {
      type: 'TRUST_REVOKE_V1',
      issuerPubkey: this.vault.publicKeyHex,
      subjectPubkey,
      reason,
      timestamp: Date.now()
    };
    revocation.signature = await this.vault.sign(revocation);
    await dbManager.save('trust_revocations', revocation);

    this.revocations.add(subjectPubkey);
    this.directSeeds.delete(subjectPubkey);
    this.computeEigenTrust();
    return revocation;
  }

  /**
   * Calcule le score Personalized EigenTrust pour l'ensemble du maillage
   */
  computeEigenTrust(maxIterations = 15, epsilon = 1e-4) {
    const allPubkeys = new Set([this.vault.publicKeyHex, ...this.directSeeds]);
    for (const [issuer, subjects] of this.attestations.entries()) {
      allPubkeys.add(issuer);
      for (const sub of subjects.keys()) allPubkeys.add(sub);
    }

    const nodes = Array.from(allPubkeys);
    const n = nodes.length;
    if (n === 0) return;

    const nodeIndices = new Map(nodes.map((k, i) => [k, i]));
    const myIdx = nodeIndices.get(this.vault.publicKeyHex);

    // 1. Vecteur de graine personnalisée p (Moi = 0.5, SAS directs partagent 0.5)
    const p = new Float64Array(n);
    if (myIdx !== undefined) p[myIdx] = 0.5;
    const directCount = this.directSeeds.size;
    if (directCount > 0) {
      const perSeed = 0.5 / directCount;
      for (const seed of this.directSeeds) {
        const idx = nodeIndices.get(seed);
        if (idx !== undefined) p[idx] = perSeed;
      }
    } else if (myIdx !== undefined) {
      p[myIdx] = 1.0;
    }

    // 2. Construction de la matrice normalisée C (Out-degree normalisé + Dangling Nodes)
    const C = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      const issuer = nodes[i];
      const subMap = this.attestations.get(issuer);

      if (subMap && subMap.size > 0) {
        let totalWeight = 0;
        for (const [sub, att] of subMap.entries()) {
          if (att.expiresAt > Date.now() && !this.revocations.has(sub)) {
            totalWeight += att.trustScore;
          }
        }

        if (totalWeight > 0) {
          for (const [sub, att] of subMap.entries()) {
            const j = nodeIndices.get(sub);
            if (j !== undefined && att.expiresAt > Date.now() && !this.revocations.has(sub)) {
              C[i][j] = att.trustScore / totalWeight;
            }
          }
        } else {
          for (let j = 0; j < n; j++) C[i][j] = p[j];
        }
      } else {
        // Dangling node : redistribution proportionnelle au vecteur p
        for (let j = 0; j < n; j++) C[i][j] = p[j];
      }
    }

    // 3. Itération de puissance t^(k+1) = (1 - alpha) * C^T * t^(k) + alpha * p
    let t = new Float64Array(p);
    for (let iter = 0; iter < maxIterations; iter++) {
      const nextT = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          sum += C[i][j] * t[i];
        }
        nextT[j] = (1 - this.alpha) * sum + this.alpha * p[j];
      }

      let diff = 0;
      for (let k = 0; k < n; k++) diff += Math.abs(nextT[k] - t[k]);
      t = nextT;
      if (diff < epsilon) break;
    }

    // 4. Mise à jour des scores
    this.computedScores.clear();
    nodes.forEach((pubkey, idx) => {
      this.computedScores.set(pubkey, t[idx]);
    });
  }

  getTrustTier(pubkey) {
    if (!pubkey) return TRUST_TIERS.UNKNOWN;
    if (this.revocations.has(pubkey)) return TRUST_TIERS.BLOCKED;
    if (pubkey === this.vault.publicKeyHex || this.directSeeds.has(pubkey)) return TRUST_TIERS.SAS_DIRECT;
    const score = this.computedScores.get(pubkey) || 0;
    if (score >= 0.15) return TRUST_TIERS.WOT_TRUSTED;
    return TRUST_TIERS.UNKNOWN;
  }
}
