/**
 * crdt-engine.js - Moteur Delta-CRDT Haute Performance, Causal Stability & BFT
 * P2P Mesh Workspace (Pass 4 Hardened Edition - 2026)
 * 
 * Fondations Mathématiques :
 * - Delta-State Join-Semilattices (Almeida, Shoker, Baquero - JPDC 2018)
 * - Dot-Kernel & Observed-Remove Sets (ORSet)
 * - Causal Stability Horizon Garbage Collection (Baquero et al. 2017)
 * - Merkle Clocks & Merkle-DAG Conflict Resolution (Sanjuán et al. 2020)
 * - Intégration Formelle Anti-Équivocation (PoEq) & EigenTrust (Pass 4 - E4)
 * - Compression StreamCompressor sur CRDT_SYNC_RESP (Pass 4 - E8)
 */

import { logger } from './logger.js';
import { dbManager } from './local-storage.js';
import { CryptoVault } from './crypto-vault.js';
import { BoundedSet, GenerationalSlidingCache } from './bounded-cache.js';
import { MerkleTree } from '../modules/drive/merkle-tree.js';
import { EquivocationEngine } from './equivocation-engine.js';
import { TrustEngine, TRUST_TIERS } from './trust-engine.js';
import { StreamCompressor } from './stream-compressor.js';
import { VersionVector } from './version-vector.js';

export { VersionVector };

/**
 * Compteur Positif-Négatif (PN-Counter)
 */
export class PNCounter {
  constructor(peerId, { P = {}, N = {} } = {}) {
    this.peerId = peerId;
    this.P = new VersionVector(P);
    this.N = new VersionVector(N);
  }

  inc(amount = 1) {
    for (let i = 0; i < amount; i++) this.P.tick(this.peerId);
    return this.value();
  }

  dec(amount = 1) {
    for (let i = 0; i < amount; i++) this.N.tick(this.peerId);
    return this.value();
  }

  value() {
    let sumP = 0;
    let sumN = 0;
    this.P.clocks.forEach(v => { sumP += v; });
    this.N.clocks.forEach(v => { sumN += v; });
    return sumP - sumN;
  }

  merge(delta) {
    if (!delta) return this;
    if (delta.P) this.P.merge(delta.P);
    if (delta.N) this.N.merge(delta.N);
    return this;
  }

  state() {
    return { P: this.P.toJSON(), N: this.N.toJSON() };
  }
}

/**
 * Registre Last-Write-Wins avec bris d'égalité cryptographique
 */
export class LWWRegister {
  constructor({ value = null, timestamp = 0, lamport = 0, authorPubkey = '' } = {}) {
    this.value = value;
    this.timestamp = timestamp;
    this.lamport = lamport;
    this.authorPubkey = authorPubkey;
  }

  set(value, timestamp, lamport, authorPubkey) {
    if (this._isGreater(timestamp, lamport, authorPubkey)) {
      this.value = value;
      this.timestamp = timestamp;
      this.lamport = lamport;
      this.authorPubkey = authorPubkey;
      return true;
    }
    return false;
  }

  _isGreater(newTs, newLamp, newAuthor) {
    if (newLamp !== this.lamport) return newLamp > this.lamport;
    if (newTs !== this.timestamp) return newTs > this.timestamp;
    return (newAuthor || '').localeCompare(this.authorPubkey || '') > 0;
  }

  merge(other) {
    if (!other) return false;
    return this.set(other.value, other.timestamp, other.lamport, other.authorPubkey);
  }
}

