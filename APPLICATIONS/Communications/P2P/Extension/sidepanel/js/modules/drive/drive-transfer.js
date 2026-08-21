/**
 * modules/drive/drive-transfer.js
 * Moteur Swarming P2P BitTorrent-Like & Rarest-First Durci (2025/2026 - Pass 4)
 * - CompactBitfield Vectorisé (TypedArray, SWAR Popcount, Sérialisation Base64)
 * - SwarmPiecePicker (Random-First Bootstrap, Strict Rarest-First Anti-Clustering, Endgame Mode)
 * - TitForTatScheduler (Choking/Unchoking FSM, Optimistic Unchoke 30s, Anti-Free-Riding)
 * - Dynamic BDP Pipelining & CANCEL_CHUNK_REQ Propagation
 * - Assemblage In-Place Zéro-Copie, Validation SHA-256 & Arbre de Merkle RFC 6962.
 */

import { logger } from '../../core/logger.js';
import { CONFIG } from '../../core/config.js';
import { CryptoVault } from '../../core/crypto-vault.js';
import { dbManager } from '../../core/local-storage.js';
import { TTLMap } from '../../core/bounded-cache.js';
import { FileChunker } from './file-chunker.js';
import { MerkleTree } from './merkle-tree.js';

// ============================================================================
// 1. STRUCTURE DE DONNÉES : COMPACT BITFIELD (Bitmap Vectorisée Zero-Copy)
// ============================================================================

export class CompactBitfield {
  constructor(totalChunks, buffer = null) {
    this.totalChunks = totalChunks;
    this.byteLength = Math.ceil(totalChunks / 8);
    if (buffer) {
      if (buffer instanceof Uint8Array) {
        this.bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      } else if (buffer instanceof ArrayBuffer) {
        this.bytes = new Uint8Array(buffer);
      } else {
        this.bytes = new Uint8Array(this.byteLength);
      }
    } else {
      this.bytes = new Uint8Array(this.byteLength);
    }
  }

  set(index, value = true) {
    if (index < 0 || index >= this.totalChunks) return;
    const byteIdx = index >> 3;
    const bitMask = 1 << (7 - (index & 7));
    if (value) {
      this.bytes[byteIdx] |= bitMask;
    } else {
      this.bytes[byteIdx] &= ~bitMask;
    }
  }

  get(index) {
    if (index < 0 || index >= this.totalChunks) return false;
    const byteIdx = index >> 3;
    const bitMask = 1 << (7 - (index & 7));
    return (this.bytes[byteIdx] & bitMask) !== 0;
  }

  cardinality() {
    let count = 0;
    for (let i = 0; i < this.bytes.length; i++) {
      let b = this.bytes[i];
      // SWAR 8-bit popcount
      b = b - ((b >> 1) & 0x55);
      b = (b & 0x33) + ((b >> 2) & 0x33);
      count += (b + (b >> 4)) & 0x0f;
    }
    const paddingBits = (this.bytes.length * 8) - this.totalChunks;
    if (paddingBits > 0) {
      const lastByte = this.bytes[this.bytes.length - 1];
      for (let p = 0; p < paddingBits; p++) {
        if ((lastByte & (1 << p)) !== 0) count--;
      }
    }
    return Math.max(0, count);
  }

  isComplete() {
    return this.cardinality() === this.totalChunks;
  }

  isEmpty() {
    return this.cardinality() === 0;
  }

  getMissingIndices() {
    const missing = [];
    for (let i = 0; i < this.totalChunks; i++) {
      if (!this.get(i)) missing.push(i);
    }
    return missing;
  }

  getPresentIndices() {
    const present = [];
    for (let i = 0; i < this.totalChunks; i++) {
      if (this.get(i)) present.push(i);
    }
    return present;
  }

  toBase64() {
    let binary = '';
    const len = this.bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(this.bytes[i]);
    }
    if (typeof btoa !== 'undefined') {
      return btoa(binary);
    }
    return Buffer.from(this.bytes).toString('base64');
  }

  static fromBase64(base64Str, totalChunks) {
    if (typeof atob !== 'undefined') {
      const binary = atob(base64Str);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new CompactBitfield(totalChunks, bytes);
    }
    const buf = Buffer.from(base64Str, 'base64');
    return new CompactBitfield(totalChunks, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  }

  clone() {
    const copy = new Uint8Array(this.bytes.length);
    copy.set(this.bytes);
    return new CompactBitfield(this.totalChunks, copy);
  }
}

