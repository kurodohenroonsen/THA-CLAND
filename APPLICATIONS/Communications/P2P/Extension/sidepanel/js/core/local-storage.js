import { logger } from './logger.js';
import { CryptoVault } from './crypto-vault.js';
import { StorageGovernor, STORAGE_TIERS } from './storage-governor.js';

/**
 * Gestionnaire de Stockage Local Asynchrone Haute Performance (IndexedDB v6 + OPFS)
 * Durcissement Pass 4 (2026) : Write-Ahead Logging (WAL), Staging-then-Atomic-Move,
 * Strict Durability, Auto-Guérison 0-octet, Pagination cursor.advance() et Storage Governor.
 */

const DB_NAME = 'P2PMeshWorkspaceDB';
const DB_VERSION = 6; // Montée en v6 : Journal WAL, Index LRU et Storage Governor

export class LocalStorageManager {
  constructor() {
    this.db = null;
    this.opfsRoot = null;
    this._initPromise = null;
    this._supportsAtomicMove = null;
    this.governor = new StorageGovernor(this);
  }

  /**
   * Initialise la base de données IndexedDB et le dossier racine OPFS
   */
  async init() {
    if (this._initPromise) return this._initPromise;

    this._initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onblocked = () => {
        logger.warn('Storage', 'Ouverture IndexedDB bloquée par une autre connexion active.');
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;
        const transaction = event.target.transaction;

        logger.info('Storage', `Migration du schéma IndexedDB : v${oldVersion} -> v${DB_VERSION}`);

        // --- V1 à V5 : Magasins existants ---
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

        if (oldVersion < 4) {
          if (db.objectStoreNames.contains('messages')) {
            const msgStore = transaction.objectStore('messages');
            if (msgStore.indexNames.contains('lamportTime')) msgStore.deleteIndex('lamportTime');
            if (!msgStore.indexNames.contains('lamport')) msgStore.createIndex('lamport', 'lamport', { unique: false });
            if (!msgStore.indexNames.contains('channelId_timestamp')) {
              msgStore.createIndex('channelId_timestamp', ['channelId', 'timestamp'], { unique: false });
            }
          }

          if (db.objectStoreNames.contains('file_commits')) {
            const commitStore = transaction.objectStore('file_commits');
            if (!commitStore.indexNames.contains('fileId_version')) {
              commitStore.createIndex('fileId_version', ['fileId', 'versionNumber'], { unique: false });
            }
            if (!commitStore.indexNames.contains('folderPath_timestamp')) {
              commitStore.createIndex('folderPath_timestamp', ['folderPath', 'timestamp'], { unique: false });
            }
          }

          if (db.objectStoreNames.contains('forum_threads')) {
            const forumStore = transaction.objectStore('forum_threads');
            if (!forumStore.indexNames.contains('category_createdAt')) {
              forumStore.createIndex('category_createdAt', ['category', 'createdAt'], { unique: false });
            }
          }

          if (!db.objectStoreNames.contains('drive_folder_deletions')) {
            const folderDelStore = db.createObjectStore('drive_folder_deletions', { keyPath: 'path' });
            folderDelStore.createIndex('deletedAt', 'deletedAt', { unique: false });
          }
        }

        if (oldVersion < 5) {
          if (!db.objectStoreNames.contains('trust_attestations')) {
            const trustStore = db.createObjectStore('trust_attestations', { keyPath: 'id', autoIncrement: true });
            trustStore.createIndex('issuerPubkey', 'issuerPubkey', { unique: false });
            trustStore.createIndex('subjectPubkey', 'subjectPubkey', { unique: false });
            trustStore.createIndex('expiresAt', 'expiresAt', { unique: false });
          }

          if (!db.objectStoreNames.contains('trust_revocations')) {
            const revStore = db.createObjectStore('trust_revocations', { keyPath: 'subjectPubkey' });
            revStore.createIndex('issuerPubkey', 'issuerPubkey', { unique: false });
            revStore.createIndex('timestamp', 'timestamp', { unique: false });
          }

          if (!db.objectStoreNames.contains('banned_peers')) {
            const banStore = db.createObjectStore('banned_peers', { keyPath: 'pubkey' });
            banStore.createIndex('bannedAt', 'bannedAt', { unique: false });
          }

          if (!db.objectStoreNames.contains('moderation_tombstones')) {
            const modStore = db.createObjectStore('moderation_tombstones', { keyPath: 'targetId' });
            modStore.createIndex('type', 'type', { unique: false });
            modStore.createIndex('moderatorPubkey', 'moderatorPubkey', { unique: false });
            modStore.createIndex('timestamp', 'timestamp', { unique: false });
          }

          if (!db.objectStoreNames.contains('room_delegations')) {
            const delStore = db.createObjectStore('room_delegations', { keyPath: 'id' });
            delStore.createIndex('delegatePubkey', 'delegatePubkey', { unique: false });
            delStore.createIndex('role', 'role', { unique: false });
          }
        }

        // --- V6 : Write-Ahead Log (WAL) & Indexation LRU ---
        if (oldVersion < 6) {
          if (!db.objectStoreNames.contains('storage_wal')) {
            const walStore = db.createObjectStore('storage_wal', { keyPath: 'walId' });
            walStore.createIndex('status', 'status', { unique: false });
            walStore.createIndex('createdAt', 'createdAt', { unique: false });
          }
          if (db.objectStoreNames.contains('file_chunks')) {
            const chunkStore = transaction.objectStore('file_chunks');
            if (!chunkStore.indexNames.contains('lastAccessed')) {
              chunkStore.createIndex('lastAccessed', 'lastAccessed', { unique: false });
            }
            if (!chunkStore.indexNames.contains('tier')) {
              chunkStore.createIndex('tier', 'tier', { unique: false });
            }
          }
        }
      };

      request.onsuccess = async (event) => {
        this.db = event.target.result;

        this.db.onversionchange = () => {
          logger.warn('Storage', 'Versionchange détecté : fermeture de la connexion.');
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
        if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
          try {
            this.opfsRoot = await navigator.storage.getDirectory();
            logger.info('Storage', 'OPFS (Origin Private File System) initialisé.');
          } catch (e) {
            logger.warn('Storage', 'OPFS indisponible, fallback IndexedDB:', e);
          }
        }

        // Demande de persistance
        try {
          if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
            const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
            const granted = already || await navigator.storage.persist();
            logger.info('Storage', `Stockage persistant : ${granted ? 'accordé 🔒' : 'best-effort ⚠️'}`);
          }
        } catch (e) {
          logger.warn('Storage', 'Échec demande persistance:', e);
        }

        // Auto-guérison au démarrage
        try {
          await this.runColdBootAutoHealing();
        } catch (healErr) {
          logger.error('Storage', 'Erreur lors de l\'auto-guérison au boot:', healErr);
        }

        logger.info('Storage', 'IndexedDB v6 + OPFS initialisés avec succès.');
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

  async _ensureDb() {
    if (!this.db) await this.init();
  }

  // --- Primitives Transactionnelles Durcies ---

  async save(storeName, item, { strict = false } = {}) {
    return this._wrapWriteWithQuotaRecovery(`save(${storeName})`, async () => {
      await this._ensureDb();
      return new Promise((resolve, reject) => {
        const durability = strict ? 'strict' : 'relaxed';
        const transaction = this.db.transaction([storeName], 'readwrite', { durability });
        const store = transaction.objectStore(storeName);
        const request = store.put(item);
        request.onsuccess = () => resolve(item);
        request.onerror = (e) => reject(e.target.error);
      });
    });
  }

  async saveBatch(storeName, items, { strict = false } = {}) {
    if (!items || items.length === 0) return [];
    return this._wrapWriteWithQuotaRecovery(`saveBatch(${storeName})`, async () => {
      await this._ensureDb();
      return new Promise((resolve, reject) => {
        const durability = strict ? 'strict' : 'relaxed';
        const transaction = this.db.transaction([storeName], 'readwrite', { durability });
        const store = transaction.objectStore(storeName);

        transaction.oncomplete = () => resolve(items);
        transaction.onerror = (e) => reject(e.target.error || transaction.error);
        transaction.onabort = (e) => reject(e.target.error || transaction.error || new Error('Transaction annulée'));

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item !== undefined && item !== null) {
            store.put(item);
          }
        }
      });
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

  async delete(storeName, key, { strict = false } = {}) {
    await this._ensureDb();
    return new Promise((resolve, reject) => {
      const durability = strict ? 'strict' : 'relaxed';
      const transaction = this.db.transaction([storeName], 'readwrite', { durability });
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve(true);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Requête paginée par curseur optimisée avec cursor.advance()
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
      let hasAdvanced = false;

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return resolve(results);

        if (offset > 0 && !hasAdvanced) {
          hasAdvanced = true;
          cursor.advance(offset);
          return;
        }

        results.push(cursor.value);
        if (results.length >= limit) return resolve(results);

        cursor.continue();
      };

      request.onerror = (e) => reject(e.target.error);
    });
  }

  // --- Write-Ahead Logging (WAL) ---

  async walBegin(type, payload) {
    const walId = `wal_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const record = {
      walId,
      type,
      payload,
      status: 'PENDING',
      createdAt: Date.now()
    };
    await this.save('storage_wal', record, { strict: true });
    return walId;
  }

  async walCommit(walId) {
    await this.delete('storage_wal', walId, { strict: true });
  }

  async walRollback(walId) {
    try {
      const entry = await this.get('storage_wal', walId);
      if (entry) {
        entry.status = 'ABORTED';
        await this.save('storage_wal', entry, { strict: true });
      }
    } catch {}
  }

  // --- Méthodes Métier (Chat, Forum, Drive) ---

  async saveMessage(message) { return this.save('messages', message); }
  async saveMessagesBatch(messages) { return this.saveBatch('messages', messages); }

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
      const all = await this.getAll('messages');
      return all
        .filter(m => m.channelId === channelId && (m.timestamp || 0) <= beforeTimestamp)
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .slice(-limit);
    }
  }

  async saveForumThread(thread) { return this.save('forum_threads', thread); }
  async getAllForumThreads({ limit = 50, offset = 0 } = {}) {
    return this.queryCursor({
      storeName: 'forum_threads',
      indexName: 'createdAt',
      direction: 'prev',
      limit,
      offset
    });
  }

  async saveFileCommit(commit) { return this.save('file_commits', commit); }
  async saveFileCommitsBatch(commits) { return this.saveBatch('file_commits', commits); }
  async getAllFileCommits() { return this.getAll('file_commits'); }

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

  async saveDriveFolder(folder) { return this.save('drive_folders', folder); }
  async getAllDriveFolders() { return this.getAll('drive_folders'); }
  async deleteDriveFolder(path) { return this.delete('drive_folders', path); }
  async saveFolderDeletion(tombstone) { return this.save('drive_folder_deletions', tombstone); }
  async getDeletedFolderPaths() { const keys = await this.getAllKeys('drive_folder_deletions'); return new Set(keys); }
  async saveFileDeletion(tombstone) { return this.save('drive_deletions', tombstone); }
  async saveFileDeletionsBatch(tombstones) { return this.saveBatch('drive_deletions', tombstones); }
  async getDeletedFileIds() { const keys = await this.getAllKeys('drive_deletions'); return new Set(keys); }

  async saveSetting(key, value) { return this.save('settings', { key, value }, { strict: true }); }
  async getSetting(key, defaultValue = null) {
    const item = await this.get('settings', key);
    return item !== undefined && item !== null ? item.value : defaultValue;
  }

  // --- Quotas, Persistance & Estimation ---

  async isPersisted() {
    if (navigator.storage && navigator.storage.persisted) {
      try { return await navigator.storage.persisted(); } catch { return false; }
    }
    return false;
  }

  async requestPersistenceInteractive() {
    if (!navigator.storage || !navigator.storage.persist) {
      return { supported: false, granted: false, reason: 'API non supportée' };
    }
    try {
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (already) return { supported: true, granted: true, already: true };

      const granted = await navigator.storage.persist();
      logger.info('Storage', `Demande interactive de persistance : ${granted ? 'ACCORDÉE 🔒' : 'REFUSÉE ⚠️'}`);
      return { supported: true, granted, already: false };
    } catch (err) {
      logger.warn('Storage', 'Erreur demande interactive de persistance:', err);
      return { supported: true, granted: false, error: err.message };
    }
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
    const multipliers = { download: 2.1, upload: 1.15, replicate: 1.1 };
    const needed = Math.ceil(bytes * (multipliers[mode] || 1.2));
    return this.governor.enforceProactiveQuota(needed);
  }

  // --- Auto-Guérison & Nettoyage Résilient ---

  async runColdBootAutoHealing() {
    logger.info('Storage', '🩺 Démarrage de la routine d\'auto-guérison au démarrage...');
    let purgedGhostCount = 0;
    let purgedStagingCount = 0;

    if (this.opfsRoot) {
      const now = Date.now();
      const MAX_STAGING_AGE_MS = 60 * 1000;
      const MAX_ASSEMBLED_AGE_MS = 5 * 60 * 1000;

      for await (const [name, handle] of this.opfsRoot.entries()) {
        try {
          if (name.startsWith('staging_') || name.startsWith('tmp_') || name.endsWith('.crswap')) {
            await this.opfsRoot.removeEntry(name);
            purgedStagingCount++;
            continue;
          }

          if (name.startsWith('assembled_')) {
            const parts = name.split('_');
            const fileTime = parseInt(parts[1], 10);
            if (isNaN(fileTime) || (now - fileTime > MAX_ASSEMBLED_AGE_MS)) {
              await this.opfsRoot.removeEntry(name);
              purgedStagingCount++;
              continue;
            }
          }

          if (name.startsWith('chunk_')) {
            const file = await handle.getFile();
            if (file.size === 0) {
              await this.opfsRoot.removeEntry(name);
              purgedGhostCount++;
            }
          }
        } catch (scanErr) {
          logger.debug('Storage', `Erreur inspection entrée OPFS ${name}:`, scanErr);
        }
      }
    }

    let walCleaned = 0;
    try {
      const pendingWALs = await this.getAll('storage_wal');
      for (const wal of pendingWALs) {
        if (wal.status === 'PENDING') {
          if (Date.now() - wal.createdAt > 300000) {
            await this.delete('storage_wal', wal.walId, { strict: true });
            walCleaned++;
          }
        } else {
          await this.delete('storage_wal', wal.walId, { strict: true });
          walCleaned++;
        }
      }
    } catch {}

    if (purgedGhostCount > 0 || purgedStagingCount > 0 || walCleaned > 0) {
      logger.info('Storage', `✅ Auto-guérison terminée : ${purgedGhostCount} chunks 0-octet purgés, ${purgedStagingCount} résidus staging purgés, ${walCleaned} entrées WAL résolues.`);
    }
  }

  async sweepStaleTempFiles(maxAgeMs = 5 * 60 * 1000) {
    if (!this.opfsRoot) return { purgedCount: 0, purgedBytes: 0 };
    let purgedCount = 0;
    let purgedBytes = 0;
    try {
      const now = Date.now();
      for await (const [name, handle] of this.opfsRoot.entries()) {
        if (name.startsWith('assembled_') || name.startsWith('staging_') || name.startsWith('tmp_')) {
          const parts = name.split('_');
          const fileTime = parseInt(parts[1], 10);
          if (isNaN(fileTime) || (now - fileTime > maxAgeMs) || maxAgeMs === 0) {
            try {
              const f = await handle.getFile();
              purgedBytes += f.size;
              await this.opfsRoot.removeEntry(name);
              purgedCount++;
            } catch (_) {}
          }
        }
      }
    } catch (err) {
      logger.debug('Storage', 'Balayage temp OPFS:', err);
    }
    return { purgedCount, purgedBytes };
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

    if (this.opfsRoot) {
      for await (const [name, handle] of this.opfsRoot.entries()) {
        if (name.startsWith('chunk_')) {
          const hash = name.replace('chunk_', '');
          if (!referencedHashes.has(hash) && !this.governor.pinnedChunks.has(hash)) {
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

    const idbChunks = await this.getAll('file_chunks');
    for (const ch of idbChunks) {
      if (!referencedHashes.has(ch.hash) && !this.governor.pinnedChunks.has(ch.hash)) {
        purgedBytes += ch.size || ch.data?.byteLength || 0;
        await this.delete('file_chunks', ch.hash);
        purgedCount++;
      }
    }

    logger.info('Storage', `✅ GC terminé : ${purgedCount} blocs orphelins purgés (${(purgedBytes / (1024 * 1024)).toFixed(2)} Mo libérés).`);
    return { purgedCount, purgedBytes };
  }

  // --- Gestion Écriture Résiliente Staging + Move & Quota Recovery ---

  async _wrapWriteWithQuotaRecovery(operationName, writeFn, estimatedBytes = 0) {
    try {
      if (estimatedBytes > 0) {
        await this.governor.enforceProactiveQuota(estimatedBytes);
      }
      return await writeFn();
    } catch (err) {
      const isQuota = err && (
        err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        err.code === 22 ||
        (err.message && err.message.toLowerCase().includes('quota'))
      );

      if (isQuota) {
        logger.warn('Storage', `🚨 QuotaExceededError capturé sur '${operationName}' ! Éviction d'urgence...`);
        const { freedBytes } = await this.governor.runMultiTierEviction(Math.max(estimatedBytes * 2, 20 * 1024 * 1024));

        if (freedBytes > 0) {
          logger.info('Storage', `✅ ${(freedBytes / 1048576).toFixed(1)} Mo libérés. Nouvelle tentative de '${operationName}'...`);
          return await writeFn();
        }
      }
      throw err;
    }
  }

  async saveChunk(hash, arrayBuffer) {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(`opfs:chunk:${hash}`, async () => {
        if (await this.hasChunk(hash)) {
          await this._touchChunk(hash);
          return { hash, size: arrayBuffer.byteLength, inOPFS: true, skipped: true };
        }
        return this._saveChunkAtomic(hash, arrayBuffer);
      });
    }
    return this._saveChunkAtomic(hash, arrayBuffer);
  }

  async _saveChunkAtomic(hash, arrayBuffer) {
    return this._wrapWriteWithQuotaRecovery(`saveChunk(${hash})`, async () => {
      const now = Date.now();

      if (this.opfsRoot) {
        const stagingName = `staging_${hash}_${now}_${Math.random().toString(36).slice(2, 6)}`;
        const targetName = `chunk_${hash}`;
        let stagingHandle = null;

        try {
          stagingHandle = await this.opfsRoot.getFileHandle(stagingName, { create: true });
          const writable = await stagingHandle.createWritable({ keepExistingData: false });
          await writable.write(arrayBuffer);
          await writable.close();

          const stagedFile = await stagingHandle.getFile();
          if (stagedFile.size !== arrayBuffer.byteLength) {
            throw new Error(`Taille de staging incorrecte: ${stagedFile.size} != ${arrayBuffer.byteLength}`);
          }

          if (typeof stagingHandle.move === 'function') {
            await stagingHandle.move(targetName);
            this._supportsAtomicMove = true;
          } else {
            const targetHandle = await this.opfsRoot.getFileHandle(targetName, { create: true });
            const targetWritable = await targetHandle.createWritable();
            await targetWritable.write(arrayBuffer);
            await targetWritable.close();
            await this.opfsRoot.removeEntry(stagingName);
          }

          await this.save('file_chunks', {
            hash,
            size: arrayBuffer.byteLength,
            timestamp: now,
            lastAccessed: now,
            tier: STORAGE_TIERS.TIER_3_SWARM_CHUNKS,
            inOPFS: true
          });

          return { hash, size: arrayBuffer.byteLength, inOPFS: true };
        } catch (err) {
          if (stagingHandle) {
            try { await this.opfsRoot.removeEntry(stagingName); } catch {}
          }
          const isQuota = err && (err.name === 'QuotaExceededError' || err.code === 22);
          if (isQuota) throw err;
          logger.warn('Storage', `Échec écriture OPFS pour chunk ${hash}, repli IndexedDB:`, err);
        }
      }

      return this.save('file_chunks', {
        hash,
        data: arrayBuffer,
        size: arrayBuffer.byteLength,
        timestamp: now,
        lastAccessed: now,
        tier: STORAGE_TIERS.TIER_3_SWARM_CHUNKS,
        inOPFS: false
      });
    }, arrayBuffer.byteLength);
  }

  async _touchChunk(hash) {
    try {
      const meta = await this.get('file_chunks', hash);
      if (meta) {
        meta.lastAccessed = Date.now();
        await this.save('file_chunks', meta);
      }
    } catch (_) {}
  }

  async getChunk(hash) {
    let buffer = null;

    if (this.opfsRoot) {
      try {
        const fileHandle = await this.opfsRoot.getFileHandle(`chunk_${hash}`);
        const file = await fileHandle.getFile();
        if (file.size > 0) {
          buffer = await file.arrayBuffer();
        } else {
          logger.warn('Storage', `🧹 Fichier chunk 0-octet détecté pour ${hash} : suppression auto-guérissante.`);
          try { await this.opfsRoot.removeEntry(`chunk_${hash}`); } catch {}
        }
      } catch {}
    }

    if (!buffer) {
      const item = await this.get('file_chunks', hash);
      if (item && item.data && item.data.byteLength > 0) {
        buffer = item.data;
      }
    }

    if (buffer) {
      const computedHash = await CryptoVault.hashSHA256(buffer);
      if (computedHash !== hash) {
        logger.error('Storage', `🚨 Corruption de bloc détectée pour ${hash} (calculé: ${computedHash}) ! Purge.`);
        await this.purgeCorruptedChunk(hash);
        return null;
      }
      this._touchChunk(hash).catch(() => {});
    }

    return buffer;
  }

  async hasChunk(hash) {
    if (this.opfsRoot) {
      try {
        const fileHandle = await this.opfsRoot.getFileHandle(`chunk_${hash}`);
        const file = await fileHandle.getFile();
        if (file.size > 0) return true;
        try { await this.opfsRoot.removeEntry(`chunk_${hash}`); } catch {}
      } catch {}
    }

    const item = await this.get('file_chunks', hash);
    return !!(item && (item.size > 0 || item.data?.byteLength > 0));
  }

  async purgeCorruptedChunk(hash) {
    if (this.opfsRoot) {
      try { await this.opfsRoot.removeEntry(`chunk_${hash}`); } catch {}
    }
    try { await this.delete('file_chunks', hash); } catch {}
  }
}

export const dbManager = new LocalStorageManager();
