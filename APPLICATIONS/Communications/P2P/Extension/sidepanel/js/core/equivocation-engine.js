/**
 * equivocation-engine.js - Moteur Anti-Équivocation Byzantine & Slashing Réseau (PoEq)
 * P2P Mesh Workspace (Pass 4 Hardened Edition - 2026)
 * 
 * Spécification & Garanties :
 * - Détection O(1) de doubles signatures contradictoires sur contextes Lamport, Merkle & CRDT
 * - Preuve d'équivocation formelle autosuffisante (RFC 8785 JCS + ECDSA P-256)
 * - Validation préalable anti-frame attack (signature valide obligatoire avant toute comparaison)
 * - Dissémination épidémique prioritaire sur canal de contrôle ('p2p-control' / OpCode 0x80)
 * - Révocation instantanée et irréversible (IndexedDB 'banned_peers', WebRTC teardown, TrustEngine BLOCKED)
 * - Cache glissant borné (Sliding LRU) anti-DoS / anti-OOM
 */

import { CryptoVault } from './crypto-vault.js';
import { dbManager } from './local-storage.js';
import { logger } from './logger.js';
import { GenerationalSlidingCache } from './bounded-cache.js';

export class EquivocationEngine {
  /**
   * @param {object} meshNetwork - Instance de P2PMesh
   * @param {object} [trustEngine] - Instance optionnelle de TrustEngine pour mise au ban coordonnée
   * @param {object} [crdtEngine] - Instance optionnelle de CRDTEngine pour purge d'état
   */
  constructor(meshNetwork, trustEngine = null, crdtEngine = null) {
    this.mesh = meshNetwork;
    this.trustEngine = trustEngine;
    this.crdtEngine = crdtEngine;
    this.bannedPubkeys = new Set();
    
    // Cache glissant borné pour indexer les signatures observées par contexte (Anti-OOM)
    this.contextSignatureCache = new Map();
    this.maxContextEntries = 10000;
    
    // Registre des preuves déjà traitées pour éviter les tempêtes de gossip
    this.processedProofHashes = new GenerationalSlidingCache({
      generationSize: 5000,
      rotateIntervalMs: 300000 // 5 minutes
    });
  }

  setTrustEngine(trustEngine) {
    this.trustEngine = trustEngine;
  }

  setCRDTEngine(crdtEngine) {
    this.crdtEngine = crdtEngine;
  }

  /**
   * Initialise le moteur en chargeant la liste noire persistée
   */
  async init() {
    try {
      const banned = await dbManager.getAll('banned_peers').catch(() => []);
      if (Array.isArray(banned)) {
        banned.forEach((b) => {
          if (b && b.pubkey) this.bannedPubkeys.add(b.pubkey);
        });
      }
      logger.info('Consensus', `🛡️ EquivocationEngine initialisé. ${this.bannedPubkeys.size} pairs bannis en liste noire.`);
    } catch (e) {
      logger.debug('Consensus', 'Initialisation table banned_peers:', e);
    }
  }

  /**
   * Vérifie si une clé publique est bannie du réseau
   */
  isPeerBanned(pubkey) {
    if (!pubkey) return false;
    return this.bannedPubkeys.has(pubkey);
  }

  /**
   * Inspecte un commit Drive pour détecter une équivocation sur la version du fichier
   */
  async inspectCommit(commit) {
    if (!commit || !commit.authorPubkey || !commit.signature) return false;
    if (this.isPeerBanned(commit.authorPubkey)) {
      logger.warn('Consensus', `🚫 Message ignoré : émetteur ${commit.authorPubkey.substring(0, 12)}... est banni`);
      return true; // Rejeté
    }

    const version = commit.versionNumber || 1;
    const contextKey = `drive:${commit.fileId}:v${version}`;
    return await this._checkEquivocation(contextKey, commit, ['commitId']);
  }