// ============================================================================
// 2. ORDONNANCEUR DE PIÈCES & CHUNKS (SWARM PIECE PICKER)
// ============================================================================

export class SwarmPiecePicker {
  constructor(commit) {
    this.commit = commit;
    this.totalChunks = commit.chunks.length;
    this.chunkHashes = commit.chunks.map(c => c.hash);
    this.hashToIndex = new Map(this.chunkHashes.map((h, i) => [h, i]));

    this.localBitfield = new CompactBitfield(this.totalChunks);
    this.peerBitfields = new Map(); // peerId -> CompactBitfield

    this.RANDOM_FIRST_THRESHOLD = Math.min(4, Math.ceil(this.totalChunks * 0.1));
    this.ENDGAME_THRESHOLD_CHUNKS = Math.max(2, Math.min(6, Math.ceil(this.totalChunks * 0.15)));
  }

  updateLocalChunk(index, present = true) {
    this.localBitfield.set(index, present);
  }

  updatePeerBitfield(peerId, bitfield) {
    this.peerBitfields.set(peerId, bitfield);
  }

  updatePeerHave(peerId, index) {
    let bf = this.peerBitfields.get(peerId);
    if (!bf) {
      bf = new CompactBitfield(this.totalChunks);
      this.peerBitfields.set(peerId, bf);
    }
    bf.set(index, true);
  }

  removePeer(peerId) {
    this.peerBitfields.delete(peerId);
  }

  getCompletedCount() {
    return this.localBitfield.cardinality();
  }

  getRemainingCount() {
    return this.totalChunks - this.getCompletedCount();
  }

  isEndgame() {
    const remaining = this.getRemainingCount();
    return remaining > 0 && remaining <= this.ENDGAME_THRESHOLD_CHUNKS;
  }

  isRandomFirst() {
    return this.getCompletedCount() < this.RANDOM_FIRST_THRESHOLD;
  }

  computeRarityHistogram(eligiblePeers = null) {
    const activePeers = eligiblePeers || Array.from(this.peerBitfields.keys());
    const histogram = [];

    for (let i = 0; i < this.totalChunks; i++) {
      if (this.localBitfield.get(i)) continue;

      const providers = [];
      for (const peerId of activePeers) {
        const bf = this.peerBitfields.get(peerId);
        if (bf && bf.get(i)) {
          providers.push(peerId);
        }
      }

      histogram.push({
        index: i,
        hash: this.chunkHashes[i],
        providers,
        rarity: providers.length
      });
    }

    return histogram;
  }

  pickNextRequests({ inFlightMap, activePeerIds, maxBatchSize = 6 }) {
    const remaining = this.getRemainingCount();
    if (remaining === 0) return [];

    const histogram = this.computeRarityHistogram(activePeerIds);
    if (histogram.length === 0) return [];

    const requests = [];

    // MODE 1 : ENDGAME MODE
    if (this.isEndgame()) {
      logger.debug('Drive', `⚡ [SwarmPicker] Mode ENDGAME actif (${remaining} blocs restants). Duplication miroir.`);
      for (const item of histogram) {
        const { index, hash, providers } = item;
        const currentInFlight = inFlightMap.get(hash) || [];
        const requestedPeers = new Set(currentInFlight.map(req => req.peerId));

        for (const peerId of providers) {
          if (!requestedPeers.has(peerId)) {
            requests.push({
              index,
              hash,
              peerId,
              isEndgame: true
            });
            if (requests.length >= maxBatchSize * 2) break;
          }
        }
      }
      return requests;
    }

    // MODE 2 : RANDOM-FIRST BOOTSTRAP
    if (this.isRandomFirst()) {
      const candidates = histogram.filter(item => !inFlightMap.has(item.hash) && item.providers.length > 0);
      this._shuffleArray(candidates);

      for (const item of candidates) {
        if (requests.length >= maxBatchSize) break;
        const peerId = item.providers[Math.floor(Math.random() * item.providers.length)];
        requests.push({
          index: item.index,
          hash: item.hash,
          peerId,
          isEndgame: false
        });
      }
      return requests;
    }

    // MODE 3 : STRICT RAREST-FIRST
    const availableItems = histogram.filter(item => !inFlightMap.has(item.hash) && item.providers.length > 0);
    
    const rarityBuckets = new Map();
    for (const item of availableItems) {
      if (!rarityBuckets.has(item.rarity)) {
        rarityBuckets.set(item.rarity, []);
      }
      rarityBuckets.get(item.rarity).push(item);
    }

    const sortedRarities = Array.from(rarityBuckets.keys()).sort((a, b) => a - b);

    for (const rarity of sortedRarities) {
      const bucket = rarityBuckets.get(rarity);
      this._shuffleArray(bucket);

      for (const item of bucket) {
        if (requests.length >= maxBatchSize) break;
        const peerId = item.providers[Math.floor(Math.random() * item.providers.length)];
        requests.push({
          index: item.index,
          hash: item.hash,
          peerId,
          isEndgame: false
        });
      }
      if (requests.length >= maxBatchSize) break;
    }

    return requests;
  }

