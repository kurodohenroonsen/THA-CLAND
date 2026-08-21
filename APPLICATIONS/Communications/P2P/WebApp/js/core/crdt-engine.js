import { logger } from './logger.js';
/**
 * Moteur CRDT (Conflict-Free Replicated Data Type) & Réconciliation P2P (2025/2026)
 * Horloges logiques de Lamport protégées, BroadcastChannel inter-onglets, Compression de flux,
 * validation cryptographique stricte et fusion déterministe pour Chat, Forums, Commits et Dossiers.
 */

import { dbManager } from './local-storage.js';
import { CryptoVault } from './crypto-vault.js';
import { BoundedSet } from './bounded-cache.js';
import { StreamCompressor } from './stream-compressor.js';
import { MerkleTree } from '../modules/drive/merkle-tree.js';

export class CRDTEngine {
  constructor(meshNetwork, cryptoVault) {
    this.mesh = meshNetwork;
    this.vault = cryptoVault;
    this.lamportClock = 0;
    this.tabId = `tab_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`;
    this.stateVectors = new Map();
    this.listeners = new Map();

    // Réplication complète (gossip multi-sauts) : identifiants de contenus déjà vus
    this.seenContentIds = new BoundedSet(50000);

    // Initialisation du bus local inter-onglets (sans passer par WebRTC)
    this.localTabChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pmesh_tab_sync') : null;
    this.initLocalTabSync();

    this.initListeners();

    // Initialisation asynchrone de l'horloge de Lamport depuis la base locale
    this.initLamportClock().catch(() => {});

    // Anti-entropie périodique
    this.antiEntropyMs = 25000;
    this.antiEntropyTimer = setInterval(() => this._runAntiEntropy(), this.antiEntropyMs);
  }

  /**
   * Initialise l'horloge de Lamport à la valeur maximale présente dans la base de données locale
   */
  async initLamportClock() {
    try {
      const [msgs, threads, commits] = await Promise.all([
        dbManager.getAll('messages'),
        dbManager.getAll('forum_threads'),
        dbManager.getAll('file_commits')
      ]);
      const maxMsg = msgs.reduce((m, x) => Math.max(m, x.lamport || 0), 0);
      const maxThr = threads.reduce((m, x) => Math.max(m, x.lamport || 0), 0);
      const maxCmt = commits.reduce((m, x) => Math.max(m, x.lamportClock || m), 0);
      const maxFound = Math.max(0, maxMsg, maxThr, maxCmt);

      this.lamportClock = Math.max(this.lamportClock, maxFound);
      logger.info('CRDT', `Horloge de Lamport initialisée à ${this.lamportClock}`);
    } catch (e) {
      logger.debug('CRDT', 'Erreur initLamportClock:', e);
    }
  }

  /**
   * Écouteur du BroadcastChannel pour réplication temps réel inter-onglets
   */
  initLocalTabSync() {
    if (!this.localTabChannel) return;
    this.localTabChannel.onmessage = (event) => {
      const { type, payload, lamport, sourceTabId } = event.data || {};
      if (sourceTabId === this.tabId) return;

      this.tick(lamport || 0);

      switch (type) {
        case 'LOCAL_CHAT_MSG':
          if (payload && payload.id) {
            this._markSeen('msg:' + payload.id);
            this.emit('chat-message-received', payload);
          }
          break;
        case 'LOCAL_FORUM_TOPIC':
          if (payload && payload.id) {
            this._markSeen('thr:' + payload.id);
            this.emit('forum-topic-received', payload);
          }
          break;
        case 'LOCAL_FORUM_REPLY':
          if (payload && payload.reply) {
            this._markSeen('rep:' + payload.reply.id);
            this.emit('forum-reply-received', payload);
          }
          break;
        case 'LOCAL_DRIVE_COMMIT':
          if (payload && payload.commitId) {
            this._markSeen('cmt:' + payload.commitId);
            this.emit('drive-commit-received', payload);
          }
          break;
        case 'LOCAL_DRIVE_FOLDER_UPDATED':
          this.emit('drive-folder-updated', payload);
          break;
        case 'LOCAL_DRIVE_FILE_DELETED':
          this.emit('drive-file-deleted', payload);
          break;
      }
    };
  }

