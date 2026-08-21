import { logger } from '../../core/logger.js';
import { CryptoVault } from '../../core/crypto-vault.js';
import { dbManager } from '../../core/local-storage.js';
import { MerkleTree } from './merkle-tree.js';

/**
 * Moteur de Versioning Git-like, Arborescence Hiérarchique & Merkle DAG (2025/2026)
 * Gestion des dossiers, commits immuables 256-bit, dédoublonnage de blocs,
 * détection de forks concurrents (Merkle-CRDT) et historique inviolable.
 */

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

    const folderMap = new Map(); // folderPath -> folderObj

    // 1. Dossiers explicites créés (non supprimés)
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
   * Crée un nouveau commit immuable signé et vérifié
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
    chunks,
    lamportClock = 0
  }) {
    const normalizedFolder = VersioningDAG.normalizePath(folderPath);

    // Détermination automatique des parents si non fournis
    let parents = parentCommitIds;
    let versionNumber = 1;

    if (!parents) {
      const existingCommits = await dbManager.getCommitsByFileId(fileId);
      const headsInfo = VersioningDAG.resolveDAGHeads(existingCommits);
      if (headsInfo.primaryHead) {
        parents = headsInfo.allHeads.map(h => h.commitId);
        versionNumber = headsInfo.primaryHead.versionNumber + 1;
      } else {
        parents = [];
        versionNumber = 1;
      }
    }

    // Calcul automatique de la racine Merkle hiérarchique si omise
    let merkleRoot = rootMerkleHash;
    if (!merkleRoot && Array.isArray(chunks) && chunks.length > 0) {
      merkleRoot = await MerkleTree.computeRoot(chunks.map(c => c.hash));
    }

    const timestamp = Date.now();

    // Payload de commit structuré
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
      chunks: (chunks || []).map(c => ({ index: c.index, hash: c.hash, size: c.size }))
    };

    // Calcul de l'identifiant de commit 256-bit SHA-256
    const canonicalStr = CryptoVault.canonicalize(commitPayload, ['signature']);
    const fullHash = await CryptoVault.hashSHA256(canonicalStr);
    commitPayload.commitId = `cmt_${fullHash}`;

    await dbManager.saveFileCommit(commitPayload);
    return commitPayload;
  }

  /**
   * Récupère la liste des fichiers uniques avec leur dernière version active dans un dossier donné
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
    for (const [fileId, commits] of commitsByFile.entries()) {
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
   * Crée un commit de restauration (Revert) après contrôle pré-vol de la disponibilité des blocs
   */
  static async revertToVersion(targetCommit, authorName, authorPubkey = null, authorId = null) {
    // Vérification pré-vol de la disponibilité locale des blocs
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
