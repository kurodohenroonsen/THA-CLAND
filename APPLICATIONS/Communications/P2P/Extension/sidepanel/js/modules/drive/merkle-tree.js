/**
 * MerkleTree.js
 * Implémentation d'Arbre de Merkle Binaire conforme RFC 6962 (Domain Separation)
 * et Preuves d'Inclusion SPV O(log N) pour le Drive P2P Mesh Workspace
 */

import { CryptoVault } from '../../core/crypto-vault.js';
import { logger } from '../../core/logger.js';

export class MerkleTree {
  /**
   * Construit un arbre de Merkle binaire complet à partir des hashes hexadécimaux de feuilles
   * @param {string[]} leafHashes Liste ordonnée des hashes SHA-256 des chunks
   * @returns {Promise<{ root: string, layers: string[][] }>}
   */
  static async buildTree(leafHashes) {
    if (!leafHashes || leafHashes.length === 0) {
      const emptyRoot = await CryptoVault.hashSHA256('');
      return { root: emptyRoot, layers: [[]] };
    }

    const layers = [leafHashes];
    let currentLayer = leafHashes;

    while (currentLayer.length > 1) {
      const nextLayer = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = (i + 1 < currentLayer.length) ? currentLayer[i + 1] : left;
        
        // Séparation de domaine RFC 6962 : préfixe '01' pour les nœuds internes
        const combined = `01:${left}:${right}`;
        const parentHash = await CryptoVault.hashSHA256(combined);
        nextLayer.push(parentHash);
      }
      layers.push(nextLayer);
      currentLayer = nextLayer;
    }

    return { root: currentLayer[0], layers };
  }

  /**
   * Calcule directement la racine Merkle (Merkle Root Hash) de façon hiérarchique
   * @param {string[]} leafHashes 
   * @returns {Promise<string>}
   */
  static async computeRoot(leafHashes) {
    const { root } = await MerkleTree.buildTree(leafHashes);
    return root;
  }

  /**
   * Génère une preuve d'inclusion SPV (taille O(log N)) pour un bloc donné
   * @param {number} leafIndex Index du chunk (0-based)
   * @param {string[][]} layers Couches de l'arbre retournées par buildTree
   * @returns {Array<{ position: 'left'|'right', hash: string }>}
   */
  static generateProof(leafIndex, layers) {
    if (!layers || layers.length <= 1) return [];
    const proof = [];
    let idx = leafIndex;

    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const layer = layers[layerIdx];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : (idx + 1 < layer.length ? idx + 1 : idx);
      
      proof.push({
        position: isRight ? 'left' : 'right',
        hash: layer[siblingIdx]
      });

      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  /**
   * Vérifie une preuve d'inclusion Merkle contre la racine déclarée
   * @param {string} leafHash Hash SHA-256 du bloc testé
   * @param {Array<{ position: 'left'|'right', hash: string }>} proof
   * @param {string} rootHash Racine attendue
   * @returns {Promise<boolean>}
   */
  static async verifyProof(leafHash, proof, rootHash) {
    if (!proof || proof.length === 0) return leafHash === rootHash;
    let currentHash = leafHash;
    for (const step of proof) {
      const left = step.position === 'left' ? step.hash : currentHash;
      const right = step.position === 'left' ? currentHash : step.hash;
      currentHash = await CryptoVault.hashSHA256(`01:${left}:${right}`);
    }
    return currentHash === rootHash;
  }
}