  _broadcastLocalTab(actionType, payload, clock) {
    if (this.localTabChannel) {
      try {
        this.localTabChannel.postMessage({
          type: actionType,
          payload,
          lamport: clock,
          sourceTabId: this.tabId
        });
      } catch (e) {
        logger.debug('CRDT', 'Erreur postMessage BroadcastChannel:', e);
      }
    }
  }

  /** Identifiant stable d'un message répliquable */
  _relayableId(m) {
    switch (m.type) {
      case 'CHAT_MSG': return m.payload && m.payload.id ? 'msg:' + m.payload.id : null;
      case 'FORUM_TOPIC': return m.payload && m.payload.id ? 'thr:' + m.payload.id : null;
      case 'FORUM_REPLY': return m.reply && m.reply.id ? 'rep:' + m.reply.id : null;
      case 'DRIVE_COMMIT_BROADCAST': return m.payload && m.payload.commitId ? 'cmt:' + m.payload.commitId : null;
      case 'DRIVE_FOLDER_CREATE': return m.folder && m.folder.path ? 'fdc:' + m.folder.path + ':' + (m.folder.createdAt || '') : null;
      case 'DRIVE_FILE_DELETE': return m.fileId && m.op ? 'fdel:' + m.fileId + ':' + (m.op.timestamp || '') : null;
      case 'DRIVE_FOLDER_DELETE': return m.folderPath && m.op ? 'foldel:' + m.folderPath + ':' + (m.op.timestamp || '') : null;
      default: return null;
    }
  }

  _markSeen(id) { if (id) this.seenContentIds.addIfNew(id); }

  _runAntiEntropy() {
    if (!this.mesh || this.mesh.peers.size === 0) return;
    const ids = Array.from(this.mesh.peers.keys());
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    ids.slice(0, 3).forEach((pid) => {
      this.sendSyncRequest(pid).catch((err) => {
        logger.debug('CRDT', `Échec sync request vers ${pid}:`, err);
      });
    });
  }

  initListeners() {
    this.mesh.on('message-received', async ({ peerId, message }) => {
      try {
        const cid = this._relayableId(message);
        if (cid) {
          const isNew = this.seenContentIds.addIfNew(cid);
          if (isNew) {
            this.mesh.peers.forEach((peer, otherId) => {
              if (otherId !== peerId) {
                this.mesh.sendToPeer(otherId, message);
              }
            });
          }
        }

        switch (message.type) {
          case 'CRDT_SYNC_REQ':
            await this.handleSyncRequest(peerId, message);
            break;
          case 'CRDT_SYNC_RESP':
            await this.handleSyncResponse(message);
            break;
          case 'CHAT_MSG':
            await this.handleIncomingChatMessage(message);
            break;
          case 'TYPING_SIGNAL':
            this.emit('typing-signal', { peerId, ...message });
            break;
          case 'FORUM_TOPIC':
            await this.handleIncomingForumTopic(message);
            break;
          case 'FORUM_REPLY':
            await this.handleIncomingForumReply(message);
            break;
          case 'DRIVE_COMMIT_BROADCAST':
            await this.handleIncomingDriveCommit(message);
            break;
          case 'DRIVE_FOLDER_CREATE':
            await this._applyFolderCreate(message);
            break;
          case 'DRIVE_FOLDER_DELETE':
            await this._applyFolderDelete(message);
            break;
          case 'DRIVE_FILE_DELETE':
            await this._applyFileDelete(message);
            break;
        }
      } catch (err) {
        logger.error('CRDT', 'Erreur traitement message entrant:', err);
      }
    });

    this.mesh.on('peer-ready', (peerId) => {
      logger.info('CRDT', `🤝 Pair ${peerId} prêt -> négociation anti-entropie`);
      this.sendSyncRequest(peerId);
    });
  }

  async _isAuthentic(obj) {
    if (!obj || !obj.signature || !obj.authorPubkey) return false;
    return CryptoVault.verifyObject(obj);
  }

  async _applyFolderCreate(message) {
    if (message.folder && message.folder.path && (await this._isAuthentic(message.folder))) {
      await dbManager.saveDriveFolder(message.folder);
      this.emit('drive-folder-updated', message.folder);
      return true;
    }
    return false;
  }

