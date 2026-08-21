/**
 * modules/drive/vfs-engine.js
 * Moteur VFS Réactif en Mémoire O(1) avec Indexation Multidirectionnelle (Pass 4)
 */

import { VersioningDAG } from './versioning-dag.js';
import { dbManager } from '../../core/local-storage.js';

export class VFSVirtualTreeEngine {
  constructor() {
    this.root = { path: '/', name: 'Racine', folders: new Map(), files: new Map() };
    this.fileIndex = new Map(); // fileId -> FileNode
    this.isLoaded = false;
  }

  /**
   * Reconstruit la projection VFS complète en mémoire à partir du DAG et de la DB
   */
  async rebuildTree() {
    const [allFolders, allCommits, deletedFiles, deletedFolders] = await Promise.all([
      dbManager.getAllDriveFolders ? dbManager.getAllDriveFolders() : Promise.resolve([]),
      dbManager.getAllFileCommits ? dbManager.getAllFileCommits() : Promise.resolve([]),
      dbManager.getDeletedFileIds ? dbManager.getDeletedFileIds() : Promise.resolve(new Set()),
      dbManager.getDeletedFolderPaths ? dbManager.getDeletedFolderPaths() : Promise.resolve(new Set())
    ]);

    this.root = { path: '/', name: 'Racine', folders: new Map(), files: new Map() };
    this.fileIndex.clear();

    // 1. Projection des dossiers explicites
    for (const folder of allFolders || []) {
      if (deletedFolders && deletedFolders.has(folder.path)) continue;
      this._ensurePathNodes(folder.path, folder);
    }

    // 2. Projection des fichiers (Dernières têtes de DAG)
    const commitsByFile = new Map();
    for (const c of allCommits || []) {
      if (deletedFiles && deletedFiles.has(c.fileId)) continue;
      if (!commitsByFile.has(c.fileId)) commitsByFile.set(c.fileId, []);
      commitsByFile.get(c.fileId).push(c);
    }

    for (const [fileId, commits] of commitsByFile.entries()) {
      const { primaryHead } = VersioningDAG.resolveDAGHeads(commits);
      if (!primaryHead) continue;

      const folderPath = VersioningDAG.normalizePath(primaryHead.folderPath || '/');
      const folderNode = this._ensurePathNodes(folderPath);

      const fileEntry = {
        fileId: primaryHead.fileId,
        fileName: primaryHead.fileName,
        fileSize: primaryHead.fileSize,
        mimeType: primaryHead.mimeType,
        versionNumber: primaryHead.versionNumber,
        authorName: primaryHead.authorName,
        timestamp: primaryHead.timestamp,
        commitMessage: primaryHead.commitMessage,
        rootMerkleHash: primaryHead.rootMerkleHash,
        thumbnail: primaryHead.thumbnail || null,
        chunks: primaryHead.chunks,
        commit: primaryHead
      };

      folderNode.files.set(fileEntry.fileName, fileEntry);
      this.fileIndex.set(fileId, fileEntry);
    }

    this.isLoaded = true;
    return this.root;
  }

  _ensurePathNodes(path, folderData = null) {
    const normalized = VersioningDAG.normalizePath(path);
    if (normalized === '/') return this.root;

    const parts = normalized.split('/').filter(p => p.length > 0);
    let curr = this.root;
    let accumulated = '/';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulated += `${part}/`;

      if (!curr.folders.has(part)) {
        curr.folders.set(part, {
          path: accumulated,
          name: part,
          authorName: folderData?.authorName || 'Membre',
          folders: new Map(),
          files: new Map()
        });
      }
      curr = curr.folders.get(part);
    }
    return curr;
  }

  getNode(path = '/') {
    const normalized = VersioningDAG.normalizePath(path);
    if (normalized === '/') return this.root;

    const parts = normalized.split('/').filter(p => p.length > 0);
    let curr = this.root;
    for (const part of parts) {
      if (!curr.folders.has(part)) return null;
      curr = curr.folders.get(part);
    }
    return curr;
  }

  /**
   * Recherche instantanée et filtrage insensible à la casse
   */
  search(query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return [];
    const results = [];
    for (const file of this.fileIndex.values()) {
      if (file.fileName.toLowerCase().includes(q) || (file.authorName || '').toLowerCase().includes(q)) {
        results.push(file);
      }
    }
    return results;
  }
}
