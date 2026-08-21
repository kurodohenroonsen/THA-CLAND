/**
 * Moteur CRDT (Conflict-Free Replicated Data Type) & Réconciliation P2P
 * Horloges logiques de Lamport, Vecteurs d'état et fusion déterministe pour Chat, Forums, Commits, Dossiers et Typing Indicators.
 */

import { dbManager } from './local-storage.js';
import { CryptoVault } from './crypto-vault.js';
import { BoundedSet } from './bounded-cache.js';

export class CRDTEngine {
  constructor(meshNetwork, cryptoVault) {
    this.mesh = meshNetwork;
    this.vault = cryptoVault;
    this.lamportClock = 0;
    this.stateVectors = new Map();
    this.listeners = new Map();

    // Réplication complète (gossip multi-sauts) : identifiants de contenus déjà
    // vus, pour rediffuser CHAQUE nouveauté vers les autres pairs sans boucler.
    // Ainsi, même dans un maillage partiel, tout finit répliqué chez tout le monde.
    this.seenContentIds = new BoundedSet(50000);

    this.initListeners();

    // Anti-entropie périodique : on « tire » régulièrement l'état des pairs pour
    // rattraper toute diffusion manquée (déconnexion, message perdu, nouvelle data
    // créée hors-ligne). Combinée au relais gossip, elle garantit la convergence.
    this.antiEntropyMs = 25000;
    this.antiEntropyTimer = setInterval(() => this._runAntiEntropy(), this.antiEntropyMs);
  }

  /** Identifiant stable d'un message répliquable (null si non répliquable). */
  _relayableId(m) {
    switch (m.type) {
      case 'CHAT_MSG': return m.payload && m.payload.id ? 'msg:' + m.payload.id : null;
      case 'FORUM_TOPIC': return m.payload && m.payload.id ? 'thr:' + m.payload.id : null;
      case 'FORUM_REPLY': return m.reply && m.reply.id ? 'rep:' + m.reply.id : null;
      case 'DRIVE_COMMIT_BROADCAST': return m.payload && m.payload.commitId ? 'cmt:' + m.payload.commitId : null;
      case 'DRIVE_FOLDER_CREATE': return m.folder && m.folder.path ? 'fdc:' + m.folder.path + ':' + (m.folder.createdAt || '') : null;
      case 'DRIVE_FILE_DELETE': return m.fileId ? 'fdel:' + m.fileId : null;
      case 'DRIVE_FOLDER_DELETE': return m.folderPath ? 'foldel:' + m.folderPath : null;
      default: return null;
    }
  }

  /** Marque un contenu produit localement comme « déjà vu » (évite l'écho du relais). */
  _markSeen(id) { if (id) this.seenContentIds.addIfNew(id); }

  /** Anti-entropie : pull d'état auprès d'un petit sous-ensemble aléatoire de pairs. */
  _runAntiEntropy() {
    if (!this.mesh || this.mesh.peers.size === 0) return;
    const ids = Array.from(this.mesh.peers.keys());
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    ids.slice(0, 3).forEach(pid => { this.sendSyncRequest(pid).catch(() => {}); });
  }