  async _applyFolderDelete(message) {
    if (
      message.folderPath &&
      message.op &&
      message.op.folderPath === message.folderPath &&
      (await CryptoVault.verifyObject(message.op))
    ) {
      await dbManager.saveFolderDeletion({
        path: message.folderPath,
        deletedBy: message.op.authorId,
        deletedAt: message.op.timestamp || Date.now(),
        signature: message.op.signature
      });
      await dbManager.deleteDriveFolder(message.folderPath);
      this.emit('drive-folder-updated', { path: message.folderPath, deleted: true });
      return true;
    }
    logger.warn('CRDT', 'Suppression de dossier non authentifiée rejetée');
    return false;
  }

  async _applyFileDelete(message) {
    if (
      message.fileId &&
      message.op &&
      message.op.fileId === message.fileId &&
      (await CryptoVault.verifyObject(message.op))
    ) {
      await dbManager.saveFileDeletion({
        fileId: message.fileId,
        deletedBy: message.op.authorName || 'inconnu',
        timestamp: message.op.timestamp || Date.now(),
        signature: message.op.signature,
        authorPubkey: message.op.authorPubkey
      });
      this.emit('drive-file-deleted', { fileId: message.fileId });
      return true;
    }
    return false;
  }

  tick(receivedLamport = 0) {
    const MAX_DRIFT = 500; // Protection contre l'empoisonnement d'horloge
    const safeReceived =
      typeof receivedLamport === 'number' && Number.isFinite(receivedLamport) && receivedLamport > 0
        ? Math.min(receivedLamport, this.lamportClock + MAX_DRIFT)
        : 0;

    this.lamportClock = Math.max(this.lamportClock, safeReceived) + 1;
    return this.lamportClock;
  }

  async sendSyncRequest(peerId) {
    const allMsgs = await dbManager.getAll('messages');
    const allThreads = await dbManager.getAll('forum_threads');
    const allCommits = await dbManager.getAll('file_commits');
    const allFolders = await dbManager.getAll('drive_folders');
    const allDeletions = await dbManager.getAll('drive_deletions');

    const highestMsgTime = allMsgs.reduce((max, m) => Math.max(max, m.timestamp || 0), 0);
    const highestThreadTime = allThreads.reduce((max, t) => Math.max(max, t.createdAt || 0), 0);
    const highestCommitTime = allCommits.reduce((max, c) => Math.max(max, c.timestamp || 0), 0);
    const highestFolderTime = allFolders.reduce((max, f) => Math.max(max, f.createdAt || 0), 0);
    const highestDeletionTime = allDeletions.reduce((max, d) => Math.max(max, d.timestamp || 0), 0);

    this.mesh.sendToPeer(peerId, {
      type: 'CRDT_SYNC_REQ',
      vector: {
        messagesSince: highestMsgTime,
        threadsSince: highestThreadTime,
        commitsSince: highestCommitTime,
        foldersSince: highestFolderTime,
        deletionsSince: highestDeletionTime,
        lamport: this.lamportClock
      }
    });
  }

  async handleSyncRequest(peerId, req) {
    const { vector } = req;
    if (!vector) return;

    this.tick(vector.lamport || 0);

    const allMsgs = await dbManager.getAll('messages');
    const allThreads = await dbManager.getAll('forum_threads');
    const allCommits = await dbManager.getAll('file_commits');
    const allFolders = await dbManager.getAll('drive_folders');
    const allDeletions = await dbManager.getAll('drive_deletions');

    const newMsgs = allMsgs.filter((m) => (m.timestamp || 0) > (vector.messagesSince || 0));
    const newThreads = allThreads.filter((t) => (t.createdAt || 0) > (vector.threadsSince || 0));
    const newCommits = allCommits.filter((c) => (c.timestamp || 0) > (vector.commitsSince || 0));
    const newFolders = allFolders.filter((f) => (f.createdAt || 0) > (vector.foldersSince || 0));
    const newDeletions = allDeletions.filter((d) => (d.timestamp || 0) > (vector.deletionsSince || 0));

    if (
      newMsgs.length > 0 ||
      newThreads.length > 0 ||
      newCommits.length > 0 ||
      newFolders.length > 0 ||
      newDeletions.length > 0
    ) {
      const deltaObj = {
        messages: newMsgs,
        threads: newThreads,
        commits: newCommits,
        folders: newFolders,
        deletions: newDeletions,
        lamport: this.lamportClock
      };

      this.mesh.sendToPeer(peerId, {
        type: 'CRDT_SYNC_RESP',
        delta: deltaObj
      });
    }
  }

