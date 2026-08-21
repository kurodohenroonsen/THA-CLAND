/**
 * Gestionnaire de Stockage Local Asynchrone (IndexedDB + OPFS)
 * Stockage persistant et hors-ligne des messages, forums, index de versions, répertoires et blocs binaires.
 */

const DB_NAME = 'P2PMeshWorkspaceDB';
const DB_VERSION = 3;

export class LocalStorageManager {
  constructor() {
    this.db = null;
    this.opfsRoot = null;
  }

  /**
   * Initialise la base de données IndexedDB et le dossier racine OPFS
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Magasin des messages de chat
        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('channelId', 'channelId', { unique: false });
          msgStore.createIndex('timestamp', 'timestamp', { unique: false });
          msgStore.createIndex('lamportTime', 'lamportTime', { unique: false });
        }

        // Magasin des sujets et fils de discussion de forum
        if (!db.objectStoreNames.contains('forum_threads')) {
          const forumStore = db.createObjectStore('forum_threads', { keyPath: 'id' });
          forumStore.createIndex('category', 'category', { unique: false });
          forumStore.createIndex('createdAt', 'createdAt', { unique: false });
        }

        // Magasin des commits et métadonnées de versioning du drive
        if (!db.objectStoreNames.contains('file_commits')) {
          const commitStore = db.createObjectStore('file_commits', { keyPath: 'commitId' });
          commitStore.createIndex('fileId', 'fileId', { unique: false });
          commitStore.createIndex('folderPath', 'folderPath', { unique: false });
          commitStore.createIndex('parentCommitId', 'parentCommitId', { unique: false });
          commitStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Magasin des dossiers & répertoires du Drive
        if (!db.objectStoreNames.contains('drive_folders')) {
          const folderStore = db.createObjectStore('drive_folders', { keyPath: 'path' });
          folderStore.createIndex('parentPath', 'parentPath', { unique: false });
          folderStore.createIndex('createdAt', 'createdAt', { unique: false });
        }

        // Magasin des blocs binaires (Chunks SHA-256)
        if (!db.objectStoreNames.contains('file_chunks')) {
          db.createObjectStore('file_chunks', { keyPath: 'hash' });
        }

        // Magasin des paramètres utilisateur et session
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }

        // Magasin des suppressions de fichiers (tombstones signés, CRDT)
        if (!db.objectStoreNames.contains('drive_deletions')) {
          db.createObjectStore('drive_deletions', { keyPath: 'fileId' });
        }
      };

      request.onsuccess = async (event) => {
        this.db = event.target.result;
        
        // Initialisation de OPFS si supporté par le navigateur
        if (navigator.storage && navigator.storage.getDirectory) {
          try {
            this.opfsRoot = await navigator.storage.getDirectory();
            console.log('[Storage] OPFS (Origin Private File System) actif.');
          } catch (e) {
            console.warn('[Storage] OPFS indisponible, fallback vers IndexedDB uniquement:', e);
          }
        }

        // Demande de stockage PERSISTANT (évite l'éviction du navigateur sous
        // pression disque — indispensable pour un rôle de "seed" durable et pour
        // les transferts > 1 Go, cf. audit §quotas OPFS).
        try {
          if (navigator.storage && navigator.storage.persist) {
            const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
            const granted = already || await navigator.storage.persist();
            console.log(`[Storage] Stockage persistant : ${granted ? 'accordé' : 'refusé (best-effort)'}`);
          }
        } catch (e) {
          console.warn('[Storage] Impossible de demander la persistance:', e);
        }
        
        console.log('[Storage] IndexedDB initialisée.');
        resolve(this);
      };

      request.onerror = (event) => {
        console.error('[Storage] Erreur ouverture IndexedDB:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  // --- Opérations Génériques ---

  async save(storeName, item) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(item);
      request.onsuccess = () => resolve(item);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async get(storeName, key) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async getAll(storeName) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async delete(storeName, key) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve(true);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  // --- Méthodes Spécifiques au Chat ---

  async saveMessage(message) {
    return this.save('messages', message);
  }

  async getMessagesByChannel(channelId) {
    const all = await this.getAll('messages');
    return all
      .filter(m => m.channelId === channelId)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  // --- Méthodes Spécifiques au Forum ---

  async saveForumThread(thread) {
    return this.save('forum_threads', thread);
  }

  async getAllForumThreads() {
    const all = await this.getAll('forum_threads');
    return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  // --- Méthodes Spécifiques au Drive & Versioning ---

  async saveFileCommit(commit) {
    return this.save('file_commits', commit);
  }

  async getAllFileCommits() {
    return this.getAll('file_commits');
  }

  async getCommitsByFileId(fileId) {
    const all = await this.getAllFileCommits();
    return all
      .filter(c => c.fileId === fileId)
      .sort((a, b) => (b.versionNumber || 0) - (a.versionNumber || 0));
  }

  // --- Méthodes Dossiers & Répertoires Drive ---

  async saveDriveFolder(folder) {
    return this.save('drive_folders', folder);
  }

  async getAllDriveFolders() {
    return this.getAll('drive_folders');
  }

  async deleteDriveFolder(path) {
    return this.delete('drive_folders', path);
  }

  // --- Suppressions de fichiers (tombstones) ---

  async saveFileDeletion(tombstone) {
    return this.save('drive_deletions', tombstone);
  }

  async getDeletedFileIds() {
    const all = await this.getAll('drive_deletions');
    return new Set(all.map(t => t.fileId));
  }

  // --- Méthodes Paramètres & Sessions Utilisateur ---

  async saveSetting(key, value) {
    return this.save('settings', { key, value });
  }

  async getSetting(key, defaultValue = null) {
    const item = await this.get('settings', key);
    return item !== undefined && item !== null ? item.value : defaultValue;
  }

  // --- Gestion des Quotas de Stockage (OPFS / IndexedDB) ---

  /**
   * Renvoie { usage, quota, available, percent } via l'API StorageManager.
   */
  async estimateStorage() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        return {
          usage,
          quota,
          available: Math.max(0, quota - usage),
          percent: quota > 0 ? Math.round((usage / quota) * 100) : 0
        };
      } catch {}
    }
    return { usage: 0, quota: 0, available: Infinity, percent: 0 };
  }

  /**
   * Vérifie qu'il reste assez de place pour écrire `bytes` octets (avec une marge
   * de sécurité de 5%). Lève une erreur explicite sinon — appelé avant un gros
   * téléversement/téléchargement pour éviter un échec en cours de route.
   */
  async ensureSpaceFor(bytes) {
    const { available, quota } = await this.estimateStorage();
    if (available === Infinity) return true;
    const needed = Math.ceil(bytes * 1.05);
    if (needed > available) {
      const mb = (n) => `${(n / (1024 * 1024)).toFixed(0)} Mo`;
      throw new Error(`Espace de stockage insuffisant : ${mb(needed)} requis, ${mb(available)} disponibles (quota ${mb(quota)}). Libérez de l'espace ou activez « unlimitedStorage ».`);
    }
    return true;
  }

  // --- Méthodes Stockage Binaire (Chunks) ---

  async saveChunk(hash, arrayBuffer) {
    // Si OPFS disponible, enregistre dans le système de fichier privé
    if (this.opfsRoot) {
      try {
        const fileHandle = await this.opfsRoot.getFileHandle(`chunk_${hash}`, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(arrayBuffer);
        await writable.close();
        return { hash, size: arrayBuffer.byteLength, inOPFS: true };
      } catch (err) {
        console.warn(`[Storage] Échec écriture OPFS pour chunk ${hash}, fallback IndexedDB:`, err);
      }
    }

    // Fallback IndexedDB
    return this.save('file_chunks', {
      hash,
      data: arrayBuffer,
      size: arrayBuffer.byteLength,
      timestamp: Date.now()
    });
  }

  async getChunk(hash) {
    // Tentative de lecture depuis OPFS
    if (this.opfsRoot) {
      try {
        const fileHandle = await this.opfsRoot.getFileHandle(`chunk_${hash}`);
        const file = await fileHandle.getFile();
        return await file.arrayBuffer();
      } catch {}
    }

    // Fallback lecture IndexedDB
    const item = await this.get('file_chunks', hash);
    return item ? item.data : null;
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