  _shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
}

// ============================================================================
// 3. RÉGULATEUR TIT-FOR-TAT & CHOKING
// ============================================================================

export class TitForTatScheduler {
  constructor(meshNetwork) {
    this.mesh = meshNetwork;
    this.peerStats = new Map();
    this.MAX_ACTIVE_UPLOADS = 4;
    this.optimisticUnchokedPeer = null;

    this.roundInterval = setInterval(() => this._evaluateRanks(), 10000);
    this.optimisticInterval = setInterval(() => this._pickOptimisticUnchoke(), 30000);
  }

  destroy() {
    if (this.roundInterval) clearInterval(this.roundInterval);
    if (this.optimisticInterval) clearInterval(this.optimisticInterval);
    this.peerStats.clear();
  }

  recordBytesDownloaded(peerId, bytes) {
    if (!peerId) return;
    const stats = this._getOrCreateStats(peerId);
    stats.bytesDownloaded += bytes;
  }

  recordBytesUploaded(peerId, bytes) {
    if (!peerId) return;
    const stats = this._getOrCreateStats(peerId);
    stats.bytesUploaded += bytes;
  }

  isPeerAllowedToDownload(peerId) {
    const stats = this.peerStats.get(peerId);
    if (!stats) return true;
    return !stats.isChoked || stats.isOptimistic;
  }

  _getOrCreateStats(peerId) {
    let stats = this.peerStats.get(peerId);
    if (!stats) {
      stats = {
        bytesDownloaded: 0,
        bytesUploaded: 0,
        lastMeasure: Date.now(),
        rateDown: 0,
        rateUp: 0,
        isChoked: false,
        isOptimistic: false
      };
      this.peerStats.set(peerId, stats);
    }
    return stats;
  }

  _evaluateRanks() {
    const now = Date.now();
    const activePeers = [];

    for (const [peerId, stats] of this.peerStats) {
      if (!this.mesh.peers || !this.mesh.peers.has(peerId)) {
        this.peerStats.delete(peerId);
        continue;
      }
      const elapsed = Math.max(1, (now - stats.lastMeasure) / 1000);
      stats.rateDown = stats.bytesDownloaded / elapsed;
      stats.rateUp = stats.bytesUploaded / elapsed;
      stats.bytesDownloaded = 0;
      stats.bytesUploaded = 0;
      stats.lastMeasure = now;
      activePeers.push({ peerId, stats });
    }

    activePeers.sort((a, b) => b.stats.rateDown - a.stats.rateDown);

    activePeers.forEach((item, index) => {
      const shouldUnchoke = index < this.MAX_ACTIVE_UPLOADS;
      const wasChoked = item.stats.isChoked;

      item.stats.isChoked = !shouldUnchoke;
      item.stats.isOptimistic = (item.peerId === this.optimisticUnchokedPeer);

      if (wasChoked && shouldUnchoke) {
        this.mesh.sendToPeer(item.peerId, { type: 'PEER_UNCHOKE' });
      } else if (!wasChoked && !shouldUnchoke && !item.stats.isOptimistic) {
        this.mesh.sendToPeer(item.peerId, { type: 'PEER_CHOKE' });
      }
    });
  }

