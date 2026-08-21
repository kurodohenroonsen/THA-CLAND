import { logger } from '../../core/logger.js';
/**
 * Moteur de Versioning Git-like, Arborescence Hiérarchique & Merkle DAG
 * Gestion des dossiers/sous-dossiers, commits immuables, dédoublonnage de blocs et historique.
 */

import { CryptoVault } from '../../core/crypto-vault.js';
import { dbManager } from '../../core/local-storage.js';

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
   * Supprime un dossier de l'arborescence
   */
  static async deleteFolder(folderPath) {
    const normPath = VersioningDAG.normalizePath(folderPath);
    await dbManager.deleteDriveFolder(normPath);
    return true;
  }

  /**
   * Récupère tous les dossiers immédiats situés dans un dossier parent
   */
  static async getSubFolders(parentPath = '/') {
    const normParent = VersioningDAG.normalizePath(parentPath);
    const explicitFolders = await dbManager.getAllDriveFolders();
    const allCommits = await dbManager.getAllFileCommits();

    const folderMap = new Map(); // folderPath -> folderObj

    // 1. Dossiers explicites créés
    for (const f of explicitFolders) {
      const fNormParent = VersioningDAG.normalizePath(f.parentPath);
      if (fNormParent === normParent) {
        folderMap.set(f.path, f);
      }
    }

    // 2. Dossiers implicites déduits des chemins de fichiers
    for (const c of allCommits) {
      const fPath = VersioningDAG.normalizePath(c.folderPath || '/');
      if (fPath.startsWith(normParent) && fPath !== normParent) {
        const relative = fPath.substring(normParent.length);
        const subName = relative.split('/')[0];
        if (subName) {
          const directSubPath = `${normParent}${subName}/`;
          if (!folderMap.has(directSubPath)) {
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
   * Crée un nouveau commit pour un fichier
   */
  static async createCommit({
    fileId,
    fileName,
    folderPath = '/',
    fileSize,
    mimeType,
    authorName,
    commitMessage = 'Mise à jour du document',
    rootMerkleHash,
    chunks
  }) {
    const normalizedFolder = VersioningDAG.normalizePath(folderPath);

    // Récupère l'historique existant pour déterminer le parent et le numéro de version
    const existingCommits = await dbManager.getCommitsByFileId(fileId);
    const parentCommit = existingCommits.length > 0 ? existingCommits[0] : null;
    const versionNumber = parentCommit ? parentCommit.versionNumber + 1 : 1;
    const parentCommitId = parentCommit ? parentCommit.commitId : null;
    const timestamp = Date.now();

    // Calcul de l'identifiant unique du commit (SHA-256 du contenu et des métadonnées)
    const commitRawData = `${fileId}:${normalizedFolder}:${versionNumber}:${parentCommitId}:${rootMerkleHash}:${timestamp}`;
    const commitHash = await CryptoVault.hashSHA256(commitRawData);
    const commitId = `commit_${commitHash.substring(0, 16)}`;

    const commitObj = {
      commitId,
      fileId,
      fileName,
      folderPath: normalizedFolder,
      fileSize,
      mimeType,
      parentCommitId,
      versionNumber,
      authorName,
      commitMessage,
      timestamp,
      rootMerkleHash,
      chunks
    };

    await dbManager.saveFileCommit(commitObj);
    return commitObj;
  }

  /**
   * Récupère la liste des fichiers uniques avec leur dernière version active dans un dossier donné
   */
  static async getLatestFiles(folderPath = null) {
    const allCommits = await dbManager.getAllFileCommits();
    const deleted = await dbManager.getDeletedFileIds();
    const filesMap = new Map(); // fileId -> latestCommit

    for (const commit of allCommits) {
      if (deleted.has(commit.fileId)) continue; // fichier supprimé (tombstone)
      const current = filesMap.get(commit.fileId);
      if (!current || commit.versionNumber > current.versionNumber) {
        filesMap.set(commit.fileId, commit);
      }
    }

    let filesList = Array.from(filesMap.values());

    if (folderPath !== null) {
      const normTarget = VersioningDAG.normalizePath(folderPath);
      filesList = filesList.filter(f => VersioningDAG.normalizePath(f.folderPath || '/') === normTarget);
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
   * Crée un commit de restauration (Revert) pointant vers les chunks d'une version passée
   */
  static async revertToVersion(targetCommit, authorName) {
    return await VersioningDAG.createCommit({
      fileId: targetCommit.fileId,
      fileName: targetCommit.fileName,
      folderPath: targetCommit.folderPath || '/',
      fileSize: targetCommit.fileSize,
      mimeType: targetCommit.mimeType,
      authorName,
      commitMessage: `Restauration vers la version ${targetCommit.versionNumber}`,
      rootMerkleHash: targetCommit.rootMerkleHash,
      chunks: targetCommit.chunks
    });
  }
}