  async handleSyncResponse(resp) {
    const { delta } = resp;
    if (!delta) return;

    this.tick(delta.lamport || 0);
    const CAP = 5000;

    if (Array.isArray(delta.messages)) {
      const accepted = [];
      for (const msg of delta.messages.slice(0, CAP)) {
        if (await this._isAuthentic(msg)) {
          await dbManager.saveMessage(msg);
          accepted.push(msg);
        }
      }
      this.emit('chat-synced', accepted);
    }

    if (Array.isArray(delta.threads)) {
      const accepted = [];
      for (const thread of delta.threads.slice(0, CAP)) {
        if (await this._mergeForumThread(thread)) accepted.push(thread);
      }
      this.emit('forum-synced', accepted);
    }

    if (Array.isArray(delta.commits)) {
      const accepted = [];
      for (const commit of delta.commits.slice(0, CAP)) {
        if ((await this._isAuthentic(commit)) && (await this._isValidCommit(commit))) {
          await dbManager.saveFileCommit(commit);
          accepted.push(commit);
        }
      }
      this.emit('drive-synced', accepted);
    }

    if (Array.isArray(delta.folders)) {
      const accepted = [];
      for (const folder of delta.folders.slice(0, CAP)) {
        if ((await this._isAuthentic(folder)) && typeof folder.path === 'string') {
          await dbManager.saveDriveFolder(folder);
          accepted.push(folder);
        }
      }
      this.emit('drive-folder-updated', accepted);
    }

    // Suppressions de fichiers (tombstones) : authentification STRICTE
    if (Array.isArray(delta.deletions)) {
      let changed = false;
      for (const tomb of delta.deletions.slice(0, CAP)) {
        if (tomb && typeof tomb.fileId === 'string' && tomb.signature && tomb.authorPubkey) {
          const isValid = await CryptoVault.verifyObject(tomb, {
            pubkeyField: 'authorPubkey',
            idField: 'deletedBy'
          });
          if (isValid) {
            await dbManager.saveFileDeletion({
              fileId: tomb.fileId,
              deletedBy: tomb.deletedBy || tomb.authorName || 'inconnu',
              timestamp: tomb.timestamp || Date.now(),
              signature: tomb.signature,
              authorPubkey: tomb.authorPubkey
            });
            changed = true;
          } else {
            logger.warn('CRDT', `Tombstone de suppression falsifié rejeté pour fileId: ${tomb.fileId}`);
          }
        }
      }
      if (changed) this.emit('drive-synced', []);
    }
  }

  async _isValidCommit(commit) {
    if (
      !commit ||
      typeof commit.commitId !== 'string' ||
      typeof commit.fileId !== 'string' ||
      !Array.isArray(commit.chunks) ||
      commit.chunks.length > 200000
    ) {
      return false;
    }

    // Validation cryptographique de la racine Merkle RFC 6962
    if (commit.chunks.length > 0 && commit.rootMerkleHash) {
      const computedRoot = await MerkleTree.computeRoot(commit.chunks.map((c) => c.hash));
      if (computedRoot !== commit.rootMerkleHash) {
        logger.warn('CRDT', `Commit ${commit.commitId} rejeté: racine Merkle invalide`);
        return false;
      }
    }
    return true;
  }