  _pickOptimisticUnchoke() {
    const chokedPeers = Array.from(this.peerStats.entries())
      .filter(([id, s]) => s.isChoked && this.mesh.peers && this.mesh.peers.has(id))
      .map(([id]) => id);

    if (chokedPeers.length === 0) {
      this.optimisticUnchokedPeer = null;
      return;
    }

    this.optimisticUnchokedPeer = chokedPeers[Math.floor(Math.random() * chokedPeers.length)];
    const stats = this.peerStats.get(this.optimisticUnchokedPeer);
    if (stats) {
      stats.isOptimistic = true;
      this.mesh.sendToPeer(this.optimisticUnchokedPeer, { type: 'PEER_UNCHOKE' });
      logger.debug('Drive', `🎲 [Tit-for-Tat] Optimistic Unchoke attribué au pair ${this.optimisticUnchokedPeer}`);
    }
  }
}

// ============================================================================
// 4. MOTEUR CENTRAL DE TRANSFERT EN ESSAIM (DRIVE TRANSFER MANAGER)
// ============================================================================

export class DriveTransferManager {
  constructor(meshNetwork) {
    this.mesh = meshNetwork;
    this.activeDownloads = new Map();
    this.titForTat = new TitForTatScheduler(meshNetwork);

    this.pendingChunkSlices = new TTLMap({
      maxSize: 256,
      ttlMs: 45000,
      onEvict: (hash) => {
        logger.debug('Drive', `[Transfer] Nettoyage réassemblage expiré pour chunk: ${hash.substring(0, 10)}...`);
      }
    });

    this.autoReplicatingFiles = new Set();
    this._activeProbes = new Map();
    this.peerReputation = new Map();

    this.initListeners();
    this.sliceSweepInterval = setInterval(() => this.pendingChunkSlices.sweep(), 15000);
  }

  _recordPeerFailure(peerId) {
    if (!peerId) return;
    const rep = this.peerReputation.get(peerId) || { failures: 0, penaltyUntil: 0 };
    rep.failures++;
    if (rep.failures >= 3) {
      rep.penaltyUntil = Date.now() + 180000;
      logger.warn('Drive', `🚫 Pair ${peerId} temporairement mis en quarantaine pour défaillance répétée de blocs.`);
    }
    this.peerReputation.set(peerId, rep);
  }

  _recordPeerSuccess(peerId) {
    if (!peerId) return;
    const rep = this.peerReputation.get(peerId) || { failures: 0, penaltyUntil: 0 };
    rep.failures = Math.max(0, rep.failures - 1);
    this.peerReputation.set(peerId, rep);
  }

  _isPeerPenalized(peerId) {
    const rep = this.peerReputation.get(peerId);
    return rep && rep.penaltyUntil > Date.now();
  }

  async probeSeeders(commit, timeoutMs = 1600) {
    let localHave = 0;
    for (const c of commit.chunks) {
      if (await dbManager.hasChunk(c.hash)) localHave++;
    }
    const localComplete = localHave === commit.chunks.length;
    const localPercent = commit.chunks.length ? Math.round((localHave / commit.chunks.length) * 100) : 100;

    if (!this.mesh.peers || this.mesh.peers.size === 0) {
      return { seeders: 0, fullSeeders: 0, localComplete, localPercent };
    }

    const probe = { seeders: new Set(), fullSeeders: new Set() };
    this._activeProbes.set(commit.fileId, probe);

    this.mesh.broadcast({
      type: 'SEED_PROBE_REQ',
      fileId: commit.fileId,
      rootMerkleHash: commit.rootMerkleHash
    });

    await new Promise((r) => setTimeout(r, timeoutMs));
    this._activeProbes.delete(commit.fileId);

    return {
      seeders: probe.seeders.size,
      fullSeeders: probe.fullSeeders.size,
      localComplete,
      localPercent
    };
  }

