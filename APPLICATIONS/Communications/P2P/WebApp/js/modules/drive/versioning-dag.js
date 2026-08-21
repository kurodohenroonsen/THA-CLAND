/**
 * VersioningDAG.js (Pass 4 - Version 2026 Git-like Merkle DAG & LCA Reconciliation)
 * Gestion d'arborescence immuable, commits 256-bit signés, dédoublonnage de blocs,
 * réconciliation 3-Way LCA et métriques différentielles inter-versions.
 */

import { logger } from '../../core/logger.js';
import { CryptoVault } from '../../core/crypto-vault.js';
import { dbManager } from '../../core/local-storage.js';
import { MerkleTree } from './merkle-tree.js';

export class VersioningDAG {
  /**
   * Normalise un chemin de dossier (ex: '/Documents/Projets/')
   */
  static normalizePath(path) {
    if (!path || path === '' || path === '/') return '/';
    let clean = path.trim().replace(/\/+/g, '/');
    if (!clean.startsWith('/')) clean = '/' + clean;
    if (!clean.endsWith('/')) clean = clean + '/';
    return clean;
  }

  /**
   * Crée un nouveau dossier dans l'arborescence
   */
  static async createFolder(parentPath, folderName, authorName) {
    const normParent = VersioningDAG.normalizePath(parentPath);
    const cleanName = folderName.trim().replace(/[\/\\:*?"<>|]/g, '_');
    const folderPath = `${normParent}${cleanName}/`;

    const folderObj = {
      path: folderPath,
      name: cleanName,
      parentPath: normParent,
      authorName,
      createdAt: Date.now()
    };

    await dbManager.saveDriveFolder(folderObj);
    return folderObj;
  }

  /**
   * Supprime un dossier de l'arborescence avec enregistrement de tombstone
   */
  static async deleteFolder(folderPath, authorId = null, signature = null) {
    const normPath = VersioningDAG.normalizePath(folderPath);
    await dbManager.saveFolderDeletion({
      path: normPath,
      deletedBy: authorId,
      deletedAt: Date.now(),
      signature
    });
    await dbManager.deleteDriveFolder(normPath);
    return true;
  }

  /**
   * Récupère tous les dossiers immédiats situés dans un dossier parent
   */
  static async getSubFolders(parentPath = '/') {
    const normParent = VersioningDAG.normalizePath(parentPath);
    const explicitFolders = await dbManager.getAllDriveFolders();
    const deletedFolders = await dbManager.getDeletedFolderPaths();
    const allCommits = await dbManager.getAllFileCommits();
    const deletedFileIds = await dbManager.getDeletedFileIds();

    const folderMap = new Map();

    // 1. Dossiers explicites créés
    for (const f of explicitFolders) {
      if (deletedFolders.has(f.path)) continue;
      const fNormParent = VersioningDAG.normalizePath(f.parentPath);
      if (fNormParent === normParent) {
        folderMap.set(f.path, f);
      }
    }

    // 2. Dossiers implicites déduits des chemins de fichiers actifs
    for (const c of allCommits) {
      if (deletedFileIds.has(c.fileId)) continue;
      const fPath = VersioningDAG.normalizePath(c.folderPath || '/');
      if (fPath.startsWith(normParent) && fPath !== normParent) {
        const relative = fPath.substring(normParent.length);
        const subName = relative.split('/')[0];
        if (subName) {
          const directSubPath = `${normParent}${subName}/`;
          if (!deletedFolders.has(directSubPath) && !folderMap.has(directSubPath)) {
            folderMap.set(directSubPath, {
              path: directSubPath,
              name: subName,
              parentPath: normParent,
              authorName: c.authorName || 'Membre',
              createdAt: c.timestamp
            });
          }
        }
      }
    }

    return Array.from(folderMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Résout les têtes de DAG et identifie les forks concurrents pour un fichier
   */
  static resolveDAGHeads(commits) {
    if (!commits || commits.length === 0) {
      return { primaryHead: null, allHeads: [], isFork: false };
    }

    const referencedAsParent = new Set();
    for (const c of commits) {
      const parents = Array.isArray(c.parents) ? c.parents : (c.parentCommitId ? [c.parentCommitId] : []);
      parents.forEach(p => referencedAsParent.add(p));
    }

    const heads = commits.filter(c => !referencedAsParent.has(c.commitId));

    // Tri déterministe (LWW avec horloge logique de Lamport et tie-breaker cryptographique)
    heads.sort((a, b) => {
      if ((b.versionNumber || 0) !== (a.versionNumber || 0)) return (b.versionNumber || 0) - (a.versionNumber || 0);
      if ((b.lamportClock || 0) !== (a.lamportClock || 0)) return (b.lamportClock || 0) - (a.lamportClock || 0);
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      return (b.commitId || '').localeCompare(a.commitId || '');
    });

    return {
      primaryHead: heads[0] || null,
      allHeads: heads,
      isFork: heads.length > 1
    };
  }

  /**
   * Trouve le plus proche ancêtre commun (Lowest Common Ancestor - LCA) entre deux têtes de DAG
   */
  static findLowestCommonAncestor(headCommitIdA, headCommitIdB, commitMap) {
    if (headCommitIdA === headCommitIdB) return commitMap.get(headCommitIdA) || null;

    const ancestorsA = new Set();
    const queueA = [headCommitIdA];

    while (queueA.length > 0) {
      const currId = queueA.shift();
      if (!currId || ancestorsA.has(currId)) continue;
      ancestorsA.add(currId);
      const commit = commitMap.get(currId);
      if (commit && Array.isArray(commit.parents)) {
        for (const p of commit.parents) queueA.push(p);
      }
    }

    const queueB = [headCommitIdB];
    const visitedB = new Set();

    while (queueB.length > 0) {
      const currId = queueB.shift();
      if (!currId || visitedB.has(currId)) continue;
      visitedB.add(currId);

      if (ancestorsA.has(currId)) {
        return commitMap.get(currId) || null;
      }

      const commit = commitMap.get(currId);
      if (commit && Array.isArray(commit.parents)) {
        for (const p of commit.parents) queueB.push(p);
      }
    }

    return null;
  }

  /**
   * Calcule le ratio de dédoublonnage de blocs entre une nouvelle version et ses parents
   */
  static computeDeduplicationStats(newChunks, parentChunks) {
    if (!parentChunks || parentChunks.length === 0) {
      return { reusedChunks: 0, newChunks: newChunks.length, dedupRatio: 0 };
    }

    const parentHashes = new Set(parentChunks.map(c => c.hash));
    let reused = 0;

    for (const chunk of newChunks) {
      if (parentHashes.has(chunk.hash)) {
        reused++;
      }
    }

    const ratio = newChunks.length > 0 ? Math.round((reused / newChunks.length) * 100) : 0;
    return {
      reusedChunks: reused,
      newChunks: newChunks.length - reused,
      dedupRatio: ratio
    };
  }

  /**
   * Crée un nouveau commit immuable signé et inséré dans le DAG
   */
  static async createCommit({
    fileId,
    fileName,
    folderPath = '/',
    fileSize,
    mimeType,
    authorName,
    authorPubkey = null,
    authorId = null,
    parentCommitIds = null,
    commitMessage = 'Mise à jour du document',
    rootMerkleHash = null,
    chunks = [],
    lamportClock = 0
  }) {
    const normalizedFolder = VersioningDAG.normalizePath(folderPath);

    let parents = parentCommitIds;
    let versionNumber = 1;
    let dedupStats = { reusedChunks: 0, newChunks: chunks.length, dedupRatio: 0 };

    const existingCommits = await dbManager.getCommitsByFileId(fileId);

    if (!parents) {
      const headsInfo = VersioningDAG.resolveDAGHeads(existingCommits);
      if (headsInfo.primaryHead) {
        parents = headsInfo.allHeads.map(h => h.commitId);
        versionNumber = headsInfo.primaryHead.versionNumber + 1;
        dedupStats = VersioningDAG.computeDeduplicationStats(chunks, headsInfo.primaryHead.chunks);
      } else {
        parents = [];
        versionNumber = 1;
      }
    } else {
      const primaryParent = existingCommits.find(c => c.commitId === (Array.isArray(parents) ? parents[0] : parents));
      if (primaryParent) {
        versionNumber = (primaryParent.versionNumber || 1) + 1;
        dedupStats = VersioningDAG.computeDeduplicationStats(chunks, primaryParent.chunks);
      }
    }

    // Calcul automatique de la racine Merkle si omise
    let merkleRoot = rootMerkleHash;
    if (!merkleRoot && Array.isArray(chunks) && chunks.length > 0) {
      merkleRoot = await MerkleTree.computeRoot(chunks.map(c => c.hash));
    }

    const timestamp = Date.now();

    const commitPayload = {
      fileId,
      fileName,
      folderPath: normalizedFolder,
      fileSize,
      mimeType,
      parents: Array.isArray(parents) ? parents : (parents ? [parents] : []),
      parentCommitId: (Array.isArray(parents) && parents.length > 0) ? parents[0] : (parents || null),
      versionNumber,
      authorName,
      authorId,
      authorPubkey,
      commitMessage,
      timestamp,
      lamportClock,
      rootMerkleHash: merkleRoot,
      dedupStats,
      chunks: (chunks || []).map(c => ({ index: c.index, hash: c.hash, size: c.size }))
    };

    // Identifiant de commit canonique 256-bit SHA-256
    const canonicalStr = CryptoVault.canonicalize(commitPayload, ['signature']);
    const fullHash = await CryptoVault.hashSHA256(canonicalStr);
    commitPayload.commitId = `cmt_${fullHash}`;

    await dbManager.saveFileCommit(commitPayload);
    return commitPayload;
  }

  /**
   * Récupère la liste des fichiers uniques avec leur dernière version active
   */
  static async getLatestFiles(folderPath = null) {
    const allCommits = await dbManager.getAllFileCommits();
    const deleted = await dbManager.getDeletedFileIds();
    const commitsByFile = new Map();

    for (const commit of allCommits) {
      if (deleted.has(commit.fileId)) continue;
      if (!commitsByFile.has(commit.fileId)) {
        commitsByFile.set(commit.fileId, []);
      }
      commitsByFile.get(commit.fileId).push(commit);
    }

    const filesList = [];
    for (const [, commits] of commitsByFile.entries()) {
      const { primaryHead, allHeads, isFork } = VersioningDAG.resolveDAGHeads(commits);
      if (primaryHead) {
        filesList.push({
          ...primaryHead,
          isFork,
          forkCount: allHeads.length,
          competingHeads: allHeads
        });
      }
    }

    if (folderPath !== null) {
      const normTarget = VersioningDAG.normalizePath(folderPath);
      return filesList.filter(f => VersioningDAG.normalizePath(f.folderPath || '/') === normTarget);
    }

    return filesList.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Récupère l'historique complet des versions pour un fichier
   */
  static async getFileHistory(fileId) {
    const commits = await dbManager.getCommitsByFileId(fileId);
    return commits.sort((a, b) => b.versionNumber - a.versionNumber);
  }

  /**
   * Crée un commit de restauration (Revert)
   */
  static async revertToVersion(targetCommit, authorName, authorPubkey = null, authorId = null) {
    for (const chunk of (targetCommit.chunks || [])) {
      const has = await dbManager.hasChunk(chunk.hash);
      if (!has) {
        throw new Error(`Bloc introuvable pour la restauration (${chunk.hash.substring(0, 10)}...). Téléchargement swarm requis.`);
      }
    }

    return await VersioningDAG.createCommit({
      fileId: targetCommit.fileId,
      fileName: targetCommit.fileName,
      folderPath: targetCommit.folderPath || '/',
      fileSize: targetCommit.fileSize,
      mimeType: targetCommit.mimeType,
      authorName,
      authorPubkey,
      authorId,
      commitMessage: `Restauration vers la version ${targetCommit.versionNumber} (${targetCommit.commitId.substring(0, 12)})`,
      rootMerkleHash: targetCommit.rootMerkleHash,
      chunks: targetCommit.chunks
    });
  }
}