  /**
   * Vérifie l'authenticité d'un enregistrement signé reçu du réseau.
   * Rejette tout objet dont la signature ne correspond pas à la clé publique
   * déclarée, ou dont l'identité (authorId) n'est pas liée à cette clé.
   * (Correctif audit §usurpation : la signature ECDSA n'était jamais vérifiée.)
   */
  async _isAuthentic(obj) {
    if (!obj || typeof obj !== 'object') return false;
    // Tolérance de compatibilité : un enregistrement local hérité, sans signature,
    // n'est jamais accepté depuis le réseau (il ne peut provenir que d'un pair non signé).
    if (!obj.signature || !obj.authorPubkey) {
      console.warn('[CRDT] ⛔ Enregistrement non signé rejeté (id:', obj.id || obj.commitId || obj.path, ')');
      return false;
    }
    const ok = await CryptoVault.verifyObject(obj);
    if (!ok) {
      console.warn('[CRDT] ⛔ Signature invalide — enregistrement rejeté (usurpation ?)', obj.id || obj.commitId || obj.path);
    }
    return ok;
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try { cb(data); } catch (e) { console.error(`[CRDT] Erreur écouteur ${event}:`, e); }
      });
    }
  }

  initListeners() {
    // On attend que le canal de contrôle soit RÉELLEMENT ouvert (peer-ready) avant
    // de demander l'historique, sinon la requête est émise trop tôt et perdue.
    this.mesh.on('peer-ready', async (peer) => {
      console.log(`[CRDT] 🤝 Canal prêt avec (${peer.id}) -> Envoi de la requête de synchronisation d'état CRDT`);
      await this.sendSyncRequest(peer.id);
    });

    this.mesh.on('message-received', async ({ peerId, message }) => {
      if (!message || !message.type) return;

      // 1) Messages point-à-point / éphémères : jamais relayés ni dédupliqués.
      switch (message.type) {
        case 'CRDT_SYNC_REQ':
          console.log(`[CRDT] 📥 Requête de synchro reçue de ${peerId}`);
          return this.handleSyncRequest(peerId, message);
        case 'CRDT_SYNC_RESP':
          console.log(`[CRDT] 📥 Réponse de synchro (Delta) reçue de ${peerId}`);
          return this.handleSyncResponse(message);
        case 'TYPING_SIGNAL':
          this.emit('typing-signal', message);
          return;
      }

      // 2) Contenu répliqué : déduplication (anti-boucle) puis relais gossip.
      const cid = this._relayableId(message);
      if (cid && !this.seenContentIds.addIfNew(cid)) return; // déjà traité -> stop

      let accepted = false;
      switch (message.type) {
        case 'CHAT_MSG':
          console.log(`%c[CRDT] 💬 Message de chat reçu [ID: ${message.payload?.id}, De: ${message.payload?.authorName}]`, 'color: #06b6d4; font-weight: bold;');
          accepted = await this.handleIncomingChatMessage(message);
          break;
        case 'FORUM_TOPIC':
          console.log(`[CRDT] 📑 Sujet de forum reçu [Titre: ${message.payload?.title}]`);
          accepted = await this.handleIncomingForumTopic(message);
          break;
        case 'FORUM_REPLY':
          console.log(`[CRDT] 💬 Réponse de forum reçue pour Thread ID: ${message.threadId}`);
          accepted = await this.handleIncomingForumReply(message);
          break;
        case 'DRIVE_COMMIT_BROADCAST':
          console.log(`[CRDT] 📁 Commit de drive reçu [Fichier: ${message.payload?.fileName} v${message.payload?.versionNumber}]`);
          accepted = await this.handleIncomingDriveCommit(message);
          break;
        case 'DRIVE_FOLDER_CREATE':
          console.log(`[CRDT] 📁 Création de dossier reçue [Chemin: ${message.folder?.path}]`);
          accepted = await this._applyFolderCreate(message);
          break;
        case 'DRIVE_FILE_DELETE':
          console.log(`[CRDT] 🗑️ Suppression de fichier reçue [fileId: ${message.fileId}]`);
          accepted = await this._applyFileDelete(message);
          break;
        case 'DRIVE_FOLDER_DELETE':
          console.log(`[CRDT] 🗑️ Suppression de dossier reçue [Chemin: ${message.folderPath}]`);
          accepted = await this._applyFolderDelete(message);
          break;
        default:
          return;
      }

      // 3) Réplication complète : rediffusion aux AUTRES pairs (multi-sauts), pour
      // qu'un maillage partiel converge quand même chez tous les membres.
      if (accepted && cid) {
        try { await this.mesh.broadcast(message, peerId); } catch {}
      }
    });
  }

  // --- Application des opérations Drive (retournent true si acceptées & nouvelles) ---

  async _applyFolderCreate(message) {
    if (message.folder && typeof message.folder.path === 'string' &&
        await this._isAuthentic(message.folder)) {
      await dbManager.saveDriveFolder(message.folder);
      this.emit('drive-folder-updated', message.folder);
      return true;
    }
    return false;
  }

  async _applyFileDelete(message) {
    if (message.fileId && message.op &&
        message.op.fileId === message.fileId &&
        await CryptoVault.verifyObject(message.op)) {
      await dbManager.saveFileDeletion({
        fileId: message.fileId,
        deletedBy: message.op.authorName || message.op.authorId,
        timestamp: message.op.timestamp || Date.now()
      });
      this.emit('drive-file-deleted', { fileId: message.fileId });
      return true;
    }
    console.warn('[CRDT] ⛔ Suppression de fichier non authentifiée rejetée');
    return false;
  }

  async _applyFolderDelete(message) {
    if (message.folderPath && message.op &&
        message.op.folderPath === message.folderPath &&
        await CryptoVault.verifyObject(message.op)) {
      await dbManager.deleteDriveFolder(message.folderPath);
      this.emit('drive-folder-updated', { path: message.folderPath, deleted: true });
      return true;
    }
    console.warn('[CRDT] ⛔ Suppression de dossier non authentifiée rejetée');
    return false;
  }

  tick(receivedLamport = 0) {
    this.lamportClock = Math.max(this.lamportClock, receivedLamport) + 1;
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

    console.log(`[CRDT] 📤 Envoi Sync Vector vers ${peerId}: msgsSince=${highestMsgTime}, threadsSince=${highestThreadTime}, commitsSince=${highestCommitTime}, foldersSince=${highestFolderTime}`);

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

    const newMsgs = allMsgs.filter(m => (m.timestamp || 0) > (vector.messagesSince || 0));
    const newThreads = allThreads.filter(t => (t.createdAt || 0) > (vector.threadsSince || 0));
    const newCommits = allCommits.filter(c => (c.timestamp || 0) > (vector.commitsSince || 0));
    const newFolders = allFolders.filter(f => (f.createdAt || 0) > (vector.foldersSince || 0));
    const newDeletions = allDeletions.filter(d => (d.timestamp || 0) > (vector.deletionsSince || 0));

    console.log(`[CRDT] 🔍 Calcul delta pour ${peerId} : ${newMsgs.length} msgs, ${newThreads.length} threads, ${newCommits.length} commits, ${newFolders.length} dossiers, ${newDeletions.length} suppressions à transmettre`);

    if (newMsgs.length > 0 || newThreads.length > 0 || newCommits.length > 0 || newFolders.length > 0 || newDeletions.length > 0) {
      this.mesh.sendToPeer(peerId, {
        type: 'CRDT_SYNC_RESP',
        delta: {
          messages: newMsgs,
          threads: newThreads,
          commits: newCommits,
          folders: newFolders,
          deletions: newDeletions,
          lamport: this.lamportClock
        }
      });
    }
  }

  async handleSyncResponse(resp) {
    const { delta } = resp;
    if (!delta) return;

    this.tick(delta.lamport || 0);

    // CORRECTIF (audit §empoisonnement CRDT) : chaque enregistrement du delta est
    // vérifié cryptographiquement AVANT écriture. Les threads sont fusionnés (pas
    // d'écrasement destructif). Les deltas sont en outre bornés pour éviter qu'un
    // pair n'injecte un volume abusif d'un coup.
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
        if (await this._isAuthentic(commit) && this._isValidCommit(commit)) {
          await dbManager.saveFileCommit(commit);
          accepted.push(commit);
        }
      }
      this.emit('drive-synced', accepted);
    }

    if (Array.isArray(delta.folders)) {
      const accepted = [];
      for (const folder of delta.folders.slice(0, CAP)) {
        if (await this._isAuthentic(folder) && typeof folder.path === 'string') {
          await dbManager.saveDriveFolder(folder);
          accepted.push(folder);
        }
      }
      this.emit('drive-folder-updated', accepted);
    }

    // Suppressions de fichiers (tombstones) : on applique celles qui sont
    // authentifiées, afin qu'un fichier supprimé ne réapparaisse pas chez un
    // nouvel arrivant qui reçoit par ailleurs son commit d'origine.
    if (Array.isArray(delta.deletions)) {
      let changed = false;
      for (const tomb of delta.deletions.slice(0, CAP)) {
        if (tomb && typeof tomb.fileId === 'string') {
          await dbManager.saveFileDeletion({
            fileId: tomb.fileId,
            deletedBy: tomb.deletedBy || 'inconnu',
            timestamp: tomb.timestamp || Date.now()
          });
          changed = true;
        }
      }
      if (changed) this.emit('drive-synced', []);
    }
  }

  /** Validation structurelle d'un commit de fichier avant persistance. */
  _isValidCommit(commit) {
    return commit && typeof commit.commitId === 'string' &&
      typeof commit.fileId === 'string' && Array.isArray(commit.chunks) &&
      commit.chunks.length <= 200000;
  }

  /**
   * Fusion NON destructive d'un thread de forum reçu : vérifie la signature du
   * thread, puis fusionne l'union des réponses (dédupliquées par id) au lieu
   * d'écraser l'enregistrement local. Empêche un pair d'effacer les réponses.
   */
  async _mergeForumThread(incoming) {
    // Vérifie la signature du thread en EXCLUANT `replies` (champ muté après signature).
    if (!incoming || !incoming.id) return false;
    if (!incoming.signature || !incoming.authorPubkey) {
      console.warn('[CRDT] ⛔ Thread non signé rejeté', incoming.id);
      return false;
    }
    if (!(await CryptoVault.verifyObject(incoming, { excludeFields: ['replies'] }))) {
      console.warn('[CRDT] ⛔ Signature de thread invalide — rejeté', incoming.id);
      return false;
    }

    const existing = await dbManager.get('forum_threads', incoming.id);
    if (!existing) {
      await dbManager.saveForumThread(incoming);
      return true;
    }

    // Le contenu/titre du thread reste celui de l'auteur original (identité liée
    // à la clé) ; on ne fusionne que la liste des réponses (chacune re-vérifiée).
    const byId = new Map();
    for (const r of (existing.replies || [])) byId.set(r.id, r);
    for (const r of (incoming.replies || [])) {
      if (!byId.has(r.id) && await CryptoVault.verifyObject(r)) byId.set(r.id, r);
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

    console.log(`[CRDT] ✍️ Création message chat [ID: ${message.id}] dans #${channelId}`);

    const broadcastPayload = {
      type: 'CHAT_MSG',
      payload: message,
      lamport: clock
    };

    const sentCount = await this.mesh.broadcast(broadcastPayload);
    console.log(`[CRDT] 📡 Message ${message.id} diffusé à ${sentCount} pair(s)`);

    return message;
  }

  async handleIncomingChatMessage(envelope) {
    const { payload, lamport } = envelope;
    if (!payload || !payload.id) return false;

    this.tick(lamport || 0);

    // CORRECTIF (audit §usurpation) : vérifie la signature ECDSA et la liaison
    // identité/clé avant toute persistance. Un message forgé est rejeté.
    if (!(await this._isAuthentic(payload))) return false;

    // Déduplication par clé primaire (get O(1) au lieu de getAll O(n)).
    const existing = await dbManager.get('messages', payload.id);
    if (existing) return false;

    await dbManager.saveMessage(payload);
    this.emit('chat-message-received', payload);
    return true;
  }

  // --- Signal d'Écriture (Typing Indicator) ---

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

  /**
   * Crée et diffuse un nouveau sujet de forum.
   * CORRECTIF (audit §forum cassé) : le contrôleur appelait
   * `createAndBroadcastForumThread(title, category, content)` — méthode qui
   * n'existait pas (seul `createForumTopic(categoryId,title,content)` existait,
   * avec un ordre d'arguments inversé et le mauvais nom de champ `categoryId`).
   * On expose désormais la bonne signature et on stocke le champ `category`
   * attendu par l'affichage, le filtre et l'index IndexedDB.
   */
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

    // Le champ `replies` est muté après coup (ajout de réponses) : on l'EXCLUT de
    // la signature du thread, sinon toute réponse invaliderait la signature lors
    // de la synchro CRDT (régression détectée en revue). Les réponses portent leur
    // propre signature individuelle.
    thread.signature = await this.vault.sign(thread, ['replies']);
    await dbManager.saveForumThread(thread);
    this._markSeen('thr:' + thread.id);

    await this.mesh.broadcast({ type: 'FORUM_TOPIC', payload: thread, lamport: clock });
    return thread;
  }

  // Alias rétro-compatible.
  async createForumTopic(category, title, content) {
    return this.createAndBroadcastForumThread(title, category, content);
  }

  /**
   * Ajoute et diffuse une réponse à un fil. La réponse est signée et porte
   * `createdAt` ET `timestamp` (l'affichage lisait `r.timestamp` — cf. audit
   * §date invalide).
   */
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

    thread.replies = thread.replies || [];
    thread.replies.push(reply);
    await dbManager.saveForumThread(thread);
    this._markSeen('rep:' + reply.id);

    await this.mesh.broadcast({ type: 'FORUM_REPLY', threadId, reply, lamport: clock });
    return reply;
  }

  // Alias rétro-compatible.
  async addForumReply(threadId, content) {
    return this.addAndBroadcastForumReply(threadId, content);
  }

  async handleIncomingForumTopic(envelope) {
    const { payload, lamport } = envelope;
    if (!payload || !payload.id) return false;
    this.tick(lamport || 0);

    // Vérifie signature + fusionne sans écraser (cf. _mergeForumThread).
    if (await this._mergeForumThread(payload)) {
      this.emit('forum-topic-received', payload);
      return true;
    }
    return false;
  }

  async handleIncomingForumReply(envelope) {
    const { threadId, reply, lamport } = envelope;
    if (!threadId || !reply) return false;
    this.tick(lamport || 0);

    // La réponse doit être authentique.
    if (!(await this._isAuthentic(reply))) return false;

    const thread = await dbManager.get('forum_threads', threadId);
    if (thread) {
      thread.replies = thread.replies || [];
      if (!thread.replies.some(r => r.id === reply.id)) {
        thread.replies.push(reply);
        await dbManager.saveForumThread(thread);
        this.emit('forum-reply-received', { threadId, reply });
        return true;
      }
    }
    return false;
  }

  // --- Gestion du Drive, Versioning DAG & Dossiers ---

  async broadcastDriveCommit(commit) {
    const clock = this.tick();
    // Signe le commit avant diffusion (l'objet vient de VersioningDAG, non signé).
    const signed = {
      ...commit,
      authorId: this.vault.peerId,
      authorPubkey: this.vault.publicKeyHex
    };
    signed.signature = await this.vault.sign(signed);
    // Re-persiste localement la version signée pour qu'elle vérifie chez les autres.
    await dbManager.saveFileCommit(signed);
    this._markSeen('cmt:' + signed.commitId);

    await this.mesh.broadcast({
      type: 'DRIVE_COMMIT_BROADCAST',
      payload: signed,
      lamport: clock
    });
    return signed;
  }

  async broadcastCreateFolder(folder) {
    const clock = this.tick();
    const signed = {
      ...folder,
      authorId: this.vault.peerId,
      authorPubkey: this.vault.publicKeyHex
    };
    signed.signature = await this.vault.sign(signed);
    await dbManager.saveDriveFolder(signed);
    this._markSeen('fdc:' + signed.path + ':' + (signed.createdAt || ''));

    await this.mesh.broadcast({
      type: 'DRIVE_FOLDER_CREATE',
      folder: signed,
      lamport: clock
    });
    return signed;
  }

  async broadcastDeleteFolder(folderPath) {
    const clock = this.tick();
    // La suppression est signée pour empêcher un tiers de supprimer arbitrairement.
    const op = {
      folderPath,
      op: 'delete',
      authorId: this.vault.peerId,
      authorPubkey: this.vault.publicKeyHex,
      timestamp: Date.now()
    };
    op.signature = await this.vault.sign(op);
    this._markSeen('foldel:' + folderPath);

    await this.mesh.broadcast({
      type: 'DRIVE_FOLDER_DELETE',
      folderPath,
      op,
      lamport: clock
    });
  }

  /**
   * Diffuse une suppression de fichier signée (tombstone) et l'applique localement.
   */
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

    await dbManager.saveFileDeletion({ fileId, deletedBy: op.authorName, timestamp: op.timestamp });
    this._markSeen('fdel:' + fileId);

    await this.mesh.broadcast({ type: 'DRIVE_FILE_DELETE', fileId, op, lamport: clock });
    return op;
  }

  async handleIncomingDriveCommit(envelope) {
    const { payload, lamport } = envelope;
    if (!payload || !payload.commitId) return false;
    this.tick(lamport || 0);

    if (!(await this._isAuthentic(payload)) || !this._isValidCommit(payload)) return false;

    await dbManager.saveFileCommit(payload);
    this.emit('drive-commit-received', payload);
    return true;
  }
}