  initListeners() {
    this.mesh.on('message-received', async ({ peerId, message }) => {
      try {
        switch (message.type) {
          case 'SWARM_BITFIELD':
            this.handleSwarmBitfield(peerId, message);
            break;
          case 'SWARM_HAVE':
            this.handleSwarmHave(peerId, message);
            break;
          case 'CANCEL_CHUNK_REQ':
            this.handleCancelChunkReq(peerId, message);
            break;
          case 'SEED_PROBE_REQ':
            await this.handleSeedProbeReq(peerId, message);
            break;
          case 'SEED_PROBE_RESP':
            this.handleSeedProbeResp(peerId, message);
            break;
          case 'CHUNK_AVAILABILITY_REQ':
            await this.handleAvailabilityReq(peerId, message);
            break;
          case 'CHUNK_AVAILABILITY_RESP':
            this.handleAvailabilityResp(peerId, message);
            break;
          case 'CHUNK_REQ':
            await this.handleChunkReq(peerId, message);
            break;
          case 'PEER_CHOKE':
          case 'PEER_UNCHOKE':
            break;
        }
      } catch (err) {
        logger.error('Drive', '[Transfer] Erreur traitement message:', err);
      }
    });

    this.mesh.on('peer-left', ({ peerId }) => {
      const pid = peerId || '';
      this.activeDownloads.forEach((session) => {
        session.picker.removePeer(pid);
        let changed = false;
        for (const [hash, reqList] of session.inFlight) {
          const filtered = reqList.filter(r => r.peerId !== pid);
          if (filtered.length !== reqList.length) {
            if (filtered.length === 0) session.inFlight.delete(hash);
            else session.inFlight.set(hash, filtered);
            changed = true;
          }
        }
        if (changed) this._scheduleRequests(session);
      });
    });

    this.mesh.on('peer-ready', async (peer) => {
      if (!peer || !peer.id) return;
      for (const [fileId, session] of this.activeDownloads) {
        this.mesh.sendToPeer(peer.id, {
          type: 'SWARM_BITFIELD',
          fileId,
          bitfield: session.picker.localBitfield.toBase64(),
          totalChunks: session.picker.totalChunks
        });
      }
    });

    this.mesh.on('chunk-received', ({ peerId, buffer }) => {
      this.handleRawBinarySlice(buffer, peerId);
    });
  }

  handleSwarmBitfield(peerId, message) {
    const session = this.activeDownloads.get(message.fileId);
    if (!session || !message.bitfield) return;

    try {
      const bf = CompactBitfield.fromBase64(message.bitfield, message.totalChunks || session.picker.totalChunks);
      session.picker.updatePeerBitfield(peerId, bf);
      this._scheduleRequests(session);
    } catch (e) {
      logger.warn('Drive', `[Transfer] Bitfield corrompu reçu du pair ${peerId}:`, e);
    }
  }

  handleSwarmHave(peerId, message) {
    const session = this.activeDownloads.get(message.fileId);
    if (!session || typeof message.chunkIndex !== 'number') return;

    session.picker.updatePeerHave(peerId, message.chunkIndex);
    this._scheduleRequests(session);
  }

  handleCancelChunkReq(peerId, message) {
    logger.debug('Drive', `🚫 [Transfer] CANCEL_CHUNK_REQ reçu de ${peerId} pour chunk: ${message.hash?.substring(0, 8)}`);
  }

  async handleSeedProbeReq(peerId, message) {
    const commits = await dbManager.getCommitsByFileId(message.fileId);
    const target = commits.find((c) => c.rootMerkleHash === message.rootMerkleHash) || commits[0];
    if (!target || !target.chunks) return;

    let haveCount = 0;
    const bitfield = new CompactBitfield(target.chunks.length);
    for (let i = 0; i < target.chunks.length; i++) {
      if (await dbManager.hasChunk(target.chunks[i].hash)) {
        haveCount++;
        bitfield.set(i, true);
      }
    }

    this.mesh.sendToPeer(peerId, {
      type: 'SEED_PROBE_RESP',
      fileId: message.fileId,
      haveCount,
      totalChunks: target.chunks.length,
      isFullSeeder: haveCount === target.chunks.length,
      bitfield: bitfield.toBase64()
    });
  }

  handleSeedProbeResp(peerId, message) {
    const probe = this._activeProbes.get(message.fileId);
    if (probe) {
      if (message.haveCount > 0) probe.seeders.add(peerId);
      if (message.isFullSeeder) probe.fullSeeders.add(peerId);
    }

    const session = this.activeDownloads.get(message.fileId);
    if (session && message.bitfield) {
      try {
        const bf = CompactBitfield.fromBase64(message.bitfield, message.totalChunks || session.picker.totalChunks);
        session.picker.updatePeerBitfield(peerId, bf);
        this._scheduleRequests(session);
      } catch (e) {}
    }
  }

