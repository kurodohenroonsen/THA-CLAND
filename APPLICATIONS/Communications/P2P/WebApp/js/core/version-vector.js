/**
 * Core/version-vector.js - Vecteurs de Version & Causal Kernels (2025/2026)
 * Gestion du suivi de causalité distribué pour architectures CRDT Local-First.
 */

export class VersionVector {
  constructor(initialMap = {}) {
    // Map<authorPubkey, maxSequenceNumber>
    this.clocks = new Map();
    if (initialMap instanceof VersionVector) {
      initialMap.clocks.forEach((v, k) => this.clocks.set(k, v));
    } else if (initialMap && typeof initialMap === 'object') {
      for (const [k, v] of Object.entries(initialMap)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          this.clocks.set(k, v);
        }
      }
    }
  }

  /**
   * Met à jour ou fait progresser l'horloge pour un auteur donné
   */
  set(actorPubkey, seq) {
    if (!actorPubkey || typeof seq !== 'number') return;
    const current = this.clocks.get(actorPubkey) || 0;
    this.clocks.set(actorPubkey, Math.max(current, seq));
    return this;
  }

  /**
   * Obtient la séquence maximale connue pour un auteur
   */
  get(actorPubkey) {
    return this.clocks.get(actorPubkey) || 0;
  }

  /**
   * Fait avancer d'une unité l'horloge locale
   */
  tick(actorPubkey) {
    const next = (this.clocks.get(actorPubkey) || 0) + 1;
    this.clocks.set(actorPubkey, next);
    return next;
  }

  /**
   * Fusionne un autre vecteur de version (Supremum / Join semi-treillis)
   */
  merge(otherVector) {
    if (!otherVector) return this;
    const otherMap = otherVector instanceof VersionVector ? otherVector.clocks : new Map(Object.entries(otherVector));
    for (const [actor, seq] of otherMap.entries()) {
      const local = this.clocks.get(actor) || 0;
      this.clocks.set(actor, Math.max(local, seq));
    }
    return this;
  }

  /**
   * Détermine si ce vecteur domine strictement ou est égal à un autre vecteur
   */
  dominates(otherVector) {
    const otherMap = otherVector instanceof VersionVector ? otherVector.clocks : new Map(Object.entries(otherVector));
    for (const [actor, seq] of otherMap.entries()) {
      const local = this.clocks.get(actor) || 0;
      if (local < seq) return false;
    }
    return true;
  }

  /**
   * Calcule le différentiel causal : quels acteurs ont des mises à jour à fournir
   */
  diff(otherVector) {
    const otherMap = otherVector instanceof VersionVector ? otherVector.clocks : new Map(Object.entries(otherVector));
    const missingOnLocal = [];
    const missingOnRemote = [];

    const allActors = new Set([...this.clocks.keys(), ...otherMap.keys()]);

    for (const actor of allActors) {
      const localSeq = this.clocks.get(actor) || 0;
      const remoteSeq = otherMap.get(actor) || 0;

      if (remoteSeq > localSeq) {
        missingOnLocal.push({ actor, fromSeq: localSeq, toSeq: remoteSeq });
      } else if (localSeq > remoteSeq) {
        missingOnRemote.push({ actor, fromSeq: remoteSeq, toSeq: localSeq });
      }
    }

    return { missingOnLocal, missingOnRemote };
  }

  /**
   * Clone le vecteur
   */
  clone() {
    const copy = new VersionVector();
    for (const [k, v] of this.clocks) {
      copy.clocks.set(k, v);
    }
    return copy;
  }

  /**
   * Sérialise en objet JSON compact
   */
  toJSON() {
    const obj = {};
    for (const [k, v] of this.clocks) {
      obj[k] = v;
    }
    return obj;
  }

  /**
   * Désérialise depuis un objet JSON
   */
  static fromJSON(jsonObj) {
    return new VersionVector(jsonObj || {});
  }
}