  /**
   * Inspecte une opération CRDT générique (Chat, Forum, Delete, etc.) sur son slot Lamport
   */
  async inspectLamportOperation(op) {
    if (!op || !op.authorPubkey || !op.signature || typeof op.lamport !== 'number') return false;
    if (this.isPeerBanned(op.authorPubkey)) return true;

    // Détection de fork causal : double émission avec le même compteur Lamport
    const contextKey = `lamport:${op.authorPubkey}:${op.lamport}`;
    return await this._checkEquivocation(contextKey, op);
  }

  /**
   * Cœur de détection O(1) et génération de la preuve de fraude avec validation anti-frame attack
   */
  async _checkEquivocation(contextKey, obj, excludeFields = []) {
    if (!obj || !obj.authorPubkey || !obj.signature) return false;
    const authorPubkey = obj.authorPubkey;

    if (this.isPeerBanned(authorPubkey)) {
      return true;
    }

    const excludes = Array.isArray(excludeFields) ? excludeFields : [excludeFields];
    if (!excludes.includes('signature')) excludes.push('signature');

    const canonicalStr = CryptoVault.canonicalize(obj, excludes);
    const sig = obj.signature;

    // 1. Validation préalable de la signature cryptographique (Anti-Frame Attack)
    const isSigValid = await CryptoVault.verify(obj, sig, authorPubkey, excludes);
    if (!isSigValid) {
      logger.warn('Consensus', `⚠️ Signature invalide sur ${contextKey}. Rejet immédiat sans slashing.`);
      return false;
    }

    // Nettoyage LRU si saturation du cache
    if (this.contextSignatureCache.size >= this.maxContextEntries) {
      const firstKey = this.contextSignatureCache.keys().next().value;
      this.contextSignatureCache.delete(firstKey);
    }

    if (this.contextSignatureCache.has(contextKey)) {
      const prev = this.contextSignatureCache.get(contextKey);
      
      // Vérification si le même auteur a produit deux états canoniques divergents
      if (prev.authorPubkey === authorPubkey && prev.canonical !== canonicalStr) {
        // 🚨 ÉQUIVOCATION BYZANTINE DÉTECTÉE !
        logger.error('Consensus', `🚨 ÉQUIVOCATION BYZANTINE DÉTECTÉE ! Auteur: ${authorPubkey.substring(0, 16)}... Contexte: ${contextKey}`);

        let prevData;
        try {
          prevData = JSON.parse(prev.canonical);
        } catch {
          prevData = prev.rawObj || prev.canonical;
        }

        const proof = {
          type: 'BYZANTINE_EQUIVOCATION_PROOF',
          version: '2.0',
          offenderPubkey: authorPubkey,
          offenderPeerId: obj.authorId || `peer_${(await CryptoVault.hashSHA256(authorPubkey)).substring(0, 16)}`,
          contextKey,
          assertionA: {
            data: prevData,
            signature: prev.signature
          },
          assertionB: {
            data: obj,
            signature: sig
          },
          detectedAt: Date.now(),
          reporterPeerId: this.mesh?.vault?.peerId || 'local'
        };

        await this.slashByzantineNode(proof);
        return true; // Action malveillante interceptée et neutralisée
      }
    } else {
      this.contextSignatureCache.set(contextKey, {
        authorPubkey,
        canonical: canonicalStr,
        signature: sig,
        rawObj: obj,
        id: obj.id || obj.commitId,
        timestamp: Date.now()
      });
    }

    return false;
  }

  /**
   * Traite une preuve d'équivocation reçue du réseau P2P (Gossip)
   */
  async handleIncomingFraudProof(proof) {
    if (!proof || proof.type !== 'BYZANTINE_EQUIVOCATION_PROOF') return false;

    const proofHash = await CryptoVault.hashSHA256(JSON.stringify({
      pubkey: proof.offenderPubkey,
      ctx: proof.contextKey,
      sigA: proof.assertionA?.signature,
      sigB: proof.assertionB?.signature
    }));

    if (!this.processedProofHashes.addIfNew(proofHash)) {
      return false; // Preuve déjà traitée
    }

    if (this.isPeerBanned(proof.offenderPubkey)) {
      return true; // Déjà neutralisé
    }

    const isValid = await EquivocationEngine.verifyFraudProof(proof);
    if (!isValid) {
      logger.warn('Consensus', `⚠️ Preuve de fraude invalide reçue de ${proof.reporterPeerId || 'inconnu'}. Rejet.`);
      return false;
    }

    logger.error('Consensus', `⚡ PREUVE D'ÉQUIVOCATION VALIDÉE DU RÉSEAU pour ${proof.offenderPubkey.substring(0, 16)}... Application du Slashing.`);
    await this.slashByzantineNode(proof, false);
    return true;
  }