  async handleAvailabilityReq(peerId, message) {
    const have = [];
    for (const hash of message.hashes || []) {
      if (await dbManager.hasChunk(hash)) have.push(hash);
    }
    this.mesh.sendToPeer(peerId, {
      type: 'CHUNK_AVAILABILITY_RESP',
      fileId: message.fileId,
      availableHashes: have
    });
  }

  handleAvailabilityResp(peerId, message) {
    const session = this.activeDownloads.get(message.fileId);
    if (!session) return;

    for (const hash of message.availableHashes || []) {
      const idx = session.picker.hashToIndex.get(hash);
      if (typeof idx === 'number') {
        session.picker.updatePeerHave(peerId, idx);
      }
    }
    this._scheduleRequests(session);
  }

  async handleChunkReq(peerId, message) {
    const { hash } = message;
    if (!hash) return;

    if (!this.titForTat.isPeerAllowedToDownload(peerId)) {
      logger.debug('Drive', `⏳ [Tit-for-Tat] Requête de ${peerId} temporairement différée (Peer Choked)`);
      return;
    }

    const arrayBuffer = await dbManager.getChunk(hash);
    if (!arrayBuffer) {
      this.mesh.sendToPeer(peerId, { type: 'CHUNK_NOT_FOUND', hash });
      return;
    }

    this.titForTat.recordBytesUploaded(peerId, arrayBuffer.byteLength);
    await this.mesh.sendBinaryChunkSliced(peerId, hash, arrayBuffer);
  }

  async handleRawBinarySlice(buffer, peerId = null) {
    const HEADER_SIZE = 41;
    if (!buffer || buffer.byteLength < HEADER_SIZE) return;
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0xFD && bytes[0] !== 0xFC) return;

    const rawHashBytes = bytes.subarray(1, 33);
    const hashHex = CryptoVault.bufferToHex(rawHashBytes);

    const view = new DataView(buffer);
    const sliceIdx = view.getUint16(33, false);
    const totalSlices = view.getUint16(35, false);
    const totalChunkSize = view.getUint32(37, false);
    const payloadLength = buffer.byteLength - HEADER_SIZE;

    const L = CONFIG.LIMITS;
    if (!/^[0-9a-f]{64}$/.test(hashHex) ||
        totalSlices < 1 || totalSlices > (L.MAX_BINARY_SLICES || 512) ||
        sliceIdx >= totalSlices ||
        totalChunkSize < 1 || totalChunkSize > (L.MAX_BINARY_CHUNK_BYTES || 2097152)) {
      logger.warn('Drive', `[Transfer] En-tête de tranche binaire invalide rejeté`);
      if (peerId) this._recordPeerFailure(peerId);
      return;
    }

    const SLICE_PAYLOAD_SIZE = 16384 - HEADER_SIZE;
    const expectedOffset = sliceIdx * SLICE_PAYLOAD_SIZE;
    if (expectedOffset + payloadLength > totalChunkSize) {
      logger.warn('Drive', `[Transfer] Débordement de tranche: ${expectedOffset + payloadLength} > ${totalChunkSize}`);
      if (peerId) this._recordPeerFailure(peerId);
      return;
    }

    let entry = this.pendingChunkSlices.get(hashHex);
    if (!entry) {
      entry = {
        targetBuffer: new Uint8Array(totalChunkSize),
        receivedSlices: new Set(),
        totalSlices,
        totalChunkSize,
        peerId,
        createdAt: Date.now()
      };
      this.pendingChunkSlices.set(hashHex, entry);
    }

    if (entry.totalSlices !== totalSlices || entry.totalChunkSize !== totalChunkSize) return;

    if (!entry.receivedSlices.has(sliceIdx)) {
      entry.targetBuffer.set(bytes.subarray(HEADER_SIZE), expectedOffset);
      entry.receivedSlices.add(sliceIdx);
    }