export class CRDTEngine {
  constructor(meshNetwork, cryptoVault, presenceManager = null) {
    this.mesh = meshNetwork;
    this.vault = cryptoVault;
    this.presence = presenceManager;

    this.lamportClock = 0;
    this.versionVector = new VersionVector();
    this.peerVectors = new Map();

    this.tabId = `tab_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`;
    this.listeners = new Map();

    this.seenContentIds = new GenerationalSlidingCache({ generationSize: 25000, rotateIntervalMs: 90000 });

    this.maxKnownTimestamps = {
      messages: 0,
      threads: 0,
      commits: 0,
      folders: 0,
      deletions: 0,
      folderDeletions: 0
    };

    // Moteurs de Gouvernance BFT & Web of Trust (Pass 4 Hardening - E4)
    this.equivocationEngine = new EquivocationEngine(this.mesh, null, this);
    this.trustEngine = new TrustEngine(this.vault, this.equivocationEngine);
    this.equivocationEngine.setTrustEngine(this.trustEngine);
    this.equivocationEngine.setCRDTEngine(this);

    this.localTabChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pmesh_tab_sync') : null;
    this.initLocalTabSync();

    this.initListeners();

    this._initPromise = this._bootstrap();

    this.antiEntropyTimer = setInterval(() => this._runAntiEntropy(), 25000);
    if (this.antiEntropyTimer?.unref) this.antiEntropyTimer.unref();
    this.gcTimer = setInterval(() => this.compactTombstones(), 60000);
    if (this.gcTimer?.unref) this.gcTimer.unref();
  }

  async _bootstrap() {
    try {
      await Promise.all([
        this.equivocationEngine.init(),
        this.trustEngine.init(),
        this.initLamportClock()
      ]);
      logger.info('CRDT', `🚀 CRDTEngine initialisé (Lamport: ${this.lamportClock}, PeerId: ${this.vault.peerId})`);
    } catch (e) {
      logger.error('CRDT', 'Erreur bootstrap CRDTEngine:', e);
    }
  }

  async ready() {
    return this._initPromise;
  }

  async initLamportClock() {
    try {
      const [msgs, threads, commits, folders, deletions, folderDels] = await Promise.all([
        dbManager.getAll('messages'),
        dbManager.getAll('forum_threads'),
        dbManager.getAll('file_commits'),
        dbManager.getAll('drive_folders'),
        dbManager.getAll('drive_deletions'),
        dbManager.getAll('drive_folder_deletions').catch(() => [])
      ]);

      const maxMsg = msgs.reduce((m, x) => Math.max(m, x.lamport || 0), 0);
      const maxThr = threads.reduce((m, x) => Math.max(m, x.lamport || 0), 0);
      const maxCmt = commits.reduce((m, x) => Math.max(m, x.lamportClock || m), 0);

      this.lamportClock = Math.max(this.lamportClock, maxMsg, maxThr, maxCmt);

      this.maxKnownTimestamps = {
        messages: msgs.reduce((max, m) => Math.max(max, m.timestamp || 0), 0),
        threads: threads.reduce((max, t) => Math.max(max, t.createdAt || 0), 0),
        commits: commits.reduce((max, c) => Math.max(max, c.timestamp || 0), 0),
        folders: folders.reduce((max, f) => Math.max(max, f.createdAt || 0), 0),
        deletions: deletions.reduce((max, d) => Math.max(max, d.timestamp || 0), 0),
        folderDeletions: folderDels.reduce((max, fd) => Math.max(max, fd.deletedAt || 0), 0)
      };

      this.versionVector.set(this.vault.peerId, this.lamportClock);
    } catch (e) {
      logger.debug('CRDT', 'Erreur initLamportClock:', e);
    }
  }

  async _verifyAndFilterIncoming(senderPeerId, authorPubkey, payload, contextKey = null) {
    if (!payload || !authorPubkey) return false;

    // 1. Vérification bannissement & équivocation
    if (this.equivocationEngine.isPeerBanned(authorPubkey)) {
      logger.warn('CRDT', `🚫 Delta rejeté : émetteur ${authorPubkey.substring(0, 12)}... est banni`);
      return false;
    }

    if (contextKey) {
      const isEquivocating = await this.equivocationEngine._checkEquivocation(contextKey, payload);
      if (isEquivocating) {
        logger.error('CRDT', `🚨 Équivocation détectée sur ${contextKey}. Delta rejeté.`);
        return false;
      }
    }

    // 2. Vérification TrustEngine
    const trustTier = this.trustEngine.getTrustTier(authorPubkey);
    if (trustTier === TRUST_TIERS.BLOCKED) {
      logger.warn('CRDT', `🚫 Delta ignoré : clé ${authorPubkey.substring(0, 12)}... bloquée.`);
      return false;
    }

    // 3. Vérification signature ECDSA
    return await CryptoVault.verifyObject(payload);
  }

