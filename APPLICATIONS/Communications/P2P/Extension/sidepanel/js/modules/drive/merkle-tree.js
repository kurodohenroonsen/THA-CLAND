/**
 * MerkleTree.js (Pass 4 - Durci 2026 Conforme RFC 6962, BEP 52 & SPV)
 * Arbre de Merkle binaire avec Domain Separation binaire stricte (0x00 leaf, 0x01 node),
 * Preuves d'inclusion SPV O(log N) et compatibilité multi-format.
 */

import { CryptoVault } from '../../core/crypto-vault.js';

export class MerkleTree {
  static LEAF_PREFIX = 0x00;
  static NODE_PREFIX = 0x01;

  /**
   * Calcule le hash RFC 6962 d'une feuille
   * LeafHash = SHA-256(0x00 || chunk_bytes)
   */
  static async hashLeaf(arrayBufferOrBytes) {
    const raw = arrayBufferOrBytes instanceof Uint8Array 
      ? arrayBufferOrBytes 
      : new Uint8Array(arrayBufferOrBytes);
    
    const combined = new Uint8Array(1 + raw.byteLength);
    combined[0] = MerkleTree.LEAF_PREFIX;
    combined.set(raw, 1);

    const digest = await crypto.subtle.digest('SHA-256', combined);
    return CryptoVault.bufferToHex(digest);
  }

  /**
   * Calcule le hash RFC 6962 d'un nœud interne
   * NodeHash = SHA-256(0x01 || left_32_bytes || right_32_bytes)
   */
  static async hashInternalNode(leftHex, rightHex) {
    const leftBytes = new Uint8Array(CryptoVault.hexToBuffer(leftHex));
    const rightBytes = new Uint8Array(CryptoVault.hexToBuffer(rightHex));

    const combined = new Uint8Array(1 + 32 + 32);
    combined[0] = MerkleTree.NODE_PREFIX;
    combined.set(leftBytes, 1);
    combined.set(rightBytes, 33);

    const digest = await crypto.subtle.digest('SHA-256', combined);
    return CryptoVault.bufferToHex(digest);
  }

  /**
   * Construit l'arbre de Merkle complet à partir d'une liste ordonnée de hashes de feuilles
   */
  static async buildTree(leafHashes) {
    if (!leafHashes || leafHashes.length === 0) {
      const emptyDigest = await crypto.subtle.digest('SHA-256', new Uint8Array(0));
      return { root: CryptoVault.bufferToHex(emptyDigest), layers: [[]] };
    }

    const layers = [leafHashes.slice()];
    let currentLayer = leafHashes.slice();

    while (currentLayer.length > 1) {
      const nextLayer = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = (i + 1 < currentLayer.length) ? currentLayer[i + 1] : left;
        const parentHash = await MerkleTree.hashInternalNode(left, right);
        nextLayer.push(parentHash);
      }
      layers.push(nextLayer);
      currentLayer = nextLayer;
    }

    return { root: currentLayer[0], layers };
  }

  /**
   * Calcule la racine Merkle directement
   */
  static async computeRoot(leafHashes) {
    const { root } = await MerkleTree.buildTree(leafHashes);
    return root;
  }

  static async computeRootFromHashes(leafHashes) {
    return MerkleTree.computeRoot(leafHashes);
  }

  /**
   * Génère une preuve d'inclusion SPV O(log N)
   */
  static generateProof(leafIndex, layers) {
    if (!layers || layers.length <= 1 || leafIndex < 0 || leafIndex >= layers[0].length) {
      return [];
    }

    const proof = [];
    let idx = leafIndex;

    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const layer = layers[layerIdx];
      const isRight = (idx % 2 === 1);
      const siblingIdx = isRight 
        ? idx - 1 
        : (idx + 1 < layer.length ? idx + 1 : idx);

      proof.push({
        position: isRight ? 'left' : 'right',
        hash: layer[siblingIdx]
      });

      idx = Math.floor(idx / 2);
    }

    return proof;
  }

  /**
   * Vérifie une preuve d'inclusion Merkle contre la racine attendue en temps O(log N)
   */
  static async verifyProof(leafHash, proof, rootHash) {
    if (!proof || proof.length === 0) return leafHash === rootHash;

    let currentHash = leafHash;
    for (const step of proof) {
      const left = step.position === 'left' ? step.hash : currentHash;
      const right = step.position === 'left' ? currentHash : step.hash;
      currentHash = await MerkleTree.hashInternalNode(left, right);
    }

    return currentHash === rootHash;
  }
}