    if (entry.receivedSlices.size === entry.totalSlices) {
      this.pendingChunkSlices.delete(hashHex);
      if (peerId) this.titForTat.recordBytesDownloaded(peerId, entry.totalChunkSize);
      await this.handleCompleteChunkReceived(hashHex, entry.targetBuffer.buffer, entry.peerId || peerId);
    }
  }

  async handleCompleteChunkReceived(hash, arrayBuffer, peerId = null) {
    const computedHash = await CryptoVault.hashSHA256(arrayBuffer);
    if (computedHash !== hash) {
      logger.warn('Drive', `🚨 [Transfer] Bloc corrompu rejeté (${hash} != ${computedHash})`);
      if (peerId) this._recordPeerFailure(peerId);
      this.activeDownloads.forEach((session) => {
        session.inFlight.delete(hash);
        this._scheduleRequests(session);
      });
      return;
    }

    if (peerId) this._recordPeerSuccess(peerId);
    await dbManager.saveChunk(hash, arrayBuffer);

    this.activeDownloads.forEach((session, fileId) => {
      const chunkIndex = session.picker.hashToIndex.get(hash);
      if (typeof chunkIndex === 'number' && !session.picker.localBitfield.get(chunkIndex)) {
        session.picker.updateLocalChunk(chunkIndex, true);

        // Annulation miroir (Endgame Mode Cancel Protocol)
        const inFlightReqs = session.inFlight.get(hash) || [];
        for (const req of inFlightReqs) {
          if (req.peerId !== peerId && this.mesh.peers && this.mesh.peers.has(req.peerId)) {
            this.mesh.sendToPeer(req.peerId, {
              type: 'CANCEL_CHUNK_REQ',
              fileId,
              chunkIndex,
              hash
            });
          }
        }
        session.inFlight.delete(hash);

        // Diffusion immédiate de l'annonce HAVE à l'essaim
        this.mesh.broadcast({
          type: 'SWARM_HAVE',
          fileId,
          chunkIndex,
          hash
        });

        if (session.onProgress) {
          const percent = Math.round((session.picker.getCompletedCount() / session.picker.totalChunks) * 100);
          session.onProgress(percent);
        }

        if (session.picker.localBitfield.isComplete()) {
          this.completeDownload(fileId);
        } else {
          this._scheduleRequests(session);
        }
      }
    });
  }

  _scheduleRequests(session) {
    if (session.picker.localBitfield.isComplete()) return;

    const isCallActive = this.mesh.isMediaActive && this.mesh.isMediaActive();
    const maxParallel = isCallActive
      ? (CONFIG.DRIVE.QOS_CALL_PARALLEL_CHUNKS || 1)
      : (CONFIG.DRIVE.SWARM_MAX_PARALLEL_CHUNKS || 6);

    const now = Date.now();
    const TIMEOUT_MS = CONFIG.DRIVE.CHUNK_REQUEST_TIMEOUT || 8000;

    for (const [hash, reqList] of session.inFlight) {
      const activeReqs = reqList.filter((req) => {
        if (now - req.sentAt > TIMEOUT_MS) {
          logger.debug('Drive', `[Transfer] Timeout chunk ${hash.substring(0, 8)} sur ${req.peerId} -> ré-affectation`);
          this._recordPeerFailure(req.peerId);
          return false;
        }
        return true;
      });

      if (activeReqs.length === 0) {
        session.inFlight.delete(hash);
      } else {
        session.inFlight.set(hash, activeReqs);
      }
    }

    const currentInFlightCount = Array.from(session.inFlight.values()).reduce((sum, list) => sum + list.length, 0);
    const slotsAvailable = maxParallel - currentInFlightCount;
    if (slotsAvailable <= 0) return;

    if (!this.mesh.peers) return;
    const activePeers = Array.from(this.mesh.peers.keys()).filter((p) => !this._isPeerPenalized(p));
    if (activePeers.length === 0) return;

    const plannedRequests = session.picker.pickNextRequests({
      inFlightMap: session.inFlight,
      activePeerIds: activePeers,
      maxBatchSize: slotsAvailable
    });

    for (const req of plannedRequests) {
      const { hash, peerId, index } = req;
      let reqList = session.inFlight.get(hash);
      if (!reqList) {
        reqList = [];
        session.inFlight.set(hash, reqList);
      }

      reqList.push({ peerId, sentAt: now });

      this.mesh.sendToPeer(peerId, {
        type: 'CHUNK_REQ',
        fileId: session.commit.fileId,
        chunkIndex: index,
        hash
      });
    }
  }

  async downloadFile(commit, onProgress = null, { assemble = true } = {}) {
    if (this.activeDownloads.has(commit.fileId)) {
      throw new Error(`Téléchargement déjà en cours pour ${commit.fileName}`);
    }

    await dbManager.ensureSpaceFor(commit.fileSize, assemble ? 'download' : 'replicate');

    const picker = new SwarmPiecePicker(commit);
    let alreadyPresent = 0;

    for (let i = 0; i < commit.chunks.length; i++) {
      if (await dbManager.hasChunk(commit.chunks[i].hash)) {
        picker.updateLocalChunk(i, true);
        alreadyPresent++;
      }
    }

    if (picker.localBitfield.isComplete()) {
      if (onProgress) onProgress(100);
      if (!assemble) return null;
      return await FileChunker.assembleFileStreaming(commit.chunks, commit.mimeType, commit.fileName);
    }

    return new Promise((resolve, reject) => {
      const session = {
        commit,
        assemble,
        picker,
        inFlight: new Map(),
        onProgress,
        resolve,
        reject
      };

      this.activeDownloads.set(commit.fileId, session);

      this.mesh.broadcast({
        type: 'SWARM_BITFIELD',
        fileId: commit.fileId,
        bitfield: picker.localBitfield.toBase64(),
        totalChunks: commit.chunks.length
      });

      this.mesh.broadcast({
        type: 'CHUNK_AVAILABILITY_REQ',
        fileId: commit.fileId,
        hashes: picker.localBitfield.getMissingIndices().map(i => commit.chunks[i].hash)
      });

      session.pump = setInterval(() => {
        if (!this.activeDownloads.has(commit.fileId)) {
          clearInterval(session.pump);
          return;
        }
        this._scheduleRequests(session);
      }, 2000);

      session.timeout = setTimeout(() => {
        if (this.activeDownloads.has(commit.fileId)) {
          clearInterval(session.pump);
          this.activeDownloads.delete(commit.fileId);
          reject(new Error(`Timeout de téléchargement essaim pour "${commit.fileName}"`));
        }
      }, 180000);

      this._scheduleRequests(session);
    });
  }

  async autoReplicate(commit) {
    if (this.autoReplicatingFiles.has(commit.fileId)) return;
    this.autoReplicatingFiles.add(commit.fileId);
    try {
      logger.info('Drive', `🔄 Démarrage auto-réplication pour : "${commit.fileName}"`);
      await this.downloadFile(commit, null, { assemble: false });
      logger.info('Drive', `✅ Auto-réplication terminée pour : "${commit.fileName}"`);
    } catch (err) {
      logger.debug('Drive', `Auto-réplication non complétée pour "${commit.fileName}":`, err.message);
    } finally {
      this.autoReplicatingFiles.delete(commit.fileId);
    }
  }

  async autoReplicateFile(commit) {
    return this.autoReplicate(commit);
  }

  async completeDownload(fileId) {
    const session = this.activeDownloads.get(fileId);
    if (!session) return;

    if (session.pump) clearInterval(session.pump);
    if (session.timeout) clearTimeout(session.timeout);
    this.activeDownloads.delete(fileId);

    try {
      if (session.commit.rootMerkleHash && session.commit.chunks.length > 0) {
        const computedRoot = await MerkleTree.computeRootFromHashes(session.commit.chunks.map((c) => c.hash));
        if (computedRoot !== session.commit.rootMerkleHash) {
          throw new Error(`Échec validation arbre de Merkle RFC 6962 pour "${session.commit.fileName}"`);
        }
        logger.info('Drive', `🌳 Validation Merkle RFC 6962 réussie pour "${session.commit.fileName}" !`);
      }

      if (!session.assemble) {
        if (session.onProgress) session.onProgress(100);
        session.resolve(null);
        return;
      }

      const fileResult = await FileChunker.assembleFileStreaming(
        session.commit.chunks,
        session.commit.mimeType,
        session.commit.fileName
      );
      if (session.onProgress) session.onProgress(100);
      session.resolve(fileResult);
    } catch (err) {
      logger.error('Drive', '[Transfer] Échec finalisation assemblage:', err);
      session.reject(err);
    }
  }

  destroy() {
    if (this.sliceSweepInterval) {
      clearInterval(this.sliceSweepInterval);
      this.sliceSweepInterval = null;
    }
    if (this.titForTat) {
      this.titForTat.destroy();
    }
    this.activeDownloads.forEach((session) => {
      if (session.pump) clearInterval(session.pump);
      if (session.timeout) clearTimeout(session.timeout);
    });
    this.activeDownloads.clear();
  }
}
