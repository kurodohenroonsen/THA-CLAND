import { logger } from './logger.js';
import { CryptoVault } from './crypto-vault.js';

/**
 * Gestionnaire de Stockage Local Asynchrone Haute Performance (IndexedDB v4 + OPFS)
 * Optimisé pour le maillage P2P : Requêtes par curseurs paginés, Index composites,
 * Transactions atomiques par lot, Web Locks, Ramasse-Miettes (GC) et persistance garantie.
 */

const DB_NAME = 'P2PMeshWorkspaceDB';
const DB_VERSION = 4; // Montée en v4 pour les index composites et correctifs de schéma

export class LocalStorageManager {
  constructor() {
    this.db = null;
    this.opfsRoot = null;
    this._initPromise = null;
  }

  /**
   * Initialise la base de données IndexedDB et le dossier racine OPFS
   */
  async init() {
    if (this._initPromise) return this._initPromise;

    this._initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      // Gestion du blocage par d'autres onglets / contextes
      request.onblocked = () => {
        logger.warn('Storage', 'Ouverture IndexedDB bloquée par une autre connexion active. Veuillez fermer les autres onglets.');
      };

      // Gestion des migrations de schéma incrémentales sans perte de données
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;
        const transaction = event.target.transaction;

        logger.info('Storage', `Migration du schéma IndexedDB : v${oldVersion} -> v${DB_VERSION}`);

        // --- V1 : Magasins de base ---
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains('messages')) {
            const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
            msgStore.createIndex('channelId', 'channelId', { unique: false });
            msgStore.createIndex('timestamp', 'timestamp', { unique: false });
          }

          if (!db.objectStoreNames.contains('forum_threads')) {
            const forumStore = db.createObjectStore('forum_threads', { keyPath: 'id' });
            forumStore.createIndex('category', 'category', { unique: false });
            forumStore.createIndex('createdAt', 'createdAt', { unique: false });
          }

          if (!db.objectStoreNames.contains('file_commits')) {
            const commitStore = db.createObjectStore('file_commits', { keyPath: 'commitId' });
            commitStore.createIndex('fileId', 'fileId', { unique: false });
            commitStore.createIndex('folderPath', 'folderPath', { unique: false });
            commitStore.createIndex('parentCommitId', 'parentCommitId', { unique: false });
            commitStore.createIndex('timestamp', 'timestamp', { unique: false });
          }