  /**
   * Exécute le slashing complet, la révocation irréversible et la propagation swarm
   */
  async slashByzantineNode(proof, shouldBroadcast = true) {
    const pubkey = proof.offenderPubkey;
    if (!pubkey) return;

    this.bannedPubkeys.add(pubkey);

    // 1. Persistance IndexedDB (Liste Noire)
    try {
      await dbManager.save('banned_peers', {
        pubkey,
        peerId: proof.offenderPeerId,
        reason: `Equivocation on ${proof.contextKey}`,
        proof,
        bannedAt: Date.now()
      });
    } catch (e) {
      logger.debug('Consensus', 'Erreur sauvegarde banned_peers:', e);
    }

    // 2. Révocation immédiate dans le TrustEngine (Web of Trust)
    if (this.trustEngine && typeof this.trustEngine.revokeTrust === 'function') {
      try {
        await this.trustEngine.revokeTrust(pubkey, `BYZANTINE_EQUIVOCATION:${proof.contextKey}`);
      } catch (e) {
        logger.debug('Consensus', 'Erreur mise à jour TrustEngine:', e);
      }
    }

    // 3. Purge et Quarantaine d'état dans le CRDTEngine
    if (this.crdtEngine && typeof this.crdtEngine.purgeAuthorData === 'function') {
      try {
        await this.crdtEngine.purgeAuthorData(pubkey);
      } catch (e) {
        logger.debug('Consensus', 'Erreur purge CRDT:', e);
      }
    }

    // 4. Diffusion Gossip Haute Priorité sur le canal de contrôle
    if (shouldBroadcast && this.mesh && typeof this.mesh.broadcast === 'function') {
      logger.info('Consensus', `📢 Dissémination épidémique de la preuve d'équivocation au maillage...`);
      await this.mesh.broadcast({
        type: 'EQUIVOCATION_PROOF_BROADCAST',
        proof
      });
    }

    // 5. Coupure immédiate de toutes les connexions WebRTC avec le nœud byzantin
    if (this.mesh && this.mesh.peers) {
      this.mesh.peers.forEach((peer, peerId) => {
        if (peer._remotePubkey === pubkey || peerId === proof.offenderPeerId) {
          logger.warn('Consensus', `🔌 Déconnexion forcée et destruction du canal WebRTC pour le pair byzantin ${peerId}`);
          if (typeof peer.destroy === 'function') {
            peer.destroy();
          }
          this.mesh.peers.delete(peerId);
        }
      });
    }
  }

  /**
   * Vérifie formellement en O(1) une preuve d'équivocation sans dépendance d'état
   */
  static async verifyFraudProof(proof) {
    if (!proof || proof.type !== 'BYZANTINE_EQUIVOCATION_PROOF') return false;
    const { offenderPubkey, contextKey, assertionA, assertionB } = proof;
    if (!offenderPubkey || !contextKey || !assertionA || !assertionB) return false;
    if (!assertionA.data || !assertionA.signature || !assertionB.data || !assertionB.signature) return false;

    // 1. Vérification des 2 signatures ECDSA P-256 avec la clé publique incriminée
    const okA = await CryptoVault.verify(assertionA.data, assertionA.signature, offenderPubkey);
    const okB = await CryptoVault.verify(assertionB.data, assertionB.signature, offenderPubkey);

    if (!okA || !okB) {
      return false;
    }

    // 2. Vérification que les deux charges utiles canonisées sont strictement différentes
    const canA = CryptoVault.canonicalize(assertionA.data);
    const canB = CryptoVault.canonicalize(assertionB.data);

    return canA !== canB;
  }
}