  tick(receivedLamport = 0) {
    const MAX_ALLOWED_DRIFT = Math.max(50, (this.mesh?.peers?.size || 1) * 10);
    const safeReceived = (typeof receivedLamport === 'number' && Number.isFinite(receivedLamport) && receivedLamport > 0)
      ? Math.min(receivedLamport, this.lamportClock + MAX_ALLOWED_DRIFT)
      : 0;

    this.lamportClock = Math.max(this.lamportClock, safeReceived) + 1;
    this.versionVector.set(this.vault.peerId, this.lamportClock);
    return this.lamportClock;
  }

  _markSeen(id) {
    if (id) this.seenContentIds.addIfNew(id);
  }

  _runAntiEntropy() {
    if (!this.mesh || this.mesh.peers.size === 0) return;
    const peerIds = Array.from(this.mesh.peers.keys());
    const targets = peerIds.sort(() => Math.random() - 0.5).slice(0, 2);
    for (const pid of targets) {
      this.sendSyncRequest(pid).catch(() => {});
    }
  }

  async sendSyncRequest(peerId) {
    this.mesh.sendToPeer(peerId, {
      type: 'CRDT_SYNC_REQ',
      vector: {
        messagesSince: this.maxKnownTimestamps.messages || 0,
        threadsSince: this.maxKnownTimestamps.threads || 0,
        commitsSince: this.maxKnownTimestamps.commits || 0,
        foldersSince: this.maxKnownTimestamps.folders || 0,
        deletionsSince: this.maxKnownTimestamps.deletions || 0,
        folderDeletionsSince: this.maxKnownTimestamps.folderDeletions || 0,
        lamport: this.lamportClock,
        versionVector: this.versionVector.toJSON()
      }
    });
  }

  async handleSyncRequest(peerId, req) {
    const { vector } = req;
    if (!vector) return;

    this.tick(vector.lamport || 0);
    if (vector.versionVector) {
      this.peerVectors.set(peerId, new VersionVector(vector.versionVector));
    }

    const msgSince = vector.messagesSince || 0;
    const thrSince = vector.threadsSince || 0;
    const cmtSince = vector.commitsSince || 0;
    const fldSince = vector.foldersSince || 0;
    const delSince = vector.deletionsSince || 0;
    const fdelSince = vector.folderDeletionsSince || 0;

    const [allMsgs, allThreads, allCommits, allFolders, allDels, allFolderDels] = await Promise.all([
      dbManager.getAll('messages'),
      dbManager.getAll('forum_threads'),
      dbManager.getAll('file_commits'),
      dbManager.getAll('drive_folders'),
      dbManager.getAll('drive_deletions'),
      dbManager.getAll('drive_folder_deletions').catch(() => [])
    ]);

    const newMsgs = allMsgs.filter(m => (m.timestamp || 0) > msgSince).slice(0, 150);
    const newThreads = allThreads.filter(t => (t.createdAt || 0) > thrSince).slice(0, 75);
    const newCommits = allCommits.filter(c => (c.timestamp || 0) > cmtSince).slice(0, 75);
    const newFolders = allFolders.filter(f => (f.createdAt || 0) > fldSince).slice(0, 50);
    const newDeletions = allDels.filter(d => (d.timestamp || 0) > delSince).slice(0, 50);
    const newFolderDeletions = allFolderDels.filter(fd => (fd.deletedAt || 0) > fdelSince).slice(0, 50);

    if (
      newMsgs.length > 0 ||
      newThreads.length > 0 ||
      newCommits.length > 0 ||
      newFolders.length > 0 ||
      newDeletions.length > 0 ||
      newFolderDeletions.length > 0
    ) {
      const deltaObj = {
        messages: newMsgs,
        threads: newThreads,
        commits: newCommits,
        folders: newFolders,
        deletions: newDeletions,
        folderDeletions: newFolderDeletions,
        lamport: this.lamportClock,
        versionVector: this.versionVector.toJSON()
      };

      // Câblage formel de StreamCompressor sur CRDT_SYNC_RESP (Écart E8)
      const compResult = await StreamCompressor.compressJsonIfBeneficial(deltaObj, 256);

      if (compResult.isCompressed) {
        this.mesh.sendToPeer(peerId, {
          type: 'CRDT_SYNC_RESP',
          compressed: true,
          deltaCompressed: compResult.data,
          lamport: this.lamportClock
        });
      } else {
        this.mesh.sendToPeer(peerId, {
          type: 'CRDT_SYNC_RESP',
          compressed: false,
          delta: deltaObj,
          lamport: this.lamportClock
        });
      }
    }
  }

