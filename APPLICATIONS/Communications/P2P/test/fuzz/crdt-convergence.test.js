/**
 * test/fuzz/crdt-convergence.test.js
 * 
 * SUITE DE FUZZING & TESTS PAR PROPRIÉTÉS (PROPERTY-BASED TESTING) - 2025/2026
 * Vérification formelle de la Convergence Forte (Strong Eventual Consistency),
 * de l'Idempotence, de la Confluence et de l'Immunité à la Résurrection de Tombstones.
 * 
 * Exécution : node test/fuzz/crdt-convergence.test.js
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

class SeededRandom {
  constructor(seed = 0x1337cafe) {
    this.seed = seed >>> 0;
  }
  next() {
    let t = (this.seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  nextInt(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick(array) {
    if (!array || array.length === 0) return null;
    return array[this.nextInt(0, array.length - 1)];
  }
  shuffle(array) {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}

class MockCryptoVault {
  constructor(peerId, userName) {
    this.peerId = peerId;
    this.userName = userName;
    this.publicKeyHex = `pub_${peerId}_${crypto.randomBytes(4).toString('hex')}`;
  }

  static canonicalize(obj, excludeKeys = []) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(x => MockCryptoVault.canonicalize(x, excludeKeys)).join(',')}]`;
    const keys = Object.keys(obj).filter(k => !excludeKeys.includes(k)).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${MockCryptoVault.canonicalize(obj[k], excludeKeys)}`).join(',')}}`;
  }

  static hashSHA256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  async sign(obj, excludeKeys = ['signature']) {
    const canon = MockCryptoVault.canonicalize(obj, excludeKeys);
    return MockCryptoVault.hashSHA256(`sig_${this.peerId}_${canon}`);
  }

  static async verifyObject(obj, { excludeFields = ['signature'] } = {}) {
    if (!obj || !obj.signature) return false;
    return true;
  }
}

class MerkleTree {
  static async buildTree(leafHashes) {
    if (!leafHashes || leafHashes.length === 0) {
      return { root: MockCryptoVault.hashSHA256(''), layers: [[]] };
    }
    const layers = [leafHashes];
    let currentLayer = leafHashes;
    while (currentLayer.length > 1) {
      const nextLayer = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = (i + 1 < currentLayer.length) ? currentLayer[i + 1] : left;
        const parentHash = MockCryptoVault.hashSHA256(`01:${left}:${right}`);
        nextLayer.push(parentHash);
      }
      layers.push(nextLayer);
      currentLayer = nextLayer;
    }
    return { root: currentLayer[0], layers };
  }

  static async computeRoot(leafHashes) {
    const { root } = await MerkleTree.buildTree(leafHashes);
    return root;
  }

  static generateProof(leafIndex, layers) {
    if (!layers || layers.length <= 1) return [];
    const proof = [];
    let idx = leafIndex;
    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const layer = layers[layerIdx];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : (idx + 1 < layer.length ? idx + 1 : idx);
      proof.push({ position: isRight ? 'left' : 'right', hash: layer[siblingIdx] });
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  static async verifyProof(leafHash, proof, rootHash) {
    if (!proof || proof.length === 0) return leafHash === rootHash;
    let currentHash = leafHash;
    for (const step of proof) {
      const left = step.position === 'left' ? step.hash : currentHash;
      const right = step.position === 'left' ? currentHash : step.hash;
      currentHash = MockCryptoVault.hashSHA256(`01:${left}:${right}`);
    }
    return currentHash === rootHash;
  }
}

class MockLocalStorage {
  constructor() {
    this.messages = new Map();
    this.forumThreads = new Map();
    this.fileCommits = new Map();
    this.driveFolders = new Map();
    this.driveDeletions = new Map();
    this.driveFolderDeletions = new Map();
  }

  async saveMessage(msg) { this.messages.set(msg.id, { ...msg }); }
  async getMessage(id) { return this.messages.get(id); }
  async getAllMessages() { return Array.from(this.messages.values()); }

  async saveForumThread(thread) { this.forumThreads.set(thread.id, JSON.parse(JSON.stringify(thread))); }
  async getForumThread(id) { return this.forumThreads.get(id) ? JSON.parse(JSON.stringify(this.forumThreads.get(id))) : null; }
  async getAllForumThreads() { return Array.from(this.forumThreads.values()); }

  async saveFileCommit(commit) { this.fileCommits.set(commit.commitId, { ...commit }); }
  async getAllFileCommits() { return Array.from(this.fileCommits.values()); }

  async saveDriveFolder(folder) { this.driveFolders.set(folder.path, { ...folder }); }
  async deleteDriveFolder(path) { this.driveFolders.delete(path); }
  async getAllDriveFolders() { return Array.from(this.driveFolders.values()); }

  async saveFolderDeletion(tombstone) { this.driveFolderDeletions.set(tombstone.path, { ...tombstone }); }
  async getDeletedFolderPaths() { return new Set(this.driveFolderDeletions.keys()); }
  async getAllFolderDeletions() { return Array.from(this.driveFolderDeletions.values()); }

  async saveFileDeletion(tombstone) { this.driveDeletions.set(tombstone.fileId, { ...tombstone }); }
  async getDeletedFileIds() { return new Set(this.driveDeletions.keys()); }
}

class ChaoticMeshNetwork {
  constructor(rng, { packetLossRate = 0.0, duplicationRate = 0.0 } = {}) {
    this.rng = rng;
    this.packetLossRate = packetLossRate;
    this.duplicationRate = duplicationRate;
    this.peers = new Map();
    this.packetQueue = [];
    this.currentStep = 0;
  }

  registerPeer(peerId, engine) {
    this.peers.set(peerId, engine);
  }

  sendToPeer(fromPeerId, toPeerId, message) {
    if (this.rng.next() < this.packetLossRate) return;

    const copies = (this.rng.next() < this.duplicationRate) ? 2 : 1;
    for (let c = 0; c < copies; c++) {
      const delay = this.rng.nextInt(1, 10);
      this.packetQueue.push({
        from: fromPeerId,
        to: toPeerId,
        message: JSON.parse(JSON.stringify(message)),
        deliverAfterStep: this.currentStep + delay
      });
    }
  }

  broadcast(fromPeerId, message) {
    for (const toPeerId of this.peers.keys()) {
      if (toPeerId !== fromPeerId) {
        this.sendToPeer(fromPeerId, toPeerId, message);
      }
    }
  }

  async step() {
    this.currentStep++;
    const readyIndices = [];
    for (let i = 0; i < this.packetQueue.length; i++) {
      if (this.packetQueue[i].deliverAfterStep <= this.currentStep) {
        readyIndices.push(i);
      }
    }

    if (readyIndices.length === 0) return 0;

    const chosenIndex = this.rng.pick(readyIndices);
    const packet = this.packetQueue.splice(chosenIndex, 1)[0];
    const targetPeer = this.peers.get(packet.to);
    if (targetPeer) {
      await targetPeer.receiveMessage(packet.from, packet.message);
    }
    return 1;
  }

  async flushAll() {
    while (this.packetQueue.length > 0) {
      const idx = this.rng.nextInt(0, this.packetQueue.length - 1);
      const packet = this.packetQueue.splice(idx, 1)[0];
      const targetPeer = this.peers.get(packet.to);
      if (targetPeer) {
        await targetPeer.receiveMessage(packet.from, packet.message);
      }
    }
  }
}

class RobustCRDTEngine {
  constructor(peerId, network, storage, vault) {
    this.peerId = peerId;
    this.network = network;
    this.storage = storage;
    this.vault = vault;
    this.lamportClock = 0;
    this.seenIds = new Set();
    this.pendingRepliesByThread = new Map();
    this._mergeLocks = new Map();
    this.network.registerPeer(peerId, this);
  }

  tick(received = 0) {
    const safe = Math.min(Math.max(0, received), this.lamportClock + 500);
    this.lamportClock = Math.max(this.lamportClock, safe) + 1;
    return this.lamportClock;
  }

  async createChatMessage(text) {
    const clock = this.tick();
    const msg = {
      id: `msg_${this.peerId}_${clock}_${Math.random().toString(36).slice(2, 7)}`,
      text,
      authorId: this.peerId,
      timestamp: Date.now(),
      lamport: clock
    };
    msg.signature = await this.vault.sign(msg);
    await this.storage.saveMessage(msg);
    this.seenIds.add(msg.id);
    this.network.broadcast(this.peerId, { type: 'CHAT_MSG', payload: msg, lamport: clock });
    return msg;
  }

  async createForumTopic(title, content) {
    const clock = this.tick();
    const thread = {
      id: `thr_${this.peerId}_${clock}`,
      title,
      content,
      authorId: this.peerId,
      createdAt: Date.now(),
      lamport: clock,
      replies: []
    };
    thread.signature = await this.vault.sign(thread, ['replies']);
    await this.storage.saveForumThread(thread);
    this.seenIds.add(thread.id);
    this.network.broadcast(this.peerId, { type: 'FORUM_TOPIC', payload: thread, lamport: clock });

    if (this.pendingRepliesByThread.has(thread.id)) {
      const pending = this.pendingRepliesByThread.get(thread.id);
      this.pendingRepliesByThread.delete(thread.id);
      for (const rep of pending) {
        await this._mergeReplyIntoThread(thread.id, rep);
      }
    }

    return thread;
  }

  async addForumReply(threadId, content, customCreatedAt = null) {
    const clock = this.tick();
    const createdAt = customCreatedAt || Date.now();
    const reply = {
      id: `rep_${this.peerId}_${clock}_${Math.random().toString(36).slice(2, 6)}`,
      threadId,
      content,
      authorId: this.peerId,
      createdAt,
      lamport: clock
    };
    reply.signature = await this.vault.sign(reply);
    await this._mergeReplyIntoThread(threadId, reply);

    this.network.broadcast(this.peerId, { type: 'FORUM_REPLY', threadId, reply, lamport: clock });
    return reply;
  }

  async _mergeReplyIntoThread(threadId, reply) {
    const prev = this._mergeLocks.get(threadId) || Promise.resolve();
    const next = prev.then(async () => {
      let thread = await this.storage.getForumThread(threadId);
      if (!thread) {
        if (!this.pendingRepliesByThread.has(threadId)) {
          this.pendingRepliesByThread.set(threadId, []);
        }
        this.pendingRepliesByThread.get(threadId).push(reply);
        return;
      }

      const repliesMap = new Map();
      for (const r of thread.replies || []) repliesMap.set(r.id, r);
      repliesMap.set(reply.id, reply);

      const sortedReplies = Array.from(repliesMap.values()).sort((a, b) => {
        if ((a.createdAt || 0) !== (b.createdAt || 0)) return (a.createdAt || 0) - (b.createdAt || 0);
        if ((a.lamport || 0) !== (b.lamport || 0)) return (a.lamport || 0) - (b.lamport || 0);
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      });

      thread.replies = sortedReplies;
      await this.storage.saveForumThread(thread);
    });
    this._mergeLocks.set(threadId, next.catch(() => {}));
    return next;
  }

  async createFolder(path, createdAt = Date.now()) {
    const clock = this.tick();
    const folder = {
      path,
      name: path.replace(/\/+/g, '').trim(),
      authorId: this.peerId,
      createdAt,
      lamport: clock
    };
    folder.signature = await this.vault.sign(folder);

    const deletions = await this.storage.getAllFolderDeletions();
    const tomb = deletions.find(d => d.path === path);
    if (tomb && tomb.deletedAt >= folder.createdAt) {
      return null;
    }

    await this.storage.saveDriveFolder(folder);
    this.network.broadcast(this.peerId, { type: 'DRIVE_FOLDER_CREATE', folder, lamport: clock });
    return folder;
  }

  async deleteFolder(path, deletedAt = Date.now()) {
    const clock = this.tick();
    const op = {
      path,
      deletedBy: this.peerId,
      deletedAt,
      lamport: clock
    };
    op.signature = await this.vault.sign(op);
    await this.storage.saveFolderDeletion(op);
    await this.storage.deleteDriveFolder(path);

    this.network.broadcast(this.peerId, { type: 'DRIVE_FOLDER_DELETE', op, lamport: clock });
    return op;
  }

  static resolveDAGHeads(commits) {
    if (!commits || commits.length === 0) return { primaryHead: null, allHeads: [], isFork: false };
    const referenced = new Set();
    for (const c of commits) {
      for (const p of c.parents || []) referenced.add(p);
    }
    const heads = commits.filter(c => !referenced.has(c.commitId));

    heads.sort((a, b) => {
      if ((b.versionNumber || 0) !== (a.versionNumber || 0)) return (b.versionNumber || 0) - (a.versionNumber || 0);
      if ((b.lamportClock || 0) !== (a.lamportClock || 0)) return (b.lamportClock || 0) - (a.lamportClock || 0);
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      return b.commitId > a.commitId ? 1 : (b.commitId < a.commitId ? -1 : 0);
    });

    return { primaryHead: heads[0] || null, allHeads: heads, isFork: heads.length > 1 };
  }

  async receiveMessage(fromPeerId, message) {
    this.tick(message.lamport || 0);
    switch (message.type) {
      case 'CHAT_MSG': {
        const msg = message.payload;
        if (msg && !this.seenIds.has(msg.id)) {
          this.seenIds.add(msg.id);
          await this.storage.saveMessage(msg);
        }
        break;
      }
      case 'FORUM_TOPIC': {
        const thr = message.payload;
        if (thr && !this.seenIds.has(thr.id)) {
          this.seenIds.add(thr.id);
          const existing = await this.storage.getForumThread(thr.id);
          if (!existing) await this.storage.saveForumThread(thr);

          if (this.pendingRepliesByThread.has(thr.id)) {
            const pending = this.pendingRepliesByThread.get(thr.id);
            this.pendingRepliesByThread.delete(thr.id);
            for (const rep of pending) {
              await this._mergeReplyIntoThread(thr.id, rep);
            }
          }
        }
        break;
      }
      case 'FORUM_REPLY': {
        if (message.threadId && message.reply) {
          await this._mergeReplyIntoThread(message.threadId, message.reply);
        }
        break;
      }
      case 'DRIVE_FOLDER_CREATE': {
        const f = message.folder;
        if (f && f.path) {
          const deletions = await this.storage.getAllFolderDeletions();
          const tomb = deletions.find(d => d.path === f.path);
          if (!tomb || f.createdAt > tomb.deletedAt) {
            await this.storage.saveDriveFolder(f);
          }
        }
        break;
      }
      case 'DRIVE_FOLDER_DELETE': {
        const op = message.op;
        if (op && op.path) {
          await this.storage.saveFolderDeletion(op);
          await this.storage.deleteDriveFolder(op.path);
        }
        break;
      }
    }
  }
}

async function runCRDTFuzzingSuite() {
  console.log('=================================================================');
  console.log('🧪 DÉMARRAGE DU FUZZING CRDT & PROPERTY-BASED TESTING (2025/2026)');
  console.log('=================================================================\n');

  const rng = new SeededRandom(0x42DEADBEEF);

  // 1. Arbres de Merkle
  console.log('▶ [PROPRIÉTÉ 1] Fuzzing Arbre de Merkle RFC 6962 & Preuves SPV...');
  for (let iter = 0; iter < 100; iter++) {
    const leafCount = rng.nextInt(1, 128);
    const leafHashes = Array.from({ length: leafCount }, (_, i) =>
      MockCryptoVault.hashSHA256(`chunk_${iter}_${i}_${rng.next()}`)
    );

    const { root, layers } = await MerkleTree.buildTree(leafHashes);
    assert.ok(typeof root === 'string' && root.length === 64);

    for (let i = 0; i < leafCount; i++) {
      const proof = MerkleTree.generateProof(i, layers);
      const isValid = await MerkleTree.verifyProof(leafHashes[i], proof, root);
      assert.strictEqual(isValid, true);
    }
  }
  console.log('  ✅ 100 arbres aléatoires (1 à 128 feuilles) validés avec succès.\n');

  // 2. Chat Confluence & Idempotence
  console.log('▶ [PROPRIÉTÉ 2] Confluence & Idempotence du Chat...');
  {
    const network = new ChaoticMeshNetwork(rng, { packetLossRate: 0.0, duplicationRate: 0.35 });
    const peers = ['Alice', 'Bob', 'Charlie'].map(name => {
      const storage = new MockLocalStorage();
      const vault = new MockCryptoVault(name.toLowerCase(), name);
      return new RobustCRDTEngine(name.toLowerCase(), network, storage, vault);
    });

    const totalOps = 100;
    for (let i = 0; i < totalOps; i++) {
      const author = rng.pick(peers);
      await author.createChatMessage(`Message_${i}_from_${author.peerId}`);
      for (let s = 0; s < 2; s++) await network.step();
    }

    await network.flushAll();

    const messagesAlice = (await peers[0].storage.getAllMessages()).map(m => m.id).sort();
    const messagesBob = (await peers[1].storage.getAllMessages()).map(m => m.id).sort();
    const messagesCharlie = (await peers[2].storage.getAllMessages()).map(m => m.id).sort();

    assert.strictEqual(messagesAlice.length, totalOps);
    assert.deepStrictEqual(messagesAlice, messagesBob);
    assert.deepStrictEqual(messagesBob, messagesCharlie);
    console.log(`  ✅ ${totalOps} messages chat convergés avec 35% de duplications.\n`);
  }

  // 3. Forum Deterministic Ordering
  console.log('▶ [PROPRIÉTÉ 3] Ordre Déterministe des Réponses de Forum...');
  {
    const network = new ChaoticMeshNetwork(rng, { packetLossRate: 0.0, duplicationRate: 0.2 });
    const pA = new RobustCRDTEngine('pA', network, new MockLocalStorage(), new MockCryptoVault('pA', 'Alice'));
    const pB = new RobustCRDTEngine('pB', network, new MockLocalStorage(), new MockCryptoVault('pB', 'Bob'));
    const pC = new RobustCRDTEngine('pC', network, new MockLocalStorage(), new MockCryptoVault('pC', 'Charlie'));

    const thr = await pA.createForumTopic('Architecture P2P', 'Discussion technique');
    await network.flushAll();

    const fixedTimestamp = 1700000000000;
    for (let i = 0; i < 20; i++) {
      const p = rng.pick([pA, pB, pC]);
      const ts = (i % 3 === 0) ? fixedTimestamp : (fixedTimestamp + i * 100);
      await p.addForumReply(thr.id, `Reply_${i}_by_${p.peerId}`, ts);
      for (let s = 0; s < 2; s++) await network.step();
    }

    await network.flushAll();

    const threadA = await pA.storage.getForumThread(thr.id);
    const threadB = await pB.storage.getForumThread(thr.id);
    const threadC = await pC.storage.getForumThread(thr.id);

    assert.strictEqual(threadA.replies.length, 20);
    assert.deepStrictEqual(threadA.replies.map(r => r.id), threadB.replies.map(r => r.id));
    assert.deepStrictEqual(threadB.replies.map(r => r.id), threadC.replies.map(r => r.id));
    console.log('  ✅ Confluence parfaite de l\'ordre des réponses validée.\n');
  }

  // 4. Tombstone Resurrection Resistance
  console.log('▶ [PROPRIÉTÉ 4] Résistance à la Résurrection de Dossiers Supprimés...');
  {
    const network = new ChaoticMeshNetwork(rng, { packetLossRate: 0.0, duplicationRate: 0.1 });
    const pA = new RobustCRDTEngine('pA', network, new MockLocalStorage(), new MockCryptoVault('pA', 'Alice'));
    const pB = new RobustCRDTEngine('pB', network, new MockLocalStorage(), new MockCryptoVault('pB', 'Bob'));

    await pA.createFolder('/Documents/Secret/', 100);
    await network.flushAll();
    assert.strictEqual((await pB.storage.getAllDriveFolders()).length, 1);

    await pA.deleteFolder('/Documents/Secret/', 200);
    await network.flushAll();
    assert.strictEqual((await pA.storage.getAllDriveFolders()).length, 0);
    assert.strictEqual((await pB.storage.getAllDriveFolders()).length, 0);

    await pB.receiveMessage('pGhost', {
      type: 'DRIVE_FOLDER_CREATE',
      folder: {
        path: '/Documents/Secret/',
        name: 'Secret',
        authorId: 'pGhost',
        createdAt: 100,
        lamport: 5
      }
    });

    assert.strictEqual((await pB.storage.getAllDriveFolders()).length, 0);
    console.log('  ✅ Immunité à la résurrection de tombstones vérifiée avec succès.\n');
  }

  // 5. Merkle DAG Fork Resolution
  console.log('▶ [PROPRIÉTÉ 5] Résolution Déterministe des Têtes de DAG...');
  {
    const fileId = 'file_spec_pdf';
    const commitRoot = { fileId, commitId: 'cmt_001', versionNumber: 1, parents: [], timestamp: 1000, lamportClock: 1 };
    const forkA = { fileId, commitId: 'cmt_aaa', versionNumber: 2, parents: [commitRoot.commitId], timestamp: 2000, lamportClock: 2 };
    const forkB = { fileId, commitId: 'cmt_bbb', versionNumber: 2, parents: [commitRoot.commitId], timestamp: 2000, lamportClock: 2 };

    const res1 = RobustCRDTEngine.resolveDAGHeads([commitRoot, forkA, forkB]);
    const res2 = RobustCRDTEngine.resolveDAGHeads([forkB, commitRoot, forkA]);

    assert.strictEqual(res1.isFork, true);
    assert.strictEqual(res1.primaryHead.commitId, res2.primaryHead.commitId);
    console.log('  ✅ Résolution invariante des têtes de DAG validée.\n');
  }

  // 6. Mass Concurrency Fuzzing & Anti-Entropy Sync
  console.log('▶ [PROPRIÉTÉ 6] Fuzzing Massif de Concurrence Réseau (150 Ops)...');
  {
    const network = new ChaoticMeshNetwork(rng, { packetLossRate: 0.05, duplicationRate: 0.25 });
    const peers = Array.from({ length: 3 }, (_, i) => {
      const id = `peer_${i}`;
      return new RobustCRDTEngine(id, network, new MockLocalStorage(), new MockCryptoVault(id, `User_${i}`));
    });

    for (let cycle = 0; cycle < 150; cycle++) {
      const p = rng.pick(peers);
      await p.createChatMessage(`FuzzMsg_${cycle}`);
      for (let s = 0; s < 3; s++) await network.step();
    }

    await network.flushAll();

    // Anti-Entropy reconciliation
    for (const p of peers) {
      for (const other of peers) {
        if (p.peerId !== other.peerId) {
          const all = await other.storage.getAllMessages();
          for (const m of all) {
            await p.receiveMessage(other.peerId, { type: 'CHAT_MSG', payload: m, lamport: m.lamport });
          }
        }
      }
    }

    const state0Msgs = (await peers[0].storage.getAllMessages()).map(m => m.id).sort();
    assert.strictEqual(state0Msgs.length, 150, '150 messages créés au total');

    for (let i = 1; i < peers.length; i++) {
      const stateMsgs = (await peers[i].storage.getAllMessages()).map(m => m.id).sort();
      assert.deepStrictEqual(stateMsgs, state0Msgs);
    }
    console.log('  ✅ Confluence démontrée sur 3 nœuds après 150 opérations avec réconciliation anti-entropie.\n');
  }

  console.log('=================================================================');
  console.log('🎉 TOUTES LES PROPRIÉTÉS CRDT SONT VÉRIFIÉES AVEC SUCCÈS (100%)');
  console.log('=================================================================');
}

runCRDTFuzzingSuite().catch(err => {
  console.error('❌ Échec du Fuzzing CRDT :', err);
  process.exit(1);
});
