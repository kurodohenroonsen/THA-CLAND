/**
 * equivocation-engine.js - Moteur Anti-Équivocation Byzantine & Slashing Réseau (PoEq)
 * P2P Mesh Workspace (Pass 2 - 2026)
 */

import { CryptoVault } from './crypto-vault.js';
import { dbManager } from './local-storage.js';
import { logger } from './logger.js';

export class EquivocationEngine {
  constructor(meshNetwork) {
    this.mesh = meshNetwork;
    this.bannedPubkeys = new Set();
    this.knownSignaturesByContext = new Map(); // contextKey -> Map(authorPubkey, { canonical, signature, id })
  }

  async init() {
    try {
      const banned = await dbManager.getAll('banned_peers');
      if (Array.isArray(banned)) {
        banned.forEach((b) => this.bannedPubkeys.add(b.pubkey));
      }
      logger.info('Consensus', `🛡️ EquivocationEngine initialisé. ${this.bannedPubkeys.size} pairs bannis.`);
    } catch (e) {
      logger.debug('Consensus', 'Initialisation table banned_peers:', e);
    }
  }

  isPeerBanned(pubkey) {
    return this.bannedPubkeys.has(pubkey);
  }

  /**
   * Vérifie et détecte une équivocation sur un commit Drive entrant
   */
  async inspectCommit(commit) {
    if (!commit || !commit.authorPubkey || !commit.signature) return false;
    if (this.isPeerBanned(commit.authorPubkey)) {
      logger.warn('Consensus', `🚫 Message ignoré : émetteur ${commit.authorPubkey.substring(0, 12)}... banni`);
      return true; // Rejeté car banni
    }

    const contextKey = `drive:${commit.fileId}:v${commit.versionNumber || 1}`;
    return await this._checkEquivocation(contextKey, commit, ['commitId']);
  }

  /**
   * Cœur de détection et génération de la preuve d'équivocation
   */
  async _checkEquivocation(contextKey, obj, excludeFields = []) {
    const authorPubkey = obj.authorPubkey;
    const canonicalStr = CryptoVault.canonicalize(obj, excludeFields);
    const sig = obj.signature;

    if (!this.knownSignaturesByContext.has(contextKey)) {
      this.knownSignaturesByContext.set(contextKey, new Map());
    }

    const contextMap = this.knownSignaturesByContext.get(contextKey);

    if (contextMap.has(authorPubkey)) {
      const prev = contextMap.get(authorPubkey);
      if (prev.canonical !== canonicalStr) {
        // 🚨 ÉQUIVOCATION BYZANTINE DÉTECTÉE !
        logger.error('Consensus', `🚨 Équivocation byzantine détectée pour l'auteur ${authorPubkey.substring(0, 16)} sur ${contextKey} !`);

        const proof = {
          type: 'BYZANTINE_EQUIVOCATION_PROOF',
          version: '1.0',
          offenderPubkey: authorPubkey,
          offenderPeerId: obj.authorId || `peer_${(await CryptoVault.hashSHA256(authorPubkey)).substring(0, 16)}`,
          contextKey,
          assertionA: {
            data: JSON.parse(prev.canonical),
            signature: prev.signature
          },
          assertionB: {
            data: obj,
            signature: sig
          },
          detectedAt: Date.now()
        };

        await this.slashByzantineNode(proof);
        return true; // Action malveillante interceptée
      }
    } else {
      contextMap.set(authorPubkey, {
        canonical: canonicalStr,
        signature: sig,
        id: obj.id || obj.commitId
      });
    }

    return false;
  }

  /**
   * Exécute le slashing et la diffusion de la preuve de fraude au maillage
   */
  async slashByzantineNode(proof) {
    const pubkey = proof.offenderPubkey;
    this.bannedPubkeys.add(pubkey);

    // 1. Persistance IndexedDB
    try {
      await dbManager.save('banned_peers', {
        pubkey,
        peerId: proof.offenderPeerId,
        reason: `Equivocation on ${proof.contextKey}`,
        proof,
        bannedAt: Date.now()
      });
    } catch {
      // Ignorer si table non migrée
    }

    // 2. Diffusion Gossip haute priorité de la preuve d'équivocation
    if (this.mesh && typeof this.mesh.broadcast === 'function') {
      await this.mesh.broadcast({
        type: 'EQUIVOCATION_PROOF_BROADCAST',
        proof
      });
    }

    // 3. Coupure immédiate de toute connexion WebRTC active avec le pair déchu
    if (this.mesh && this.mesh.peers) {
      this.mesh.peers.forEach((peer, peerId) => {
        if (peer._remotePubkey === pubkey || peerId === proof.offenderPeerId) {
          logger.warn('Consensus', `🔌 Déconnexion forcée du pair byzantin ${peerId}`);
          if (typeof peer.destroy === 'function') peer.destroy();
          this.mesh.peers.delete(peerId);
        }
      });
    }
  }

  /**
   * Vérifie une preuve d'équivocation reçue du réseau
   */
  static async verifyFraudProof(proof) {
    if (!proof || proof.type !== 'BYZANTINE_EQUIVOCATION_PROOF') return false;
    const { offenderPubkey, assertionA, assertionB } = proof;
    if (!offenderPubkey || !assertionA || !assertionB) return false;

    const okA = await CryptoVault.verify(assertionA.data, assertionA.signature, offenderPubkey);
    const okB = await CryptoVault.verify(assertionB.data, assertionB.signature, offenderPubkey);

    if (!okA || !okB) return false;

    const canA = CryptoVault.canonicalize(assertionA.data);
    const canB = CryptoVault.canonicalize(assertionB.data);

    return canA !== canB;
  }
}