  async handleSyncResponse(resp) {
    let delta = resp.delta;

    // Décompression automatique si compressé (Écart E8)
    if (resp.compressed && resp.deltaCompressed) {
      try {
        delta = await StreamCompressor.decompressJsonPayload(resp.deltaCompressed, true);
      } catch (err) {
        logger.error('CRDT', 'Échec décompression delta CRDT:', err);
        return;
      }
    }

    if (!delta) return;
    this.tick(delta.lamport || resp.lamport || 0);

    const CAP = 5000;
    if (Array.isArray(delta.messages)) {
      const accepted = [];
      for (const msg of delta.messages.slice(0, CAP)) {
        if (await this._verifyAndFilterIncoming(msg.authorId, msg.authorPubkey, msg)) {
          await dbManager.saveMessage(msg);
          this.maxKnownTimestamps.messages = Math.max(this.maxKnownTimestamps.messages, msg.timestamp || 0);
          accepted.push(msg);
        }
      }
      if (accepted.length > 0) this.emit('chat-synced', accepted);
    }

    if (Array.isArray(delta.threads)) {
      const accepted = [];
      for (const thread of delta.threads.slice(0, CAP)) {
        if (await this._mergeForumThread(thread)) {
          this.maxKnownTimestamps.threads = Math.max(this.maxKnownTimestamps.threads, thread.createdAt || 0);
          accepted.push(thread);
        }
      }
      if (accepted.length > 0) this.emit('forum-synced', accepted);
    }

    if (Array.isArray(delta.commits)) {
      const accepted = [];
      for (const commit of delta.commits.slice(0, CAP)) {
        const contextKey = `drive:${commit.fileId}:v${commit.versionNumber || 1}`;
        if (
          (await this._verifyAndFilterIncoming(commit.authorId, commit.authorPubkey, commit, contextKey)) &&
          (await this._isValidCommit(commit))
        ) {
          await dbManager.saveFileCommit(commit);
          this.maxKnownTimestamps.commits = Math.max(this.maxKnownTimestamps.commits, commit.timestamp || 0);
          accepted.push(commit);
        }
      }
      if (accepted.length > 0) this.emit('drive-synced', accepted);
    }

    if (Array.isArray(delta.folders)) {
      const accepted = [];
      for (const folder of delta.folders.slice(0, CAP)) {
        if (await this._verifyAndFilterIncoming(folder.authorId, folder.authorPubkey, folder)) {
          await dbManager.saveDriveFolder(folder);
          this.maxKnownTimestamps.folders = Math.max(this.maxKnownTimestamps.folders, folder.createdAt || 0);
          accepted.push(folder);
        }
      }
      if (accepted.length > 0) this.emit('drive-folder-updated', accepted);
    }

    if (Array.isArray(delta.deletions)) {
      let changed = false;
      for (const tomb of delta.deletions.slice(0, CAP)) {
        if (tomb && tomb.fileId && (await CryptoVault.verifyObject(tomb, { pubkeyField: 'authorPubkey', idField: 'deletedBy' }))) {
          await dbManager.saveFileDeletion(tomb);
          this.maxKnownTimestamps.deletions = Math.max(this.maxKnownTimestamps.deletions, tomb.timestamp || 0);
          changed = true;
        }
      }
      if (changed) this.emit('drive-synced', []);
    }

    if (Array.isArray(delta.folderDeletions)) {
      for (const ftomb of delta.folderDeletions.slice(0, CAP)) {
        if (ftomb && ftomb.path) {
          await dbManager.saveFolderDeletion(ftomb);
          await dbManager.deleteDriveFolder(ftomb.path);
          this.maxKnownTimestamps.folderDeletions = Math.max(this.maxKnownTimestamps.folderDeletions, ftomb.deletedAt || 0);
        }
      }
      this.emit('drive-folder-updated', { deleted: true });
    }
  }