          if (!db.objectStoreNames.contains('file_chunks')) {
            db.createObjectStore('file_chunks', { keyPath: 'hash' });
          }

          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
        }

        // --- V2 : Dossiers & Tombstones Drive ---
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains('drive_folders')) {
            const folderStore = db.createObjectStore('drive_folders', { keyPath: 'path' });
            folderStore.createIndex('parentPath', 'parentPath', { unique: false });
            folderStore.createIndex('createdAt', 'createdAt', { unique: false });
          }

          if (!db.objectStoreNames.contains('drive_deletions')) {
            db.createObjectStore('drive_deletions', { keyPath: 'fileId' });
          }
        }

        // --- V4 : Index composites, correction lamport et tombstones dossiers ---
        if (oldVersion < 4) {
          // Mise à jour de 'messages'
          if (db.objectStoreNames.contains('messages')) {
            const msgStore = transaction.objectStore('messages');
            if (msgStore.indexNames.contains('lamportTime')) {
              msgStore.deleteIndex('lamportTime');
            }
            if (!msgStore.indexNames.contains('lamport')) {
              msgStore.createIndex('lamport', 'lamport', { unique: false });
            }
            // Index composite clé pour chat paginé : [channelId + timestamp]
            if (!msgStore.indexNames.contains('channelId_timestamp')) {
              msgStore.createIndex('channelId_timestamp', ['channelId', 'timestamp'], { unique: false });
            }
          }

          // Mise à jour de 'file_commits'
          if (db.objectStoreNames.contains('file_commits')) {
            const commitStore = transaction.objectStore('file_commits');
            if (!commitStore.indexNames.contains('fileId_version')) {
              commitStore.createIndex('fileId_version', ['fileId', 'versionNumber'], { unique: false });
            }
            if (!commitStore.indexNames.contains('folderPath_timestamp')) {
              commitStore.createIndex('folderPath_timestamp', ['folderPath', 'timestamp'], { unique: false });
            }
          }

          // Mise à jour de 'forum_threads'
          if (db.objectStoreNames.contains('forum_threads')) {
            const forumStore = transaction.objectStore('forum_threads');
            if (!forumStore.indexNames.contains('category_createdAt')) {
              forumStore.createIndex('category_createdAt', ['category', 'createdAt'], { unique: false });
            }
          }

          // Nouveau store : 'drive_folder_deletions' pour éviter la résurrection de dossiers supprimés
          if (!db.objectStoreNames.contains('drive_folder_deletions')) {
            const folderDelStore = db.createObjectStore('drive_folder_deletions', { keyPath: 'path' });
            folderDelStore.createIndex('deletedAt', 'deletedAt', { unique: false });
          }

          // Mise à jour de 'file_chunks' pour GC LRU
          if (db.objectStoreNames.contains('file_chunks')) {
            const chunkStore = transaction.objectStore('file_chunks');
            if (!chunkStore.indexNames.contains('timestamp')) {
              chunkStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
          }
        }
      };

      request.onsuccess = async (event) => {
        this.db = event.target.result;

        // Prévention des blocages lors des mises à jour concurrentes
        this.db.onversionchange = () => {
          logger.warn('Storage', 'Versionchange détecté dans un autre contexte : fermeture de la connexion.');
          this.db.close();
          this.db = null;
          this._initPromise = null;
        };

        this.db.onclose = () => {
          logger.warn('Storage', 'Connexion IndexedDB fermée inopinément.');
          this.db = null;
          this._initPromise = null;
        };

        // Initialisation OPFS
        if (navigator.storage && navigator.storage.getDirectory) {
          try {
            this.opfsRoot = await navigator.storage.getDirectory();
            logger.info('Storage', 'OPFS (Origin Private File System) actif.');
          } catch (e) {
            logger.warn('Storage', 'OPFS indisponible, fallback IndexedDB:', e);
          }
        }

        // Demande de persistance du stockage
        try {
          if (navigator.storage && navigator.storage.persist) {
            const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
            const granted = already || await navigator.storage.persist();
            logger.info('Storage', `Stockage persistant : ${granted ? 'accordé' : 'best-effort'}`);
          }
        } catch (e) {
          logger.warn('Storage', 'Échec demande persistance:', e);
        }

        // Balayage automatique des résidus temporaires au démarrage (Crash Recovery)
        await this.sweepStaleTempFiles();

        logger.info('Storage', 'IndexedDB v4 initialisée avec succès.');
        resolve(this);
      };

      request.onerror = (event) => {
        logger.error('Storage', 'Erreur ouverture IndexedDB:', event.target.error);
        this._initPromise = null;
        reject(event.target.error);
      };
    });

    return this._initPromise;
  }

  // --- Primitives Génériques Optimisées ---

  async _ensureDb() {
    if (!this.db) {
      await this.init();
    }
  }

  async save(storeName, item) {
    await this._ensureDb();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(item);
      request.onsuccess = () => resolve(item);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Écriture en lot atomique (Batch) pour synchronisation CRDT
   */
  async saveBatch(storeName, items) {
    if (!items || items.length === 0) return [];
    await this._ensureDb();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      transaction.oncomplete = () => resolve(items);
      transaction.onerror = (e) => reject(e.target.error || transaction.error);
      transaction.onabort = (e) => reject(e.target.error || transaction.error || new Error('Transaction annulée'));

      for (let i = 0; i < items.length; i++) {
        store.put(items[i]);
      }
    });
  }

  async get(storeName, key) {
    await this._ensureDb();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async getAll(storeName) {
    await this._ensureDb();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async getAllKeys(storeName) {
    await this._ensureDb();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async delete(storeName, key) {
    await this._ensureDb();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve(true);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Requête paginée par curseur générique (IDBCursorWithValue)
   */
  async queryCursor({
    storeName,
    indexName = null,
    range = null,
    direction = 'next',
    limit = 50,
    offset = 0
  } = {}) {
    await this._ensureDb();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const source = indexName ? store.index(indexName) : store;
      const request = source.openCursor(range, direction);

      const results = [];
      let skipped = 0;

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) {
          return resolve(results);
        }

        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }

        results.push(cursor.value);
        if (results.length >= limit) {
          return resolve(results);
        }

        cursor.continue();
      };

      request.onerror = (e) => reject(e.target.error);
    });
  }

  // --- Méthodes Métier Optimisées (Chat) ---

  async saveMessage(message) {
    return this.save('messages', message);
  }

  async saveMessagesBatch(messages) {
    return this.saveBatch('messages', messages);
  }

  /**
   * Récupère les messages d'un salon via l'index composite [channelId, timestamp].
   * Pagination par défaut : 50 messages récents.
   */
  async getMessagesByChannel(channelId, { limit = 50, beforeTimestamp = Infinity } = {}) {
    try {
      const range = IDBKeyRange.bound([channelId, 0], [channelId, beforeTimestamp]);
      const messages = await this.queryCursor({
        storeName: 'messages',
        indexName: 'channelId_timestamp',
        range,
        direction: 'prev',
        limit
      });
      return messages.reverse();
    } catch {
      // Fallback si index en cours de migration
      const all = await this.getAll('messages');
      return all
        .filter(m => m.channelId === channelId && (m.timestamp || 0) <= beforeTimestamp)
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .slice(-limit);
    }
  }

  // --- Méthodes Métier (Forum) ---

  async saveForumThread(thread) {
    return this.save('forum_threads', thread);
  }

  async getAllForumThreads({ limit = 50, offset = 0 } = {}) {
    return this.queryCursor({
      storeName: 'forum_threads',
      indexName: 'createdAt',
      direction: 'prev',
      limit,
      offset
    });
  }

  // --- Méthodes Métier (Drive & Commits DAG) ---

  async saveFileCommit(commit) {
    return this.save('file_commits', commit);
  }

  async saveFileCommitsBatch(commits) {
    return this.saveBatch('file_commits', commits);
  }

  async getAllFileCommits() {
    return this.getAll('file_commits');
  }

  async getCommitsByFileId(fileId, { limit = 50 } = {}) {
    try {
      const range = IDBKeyRange.bound([fileId, 0], [fileId, Infinity]);
      return await this.queryCursor({
        storeName: 'file_commits',
        indexName: 'fileId_version',
        range,
        direction: 'prev',
        limit
      });
    } catch {
      const all = await this.getAllFileCommits();
      return all
        .filter(c => c.fileId === fileId)
        .sort((a, b) => (b.versionNumber || 0) - (a.versionNumber || 0))
        .slice(0, limit);
    }
  }

  async getCommitsByFolder(folderPath, { limit = 100 } = {}) {
    try {
      const range = IDBKeyRange.bound([folderPath, 0], [folderPath, Infinity]);
      return await this.queryCursor({
        storeName: 'file_commits',
        indexName: 'folderPath_timestamp',
        range,
        direction: 'prev',
        limit
      });
    } catch {
      const all = await this.getAllFileCommits();
      return all
        .filter(c => (c.folderPath || '/') === folderPath)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, limit);
    }
  }

  // --- Méthodes Dossiers Drive & Tombstones ---

  async saveDriveFolder(folder) {
    return this.save('drive_folders', folder);
  }

  async getAllDriveFolders() {
    return this.getAll('drive_folders');
  }

  async deleteDriveFolder(path) {
    return this.delete('drive_folders', path);
  }

  async saveFolderDeletion(tombstone) {
    return this.save('drive_folder_deletions', tombstone);
  }

  async getDeletedFolderPaths() {
    const keys = await this.getAllKeys('drive_folder_deletions');
    return new Set(keys);
  }

  async saveFileDeletion(tombstone) {
    return this.save('drive_deletions', tombstone);
  }

  async saveFileDeletionsBatch(tombstones) {
    return this.saveBatch('drive_deletions', tombstones);
  }

  async getDeletedFileIds() {
    const keys = await this.getAllKeys('drive_deletions');
    return new Set(keys);
  }

  // --- Paramètres & Session ---

  async saveSetting(key, value) {
    return this.save('settings', { key, value });
  }

  async getSetting(key, defaultValue = null) {
    const item = await this.get('settings', key);
    return item !== undefined && item !== null ? item.value : defaultValue;
  }

  // --- Quotas & Estimation Stockage ---

  async isPersisted() {
    if (navigator.storage && navigator.storage.persisted) {
      try { return await navigator.storage.persisted(); } catch { return false; }
    }
    return false;
  }

  async requestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        const granted = await navigator.storage.persist();
        logger.info('Storage', `Demande persistance explicite: ${granted ? 'accordée' : 'refusée'}`);
        return granted;
      } catch (e) {
        logger.warn('Storage', 'Erreur demande persistance:', e);
        return false;
      }
    }
    return false;
  }

  async estimateStorage() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        const usage = est.usage || 0;
        const quota = est.quota || 0;
        return {
          usage,
          quota,
          available: Math.max(0, quota - usage),
          percent: quota > 0 ? Math.round((usage / quota) * 100) : 0,
          details: est.usageDetails || {}
        };
      } catch {}
    }
    return { usage: 0, quota: 0, available: Infinity, percent: 0, details: {} };
  }

  async ensureSpaceFor(bytes, mode = 'download') {
    const multiplier = mode === 'download' ? 2.1 : 1.15;
    const { available, quota } = await this.estimateStorage();
    if (available === Infinity) return true;
    const needed = Math.ceil(bytes * multiplier);
    if (needed > available) {
      const mb = (n) => `${(n / (1024 * 1024)).toFixed(0)} Mo`;
      throw new Error(`Espace insuffisant (${mode}) : ${mb(needed)} requis (avec marge de sécurité), ${mb(available)} disponibles (quota ${mb(quota)}).`);
    }
    return true;
  }

  // --- Nettoyage Automatique & Ramasse-Miettes (GC) ---

  async sweepStaleTempFiles(maxAgeMs = 5 * 60 * 1000) {
    if (!this.opfsRoot) return;
    try {
      const now = Date.now();
      let cleaned = 0;
      for await (const [name] of this.opfsRoot.entries()) {
        if (name.startsWith('assembled_')) {
          const parts = name.split('_');
          const fileTime = parseInt(parts[1], 10);
          if (isNaN(fileTime) || (now - fileTime > maxAgeMs)) {
            await this.opfsRoot.removeEntry(name);
            cleaned++;
          }
        }
      }
      if (cleaned > 0) {
        logger.info('Storage', `🧹 Nettoyage boot : ${cleaned} fichier(s) temporaire(s) OPFS résiduel(s) supprimé(s).`);
      }
    } catch (err) {
      logger.debug('Storage', 'Balayage fichiers temporaires OPFS:', err);
    }
  }

  async purgeOrphanChunks() {
    logger.info('Storage', '🧹 Démarrage du ramasse-miettes (GC) des chunks orphelins...');
    const activeCommits = await this.getAllFileCommits();
    const deletedIds = await this.getDeletedFileIds();
    const messages = await this.getAll('messages');

    const referencedHashes = new Set();
    for (const c of activeCommits) {
      if (!deletedIds.has(c.fileId) && Array.isArray(c.chunks)) {
        for (const ch of c.chunks) referencedHashes.add(ch.hash);
      }
    }
    for (const m of messages) {
      if (Array.isArray(m.attachments)) {
        for (const att of m.attachments) {
          if (Array.isArray(att.chunks)) {
            for (const ch of att.chunks) referencedHashes.add(ch.hash);
          }
        }
      }
    }

    let purgedCount = 0;
    let purgedBytes = 0;

    // Purge OPFS
    if (this.opfsRoot) {
      for await (const [name, handle] of this.opfsRoot.entries()) {
        if (name.startsWith('chunk_')) {
          const hash = name.replace('chunk_', '');
          if (!referencedHashes.has(hash)) {
            try {
              const f = await handle.getFile();
              purgedBytes += f.size;
              await this.opfsRoot.removeEntry(name);
              purgedCount++;
            } catch {}
          }
        }
      }
    }

    // Purge IndexedDB file_chunks
    const idbChunks = await this.getAll('file_chunks');
    for (const ch of idbChunks) {
      if (!referencedHashes.has(ch.hash)) {
        purgedBytes += ch.size || 0;
        await this.delete('file_chunks', ch.hash);
        purgedCount++;
      }
    }

    logger.info('Storage', `✅ Nettoyage terminé : ${purgedCount} blocs orphelins purgés (${(purgedBytes / (1024 * 1024)).toFixed(2)} Mo libérés).`);
    return { purgedCount, purgedBytes };
  }

  // --- Blocs Binaires (OPFS + IndexedDB Fallback avec Web Locks) ---

  async saveChunk(hash, arrayBuffer) {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(`opfs:chunk:${hash}`, async () => {
        if (await this.hasChunk(hash)) {
          return { hash, size: arrayBuffer.byteLength, inOPFS: true, skipped: true };
        }
        return this._saveChunkDirect(hash, arrayBuffer);
      });
    }
    return this._saveChunkDirect(hash, arrayBuffer);
  }

  async _saveChunkDirect(hash, arrayBuffer) {
    if (this.opfsRoot) {
      try {
        const fileHandle = await this.opfsRoot.getFileHandle(`chunk_${hash}`, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(arrayBuffer);
        await writable.close();
        return { hash, size: arrayBuffer.byteLength, inOPFS: true };
      } catch (err) {
        logger.warn('Storage', `Échec écriture OPFS pour chunk ${hash}, fallback IndexedDB:`, err);
      }
    }

    return this.save('file_chunks', {
      hash,
      data: arrayBuffer,
      size: arrayBuffer.byteLength,
      timestamp: Date.now()
    });
  }

  async getChunk(hash) {
    let buffer = null;

    if (this.opfsRoot) {
      try {
        const fileHandle = await this.opfsRoot.getFileHandle(`chunk_${hash}`);
        const file = await fileHandle.getFile();
        buffer = await file.arrayBuffer();
      } catch {}
    }

    if (!buffer) {
      const item = await this.get('file_chunks', hash);
      buffer = item ? item.data : null;
    }

    // Vérification de l'intégrité SHA-256 à la lecture
    if (buffer) {
      const computedHash = await CryptoVault.hashSHA256(buffer);
      if (computedHash !== hash) {
        logger.error('Storage', `Corruption de bloc détectée pour ${hash} (calculé: ${computedHash}) !`);
        return null;
      }
    }

    return buffer;
  }

  async hasChunk(hash) {
    if (this.opfsRoot) {
      try {
        await this.opfsRoot.getFileHandle(`chunk_${hash}`);
        return true;
      } catch {}
    }
    const item = await this.get('file_chunks', hash);
    return !!item;
  }
}

export const dbManager = new LocalStorageManager();