  async _mergeForumThread(incoming) {
    if (!incoming || !incoming.id) return false;
    if (!incoming.signature || !incoming.authorPubkey) return false;
    if (!(await CryptoVault.verifyObject(incoming, { excludeFields: ['replies'] }))) return false;

    const existing = await dbManager.get('forum_threads', incoming.id);
    if (!existing) {
      await dbManager.saveForumThread(incoming);
      return true;
    }

    const byId = new Map();
    for (const r of existing.replies || []) byId.set(r.id, r);
    for (const r of incoming.replies || []) {
      if (!byId.has(r.id) && (await CryptoVault.verifyObject(r))) byId.set(r.id, r);
    }
    const merged = {
      ...existing,
      replies: Array.from(byId.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    };
    await dbManager.saveForumThread(merged);
    return true;
  }

  // --- Gestion du Chat & Horloge Logique ---

  async createChatMessage(channelId, text, attachments = []) {
    const clock = this.tick();
    const message = {
      id: `msg_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`,
      channelId,
      text,
      authorId: this.vault.peerId,
      authorName: this.vault.userName,
      authorPubkey: this.vault.publicKeyHex,
      timestamp: Date.now(),
      lamport: clock,
      attachments
    };

    message.signature = await this.vault.sign(message);
    await dbManager.saveMessage(message);
    this._markSeen('msg:' + message.id);

    this._broadcastLocalTab('LOCAL_CHAT_MSG', message, clock);

    const broadcastPayload = {
      type: 'CHAT_MSG',
      payload: message,
      lamport: clock
    };
    await this.mesh.broadcast(broadcastPayload);

    return message;
  }

  async handleIncomingChatMessage(envelope) {
    const { payload, lamport } = envelope;
    if (!payload || !payload.id) return false;

    this.tick(lamport || 0);
    if (!(await this._isAuthentic(payload))) return false;

    const existing = await dbManager.get('messages', payload.id);
    if (existing) return false;

    await dbManager.saveMessage(payload);
    this.emit('chat-message-received', payload);
    return true;
  }

  sendTypingSignal(channelId, isTyping) {
    this.mesh.broadcast({
      type: 'TYPING_SIGNAL',
      channelId,
      isTyping,
      authorName: this.vault.userName,
      authorId: this.vault.peerId
    });
  }

  // --- Gestion des Forums ---

  async createAndBroadcastForumThread(title, category, content) {
    const clock = this.tick();
    const thread = {
      id: `thread_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`,
      category: category || 'Général',
      title,
      content,
      authorId: this.vault.peerId,
      authorName: this.vault.userName,
      authorPubkey: this.vault.publicKeyHex,
      createdAt: Date.now(),
      lamport: clock,
      replies: []
    };

    thread.signature = await this.vault.sign(thread, ['replies']);
    await dbManager.saveForumThread(thread);
    this._markSeen('thr:' + thread.id);

    this._broadcastLocalTab('LOCAL_FORUM_TOPIC', thread, clock);
    await this.mesh.broadcast({ type: 'FORUM_TOPIC', payload: thread, lamport: clock });
    return thread;
  }

  async createForumTopic(category, title, content) {
    return this.createAndBroadcastForumThread(title, category, content);
  }

  async addAndBroadcastForumReply(threadId, content) {
    const clock = this.tick();
    const thread = await dbManager.get('forum_threads', threadId);
    if (!thread) throw new Error('Fil de discussion introuvable');

    const now = Date.now();
    const reply = {
      id: `reply_${Math.random().toString(36).substr(2, 9)}_${now}`,
      threadId,
      content,
      authorId: this.vault.peerId,
      authorName: this.vault.userName,
      authorPubkey: this.vault.publicKeyHex,
      createdAt: now,
      timestamp: now,
      lamport: clock
    };

    reply.signature = await this.vault.sign(reply);

    if (!Array.isArray(thread.replies)) thread.replies = [];
    thread.replies.push(reply);

    await dbManager.saveForumThread(thread);
    this._markSeen('rep:' + reply.id);

    this._broadcastLocalTab('LOCAL_FORUM_REPLY', { threadId, reply }, clock);
    await this.mesh.broadcast({
      type: 'FORUM_REPLY',
      threadId,
      reply,
      lamport: clock
    });

    return reply;
  }

  async handleIncomingForumTopic(envelope) {
    const { payload, lamport } = envelope;
    if (!payload || !payload.id) return false;

    this.tick(lamport || 0);
    if (!(await this._mergeForumThread(payload))) return false;

    this.emit('forum-topic-received', payload);
    return true;
  }

  async handleIncomingForumReply(envelope) {
    const { threadId, reply, lamport } = envelope;
    if (!threadId || !reply || !reply.id) return false;

    this.tick(lamport || 0);
    if (!(await this._isAuthentic(reply))) return false;

    const thread = await dbManager.get('forum_threads', threadId);
    if (!thread) return false;

    if (!Array.isArray(thread.replies)) thread.replies = [];
    if (thread.replies.some((r) => r.id === reply.id)) return false;

    thread.replies.push(reply);
    thread.replies.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    await dbManager.saveForumThread(thread);
    this.emit('forum-reply-received', { threadId, reply });
    return true;
  }

  // --- Gestion du Drive & Versioning DAG ---

  async broadcastDriveCommit(commit) {
    const clock = this.tick();
    const signed = { ...commit };
    signed.authorPubkey = this.vault.publicKeyHex;
    signed.authorId = this.vault.peerId;
    signed.signature = await this.vault.sign(signed, ['commitId']);

    await dbManager.saveFileCommit(signed);
    this._markSeen('cmt:' + signed.commitId);

    this._broadcastLocalTab('LOCAL_DRIVE_COMMIT', signed, clock);
    await this.mesh.broadcast({
      type: 'DRIVE_COMMIT_BROADCAST',
      payload: signed,
      lamport: clock
    });
    return signed;
  }

  async broadcastFolderCreate(folderObj) {
    const clock = this.tick();
    const signed = { ...folderObj };
    signed.authorPubkey = this.vault.publicKeyHex;
    signed.authorId = this.vault.peerId;
    signed.signature = await this.vault.sign(signed);

    await dbManager.saveDriveFolder(signed);
    this._markSeen('fdc:' + signed.path + ':' + (signed.createdAt || ''));

    this._broadcastLocalTab('LOCAL_DRIVE_FOLDER_UPDATED', signed, clock);
    await this.mesh.broadcast({
      type: 'DRIVE_FOLDER_CREATE',
      folder: signed,
      lamport: clock
    });
    return signed;
  }

  async broadcastDeleteFolder(folderPath) {
    const clock = this.tick();
    const op = {
      folderPath,
      op: 'delete',
      authorId: this.vault.peerId,
      authorPubkey: this.vault.publicKeyHex,
      timestamp: Date.now()
    };
    op.signature = await this.vault.sign(op);
    this._markSeen('foldel:' + folderPath + ':' + op.timestamp);

    await dbManager.saveFolderDeletion({
      path: folderPath,
      deletedBy: op.authorId,
      deletedAt: op.timestamp,
      signature: op.signature
    });
    await dbManager.deleteDriveFolder(folderPath);

    this._broadcastLocalTab('LOCAL_DRIVE_FOLDER_UPDATED', { path: folderPath, deleted: true }, clock);
    await this.mesh.broadcast({
      type: 'DRIVE_FOLDER_DELETE',
      folderPath,
      op,
      lamport: clock
    });
  }

  async broadcastDeleteFile(fileId, authorName) {
    const clock = this.tick();
    const op = {
      fileId,
      op: 'delete-file',
      authorName: authorName || this.vault.userName,
      authorId: this.vault.peerId,
      authorPubkey: this.vault.publicKeyHex,
      timestamp: Date.now()
    };
    op.signature = await this.vault.sign(op);

    await dbManager.saveFileDeletion({
      fileId,
      deletedBy: op.authorName,
      timestamp: op.timestamp,
      signature: op.signature,
      authorPubkey: op.authorPubkey
    });
    this._markSeen('fdel:' + fileId + ':' + op.timestamp);

    this._broadcastLocalTab('LOCAL_DRIVE_FILE_DELETED', { fileId }, clock);
    await this.mesh.broadcast({ type: 'DRIVE_FILE_DELETE', fileId, op, lamport: clock });
    return op;
  }

  async handleIncomingDriveCommit(envelope) {
    const { payload, lamport } = envelope;
    if (!payload || !payload.commitId) return false;
    this.tick(lamport || 0);

    if (!(await this._isAuthentic(payload)) || !(await this._isValidCommit(payload))) return false;

    await dbManager.saveFileCommit(payload);
    this.emit('drive-commit-received', payload);
    return true;
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((cb) => cb(data));
    }
  }

  destroy() {
    if (this.antiEntropyTimer) {
      clearInterval(this.antiEntropyTimer);
      this.antiEntropyTimer = null;
    }
    if (this.localTabChannel) {
      try {
        this.localTabChannel.close();
      } catch {}
      this.localTabChannel = null;
    }
    this.listeners.clear();
  }
}