  async compactTombstones(maxInactiveAgeMs = 7 * 86400000) {
    try {
      const now = Date.now();
      const activePeers = new Set([this.vault.peerId]);

      if (this.presence && this.presence.roster) {
        this.presence.roster.forEach((peer, peerId) => {
          if (now - (peer.lastSeen || 0) < maxInactiveAgeMs) {
            activePeers.add(peerId);
          }
        });
      }

      if (activePeers.size <= 1) return { compacted: 0, stableLamport: 0 };

      let minStableClock = this.lamportClock;
      for (const pid of activePeers) {
        if (pid === this.vault.peerId) continue;
        const pVec = this.peerVectors.get(pid);
        const pClock = pVec ? pVec.get(pid) : 0;
        minStableClock = Math.min(minStableClock, pClock);
      }

      const GC_STABILITY_TIME_HORIZON = 24 * 3600 * 1000;
      const cutoffTime = now - GC_STABILITY_TIME_HORIZON;

      const [fileDeletions, folderDeletions] = await Promise.all([
        dbManager.getAll('drive_deletions'),
        dbManager.getAll('drive_folder_deletions').catch(() => [])
      ]);

      let compactedCount = 0;
      for (const del of fileDeletions) {
        if ((del.timestamp || 0) < cutoffTime && (del.lamport || 0) <= minStableClock) {
          await dbManager.delete('drive_deletions', del.fileId);
          compactedCount++;
        }
      }

      for (const fdel of folderDeletions) {
        if ((fdel.deletedAt || 0) < cutoffTime && (fdel.lamport || 0) <= minStableClock) {
          await dbManager.delete('drive_folder_deletions', fdel.path);
          compactedCount++;
        }
      }

      if (compactedCount > 0) {
        logger.info('CRDT', `🧹 Ramasse-miettes (GC) : ${compactedCount} tombstones stabilisés purgés.`);
      }

      return { compacted: compactedCount, stableLamport: minStableClock };
    } catch (err) {
      logger.debug('CRDT', 'Erreur compactTombstones:', err);
      return { compacted: 0, error: err };
    }
  }

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
    this.maxKnownTimestamps.messages = Math.max(this.maxKnownTimestamps.messages, message.timestamp);
    this._markSeen('msg:' + message.id);

    this._broadcastLocalTab('LOCAL_CHAT_MSG', message, clock);
    await this.mesh.broadcast({ type: 'CHAT_MSG', payload: message, lamport: clock });

    return message;
  }

  async handleIncomingChatMessage(envelope) {
    const { payload, lamport } = envelope;
    if (!payload || !payload.id) return false;

    this.tick(lamport || 0);
    if (!(await this._verifyAndFilterIncoming(payload.authorId, payload.authorPubkey, payload))) {
      return false;
    }

    const existing = await dbManager.get('messages', payload.id);
    if (existing) return false;

    await dbManager.saveMessage(payload);
    this.maxKnownTimestamps.messages = Math.max(this.maxKnownTimestamps.messages, payload.timestamp || 0);
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
    this.maxKnownTimestamps.threads = Math.max(this.maxKnownTimestamps.threads, thread.createdAt);
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
    await this.mesh.broadcast({ type: 'FORUM_REPLY', threadId, reply, lamport: clock });

    return reply;
  }

  async _mergeForumThread(incoming) {
    if (!incoming || !incoming.id) return false;
    if (!(await this._verifyAndFilterIncoming(incoming.authorId, incoming.authorPubkey, incoming, null))) {
      return false;
    }

    const existing = await dbManager.get('forum_threads', incoming.id);
    if (!existing) {
      await dbManager.saveForumThread(incoming);
      return true;
    }

    const byId = new Map();
    for (const r of existing.replies || []) byId.set(r.id, r);
    for (const r of incoming.replies || []) {
      if (!byId.has(r.id) && (await CryptoVault.verifyObject(r))) {
        byId.set(r.id, r);
      }
    }

    const mergedReplies = Array.from(byId.values()).sort((a, b) => {
      if ((a.createdAt || 0) !== (b.createdAt || 0)) return (a.createdAt || 0) - (b.createdAt || 0);
      if ((a.lamport || 0) !== (b.lamport || 0)) return (a.lamport || 0) - (b.lamport || 0);
      return (a.id || '').localeCompare(b.id || '');
    });

    const merged = { ...existing, replies: mergedReplies };
    await dbManager.saveForumThread(merged);
    return true;
  }

  async broadcastDriveCommit(commit) {
    const clock = this.tick();
    const signed = { ...commit };
    signed.authorPubkey = this.vault.publicKeyHex;
    signed.authorId = this.vault.peerId;
    signed.lamportClock = clock;
    signed.signature = await this.vault.sign(signed, ['commitId']);

    await dbManager.saveFileCommit(signed);
    this.maxKnownTimestamps.commits = Math.max(this.maxKnownTimestamps.commits, signed.timestamp || Date.now());
    this._markSeen('cmt:' + signed.commitId);

    this._broadcastLocalTab('LOCAL_DRIVE_COMMIT', signed, clock);
    await this.mesh.broadcast({ type: 'DRIVE_COMMIT_BROADCAST', payload: signed, lamport: clock });
    return signed;
  }

  async broadcastFolderCreate(folderObj) {
    const clock = this.tick();
    const signed = { ...folderObj };
    signed.authorPubkey = this.vault.publicKeyHex;
    signed.authorId = this.vault.peerId;
    signed.lamport = clock;
    signed.signature = await this.vault.sign(signed);

    await dbManager.saveDriveFolder(signed);
    this.maxKnownTimestamps.folders = Math.max(this.maxKnownTimestamps.folders, signed.createdAt || Date.now());
    this._markSeen('fdc:' + signed.path + ':' + (signed.createdAt || ''));

    this._broadcastLocalTab('LOCAL_DRIVE_FOLDER_UPDATED', signed, clock);
    await this.mesh.broadcast({ type: 'DRIVE_FOLDER_CREATE', folder: signed, lamport: clock });
    return signed;
  }

  async broadcastCreateFolder(folderObj) {
    return this.broadcastFolderCreate(folderObj);
  }

  async broadcastDeleteFolder(folderPath) {
    const clock = this.tick();
    const op = {
      folderPath,
      op: 'delete',
      authorId: this.vault.peerId,
      authorPubkey: this.vault.publicKeyHex,
      timestamp: Date.now(),
      lamport: clock
    };
    op.signature = await this.vault.sign(op);
    this._markSeen('foldel:' + folderPath + ':' + op.timestamp);

    await dbManager.saveFolderDeletion({
      path: folderPath,
      deletedBy: op.authorId,
      deletedAt: op.timestamp,
      lamport: clock,
      signature: op.signature
    });
    await dbManager.deleteDriveFolder(folderPath);

    this._broadcastLocalTab('LOCAL_DRIVE_FOLDER_UPDATED', { path: folderPath, deleted: true }, clock);
    await this.mesh.broadcast({ type: 'DRIVE_FOLDER_DELETE', folderPath, op, lamport: clock });
    return op;
  }

  async broadcastDeleteFile(fileId, authorName) {
    const clock = this.tick();
    const op = {
      fileId,
      op: 'delete-file',
      authorName: authorName || this.vault.userName,
      authorId: this.vault.peerId,
      authorPubkey: this.vault.publicKeyHex,
      timestamp: Date.now(),
      lamport: clock
    };
    op.signature = await this.vault.sign(op);

    await dbManager.saveFileDeletion({
      fileId,
      deletedBy: op.authorName,
      timestamp: op.timestamp,
      lamport: clock,
      signature: op.signature,
      authorPubkey: op.authorPubkey
    });
    this.maxKnownTimestamps.deletions = Math.max(this.maxKnownTimestamps.deletions, op.timestamp);
    this._markSeen('fdel:' + fileId + ':' + op.timestamp);

    this._broadcastLocalTab('LOCAL_DRIVE_FILE_DELETED', { fileId }, clock);
    await this.mesh.broadcast({ type: 'DRIVE_FILE_DELETE', fileId, op, lamport: clock });
    return op;
  }

  async _isValidCommit(commit) {
    if (!commit || typeof commit.commitId !== 'string' || typeof commit.fileId !== 'string' || !Array.isArray(commit.chunks)) {
      return false;
    }
    if (commit.chunks.length > 0 && commit.rootMerkleHash) {
      const computedRoot = await MerkleTree.computeRoot(commit.chunks.map(c => c.hash));
      if (computedRoot !== commit.rootMerkleHash) {
        logger.warn('CRDT', `Commit ${commit.commitId} rejeté: racine Merkle invalide`);
        return false;
      }
    }
    return true;
  }

  _relayableId(m) {
    switch (m.type) {
      case 'CHAT_MSG': return m.payload?.id ? 'msg:' + m.payload.id : null;
      case 'FORUM_TOPIC': return m.payload?.id ? 'thr:' + m.payload.id : null;
      case 'FORUM_REPLY': return m.reply?.id ? 'rep:' + m.reply.id : null;
      case 'DRIVE_COMMIT_BROADCAST': return m.payload?.commitId ? 'cmt:' + m.payload.commitId : null;
      case 'DRIVE_FOLDER_CREATE': return m.folder?.path ? 'fdc:' + m.folder.path + ':' + (m.folder.createdAt || '') : null;
      case 'DRIVE_FILE_DELETE': return m.fileId && m.op ? 'fdel:' + m.fileId + ':' + (m.op.timestamp || '') : null;
      case 'DRIVE_FOLDER_DELETE': return m.folderPath && m.op ? 'foldel:' + m.folderPath + ':' + (m.op.timestamp || '') : null;
      default: return null;
    }
  }

  initListeners() {
    this.mesh.on('message-received', async ({ peerId, message }) => {
      try {
        const cid = this._relayableId(message);
        if (cid) {
          const isNew = this.seenContentIds.addIfNew(cid);
          if (isNew) {
            this.mesh.peers.forEach((peer, otherId) => {
              if (otherId !== peerId) this.mesh.sendToPeer(otherId, message);
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
            if (await this._mergeForumThread(message.payload)) {
              this.emit('forum-topic-received', message.payload);
            }
            break;
          case 'FORUM_REPLY':
            if (message.threadId && message.reply) {
              const thr = await dbManager.get('forum_threads', message.threadId);
              if (thr && (await this._verifyAndFilterIncoming(message.reply.authorId, message.reply.authorPubkey, message.reply))) {
                if (!thr.replies.some(r => r.id === message.reply.id)) {
                  thr.replies.push(message.reply);
                  await dbManager.saveForumThread(thr);
                  this.emit('forum-reply-received', { threadId: message.threadId, reply: message.reply });
                }
              }
            }
            break;
          case 'DRIVE_COMMIT_BROADCAST': {
            const commit = message.payload;
            const contextKey = `drive:${commit?.fileId}:v${commit?.versionNumber || 1}`;
            if (
              commit &&
              (await this._verifyAndFilterIncoming(commit.authorId, commit.authorPubkey, commit, contextKey)) &&
              (await this._isValidCommit(commit))
            ) {
              await dbManager.saveFileCommit(commit);
              this.emit('drive-commit-received', commit);
            }
            break;
          }
          case 'DRIVE_FOLDER_CREATE':
            if (message.folder && (await this._verifyAndFilterIncoming(message.folder.authorId, message.folder.authorPubkey, message.folder))) {
              await dbManager.saveDriveFolder(message.folder);
              this.emit('drive-folder-updated', message.folder);
            }
            break;
          case 'DRIVE_FOLDER_DELETE':
            if (message.folderPath && message.op && (await CryptoVault.verifyObject(message.op))) {
              await dbManager.saveFolderDeletion({
                path: message.folderPath,
                deletedBy: message.op.authorId,
                deletedAt: message.op.timestamp || Date.now(),
                signature: message.op.signature
              });
              await dbManager.deleteDriveFolder(message.folderPath);
              this.emit('drive-folder-updated', { path: message.folderPath, deleted: true });
            }
            break;
          case 'DRIVE_FILE_DELETE':
            if (message.fileId && message.op && (await CryptoVault.verifyObject(message.op))) {
              await dbManager.saveFileDeletion({
                fileId: message.fileId,
                deletedBy: message.op.authorName || 'inconnu',
                timestamp: message.op.timestamp || Date.now(),
                signature: message.op.signature,
                authorPubkey: message.op.authorPubkey
              });
              this.emit('drive-file-deleted', { fileId: message.fileId });
            }
            break;
          case 'EQUIVOCATION_PROOF_BROADCAST':
          case 'EQUIVOCATION_PROOF':
            if (message.proof) {
              await this.equivocationEngine.handleIncomingFraudProof(message.proof);
            }
            break;
        }
      } catch (err) {
        logger.error('CRDT', 'Erreur traitement message entrant:', err);
      }
    });

    this.mesh.on('peer-ready', (peerId) => {
      this.sendSyncRequest(peerId).catch(() => {});
    });
  }

  /**
   * Purge de sécurité des données d'un auteur banni/slashed (Pass 4 Hardening)
   */
  async purgeAuthorData(bannedPubkey) {
    if (!bannedPubkey) return;
    logger.warn('CRDT', `🧹 Purge de sécurité des deltas authored par la clé bannie ${bannedPubkey.substring(0, 12)}...`);
    try {
      const allMsgs = await dbManager.getAll('messages').catch(() => []);
      for (const msg of allMsgs) {
        if (msg.authorPubkey === bannedPubkey) {
          await dbManager.delete('messages', msg.id);
        }
      }
      const allCommits = await dbManager.getAll('file_commits').catch(() => []);
      for (const cmt of allCommits) {
        if (cmt.authorPubkey === bannedPubkey) {
          await dbManager.delete('file_commits', cmt.commitId);
        }
      }
    } catch (err) {
      logger.debug('CRDT', 'Erreur lors de la purge de quarantaine:', err);
    }
  }

  initLocalTabSync() {
    if (!this.localTabChannel) return;
    this.localTabChannel.onmessage = (event) => {
      const { type, payload, lamport, sourceTabId } = event.data || {};
      if (sourceTabId === this.tabId) return;

      this.tick(lamport || 0);
      switch (type) {
        case 'LOCAL_CHAT_MSG':
          if (payload?.id) {
            this._markSeen('msg:' + payload.id);
            this.emit('chat-message-received', payload);
          }
          break;
        case 'LOCAL_FORUM_TOPIC':
          if (payload?.id) {
            this._markSeen('thr:' + payload.id);
            this.emit('forum-topic-received', payload);
          }
          break;
        case 'LOCAL_FORUM_REPLY':
          if (payload?.reply) {
            this._markSeen('rep:' + payload.reply.id);
            this.emit('forum-reply-received', payload);
          }
          break;
        case 'LOCAL_DRIVE_COMMIT':
          if (payload?.commitId) {
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
        logger.debug('CRDT', 'Erreur BroadcastChannel:', e);
      }
    }
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const cbs = this.listeners.get(event);
    if (cbs) cbs.forEach(cb => cb(data));
  }

  destroy() {
    if (this.antiEntropyTimer) clearInterval(this.antiEntropyTimer);
    if (this.gcTimer) clearInterval(this.gcTimer);
    if (this.localTabChannel) {
      try { this.localTabChannel.close(); } catch {}
    }
    this.listeners.clear();
  }
}
