/**
 * Gestionnaire de Transfert en Essaim (Swarm Downloader) & Auto-Réplication P2P
 * Téléchargement multi-sources type BitTorrent : inventaire d'availability,
 * planification RAREST-FIRST, parallélisme borné, ré-affectation sur timeout,
 * réassemblage en tranches 16 Ko, vérification SHA-256 et auto-seeding.
 *
 * Réécrit suite à l'audit :
 *  - l'ancienne version diffusait TOUS les blocs manquants à TOUS les pairs
 *    (duplication massive, SWARM_MAX_PARALLEL_CHUNKS ignoré, pas de rarest-first) ;
 *  - handleRawBinarySlice allouait `new Uint8Array(totalChunkSize)` sans borne
 *    (DoS mémoire ~4 Go) et ne validait ni totalSlices ni sliceIdx.
 */

import { CONFIG } from '../../core/config.js';
import { CryptoVault } from '../../core/crypto-vault.js';
import { dbManager } from '../../core/local-storage.js';
import { FileChunker } from './file-chunker.js';

export class DriveTransferManager {
  constructor(meshNetwork) {
    this.mesh = meshNetwork;
    this.activeDownloads = new Map(); // fileId -> DownloadState
    this.pendingChunkSlices = new Map(); // hash -> { slices: Map, received, totalSlices, totalChunkSize, createdAt }
    this.autoReplicatingFiles = new Set(); // fileId

    this._activeProbes = new Map(); // fileId -> { seeders:Set, fullSeeders:Set }

    this.initListeners();

    // Purge périodique des réassemblages binaires partiels abandonnés.
    this.sliceSweepInterval = setInterval(() => this._sweepPendingSlices(), 15000);
  }

  /**
   * Sonde le maillage pour estimer le nombre de "sources" (pairs) détenant un
   * fichier. Renvoie { seeders, fullSeeders, localComplete } après `timeoutMs`.
   */
  async probeSeeders(commit, timeoutMs = 1600) {
    // Statut de réplication locale (part des blocs présents ici).
    let localHave = 0;
    for (const c of commit.chunks) { if (await dbManager.hasChunk(c.hash)) localHave++; }
    const localComplete = localHave === commit.chunks.length;
    const localPercent = commit.chunks.length ? Math.round((localHave / commit.chunks.length) * 100) : 100;

    if (this.mesh.peers.size === 0) {
      return { seeders: 0, fullSeeders: 0, localComplete, localPercent };
    }

    const probe = { seeders: new Set(), fullSeeders: new Set() };
    this._activeProbes.set(commit.fileId, probe);
    const sample = commit.chunks.slice(0, 8).map(c => c.hash);
    this.mesh.broadcast({ type: 'SEED_PROBE_REQ', fileId: commit.fileId, sample });

    await new Promise(r => setTimeout(r, timeoutMs));
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
      if (!message || !message.type) return;

      switch (message.type) {
        // Un pair demande un bloc précis -> on l'envoie s'il est présent localement.
        case 'CHUNK_REQ': {
          const chunkData = await dbManager.getChunk(message.hash);
          if (chunkData) {
            console.log(`[DriveTransfer] 📤 Envoi du bloc ${String(message.hash).substring(0, 10)}... vers ${peerId}`);
            await this.mesh.sendBinaryChunkSliced(peerId, message.hash, chunkData);
          }
          break;
        }

        // Un pair demande QUELS blocs (parmi une liste) nous possédons -> inventaire.
        case 'CHUNK_AVAILABILITY_REQ': {
          const hashes = Array.isArray(message.hashes) ? message.hashes.slice(0, 200000) : [];
          const have = [];
          for (const h of hashes) {
            if (await dbManager.hasChunk(h)) have.push(h);
          }
          this.mesh.sendToPeer(peerId, {
            type: 'CHUNK_AVAILABILITY_RESP',
            fileId: message.fileId,
            have
          });
          break;
        }

        // Réponse d'inventaire d'un pair -> enrichit la carte de rareté.
        case 'CHUNK_AVAILABILITY_RESP': {
          const dl = this.activeDownloads.get(message.fileId);
          if (dl && Array.isArray(message.have)) {
            for (const h of message.have) {
              if (dl.providers.has(h)) dl.providers.get(h).add(peerId);
            }
            dl.providersKnown = true;
            this._scheduleRequests(dl);
          }
          break;
        }

        // Sonde de "sources" : un pair demande qui détient ce fichier.
        case 'SEED_PROBE_REQ': {
          const sample = Array.isArray(message.sample) ? message.sample : [];
          let hasCount = 0;
          for (const h of sample) { if (await dbManager.hasChunk(h)) hasCount++; }
          if (hasCount > 0) {
            this.mesh.sendToPeer(peerId, {
              type: 'SEED_PROBE_RESP',
              fileId: message.fileId,
              full: hasCount === sample.length
            });
          }
          break;
        }

        case 'SEED_PROBE_RESP': {
          const probe = this._activeProbes && this._activeProbes.get(message.fileId);
          if (probe) {
            probe.seeders.add(peerId);
            if (message.full) probe.fullSeeders.add(peerId);
          }
          break;
        }
      }
    });

    // Tranches binaires entrantes sur le canal 'p2p-data'.
    this.mesh.on('chunk-received', async ({ peerId, buffer }) => {
      await this.handleRawBinarySlice(buffer);
    });
  }

  /**
   * Traite une tranche binaire entrante.
   * Format: [0xFD][64 bytes hash][2 bytes sliceIdx][2 bytes totalSlices][4 bytes totalSize][payload]
   */
  async handleRawBinarySlice(buffer) {
    if (!buffer || buffer.byteLength < 73) return;
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0xFD) return;

    const hash = new TextDecoder().decode(bytes.subarray(1, 65)).trim();
    const view = new DataView(buffer);
    const sliceIdx = view.getUint16(65, false);
    const totalSlices = view.getUint16(67, false);
    const totalChunkSize = view.getUint32(69, false);
    const slicePayload = buffer.slice(73);

    // CORRECTIF (audit §DoS mémoire binaire) : bornes strictes AVANT allocation.
    const L = CONFIG.LIMITS;
    if (!/^[0-9a-f]{64}$/.test(hash) ||
        totalSlices < 1 || totalSlices > L.MAX_BINARY_SLICES ||
        sliceIdx >= totalSlices ||
        totalChunkSize < 1 || totalChunkSize > L.MAX_BINARY_CHUNK_BYTES) {
      console.warn(`[DriveTransfer] ⛔ En-tête de tranche invalide rejeté (slices=${totalSlices}, size=${totalChunkSize})`);
      return;
    }

    let entry = this.pendingChunkSlices.get(hash);
    if (!entry) {
      entry = { slices: new Map(), received: 0, totalSlices, totalChunkSize, createdAt: Date.now() };
      this.pendingChunkSlices.set(hash, entry);
    }
    if (entry.totalSlices !== totalSlices || entry.totalChunkSize !== totalChunkSize) return;

    if (!entry.slices.has(sliceIdx)) {
      entry.slices.set(sliceIdx, slicePayload);
      entry.received++;
    }

    if (entry.received === entry.totalSlices) {
      const fullChunk = new Uint8Array(entry.totalChunkSize);
      let offset = 0;
      for (let i = 0; i < entry.totalSlices; i++) {
        const slice = entry.slices.get(i);
        if (slice) {
          fullChunk.set(new Uint8Array(slice), offset);
          offset += slice.byteLength;
        }
      }
      this.pendingChunkSlices.delete(hash);
      await this.handleCompleteChunkReceived(hash, fullChunk.buffer);
    }
  }

  /** Libère les ressources (intervalles) — à appeler à l'arrêt du réseau. */
  destroy() {
    if (this.sliceSweepInterval) { clearInterval(this.sliceSweepInterval); this.sliceSweepInterval = null; }
    this.activeDownloads.forEach((dl) => {
      if (dl.pump) clearInterval(dl.pump);
      if (dl.timeout) clearTimeout(dl.timeout);
    });
    this.activeDownloads.clear();
  }

  _sweepPendingSlices() {
    const now = Date.now();
    for (const [hash, entry] of this.pendingChunkSlices) {
      if (now - entry.createdAt > 45000) this.pendingChunkSlices.delete(hash);
    }
  }

  async handleCompleteChunkReceived(hash, arrayBuffer) {
    // Vérification cryptographique de l'intégrité SHA-256 (le contenu est lié au hash).
    const computedHash = await CryptoVault.hashSHA256(arrayBuffer);
    if (computedHash !== hash) {
      console.warn(`[DriveTransfer] ⛔ Bloc corrompu rejeté (${hash} != ${computedHash})`);
      // Re-planifie le bloc auprès d'un autre fournisseur.
      this.activeDownloads.forEach((dl) => {
        if (dl.inFlight.has(hash)) {
          dl.inFlight.delete(hash);
          this._scheduleRequests(dl);
        }
      });
      return;
    }

    await dbManager.saveChunk(hash, arrayBuffer);
    console.log(`[DriveTransfer] 💾 Bloc vérifié et stocké: ${hash.substring(0, 10)}... (${arrayBuffer.byteLength} octets)`);

    this.activeDownloads.forEach((dl) => {
      if (dl.missingHashes.has(hash)) {
        dl.missingHashes.delete(hash);
        dl.inFlight.delete(hash);
        dl.completedChunks++;

        const percent = Math.round((dl.completedChunks / dl.totalChunks) * 100);
        if (dl.onProgress) dl.onProgress(percent);

        if (dl.missingHashes.size === 0) {
          console.log(`%c[DriveTransfer] ✅ Tous les blocs reçus pour ${dl.commit.fileName} !`, 'color: #10b981; font-weight: bold;');
          this.completeDownload(dl.commit.fileId);
        } else {
          this._scheduleRequests(dl); // libère un slot -> planifie le suivant
        }
      }
    });
  }

  /**
   * Planificateur RAREST-FIRST à parallélisme borné.
   * Sélectionne les blocs manquants en commençant par les plus rares (moins de
   * fournisseurs connus), en respectant SWARM_MAX_PARALLEL_CHUNKS requêtes en vol,
   * et répartit les requêtes entre pairs fournisseurs (une source par bloc).
   */
  _scheduleRequests(dl) {
    const MAX_PARALLEL = CONFIG.DRIVE.SWARM_MAX_PARALLEL_CHUNKS;
    const now = Date.now();

    // Re-planifie les blocs dont la requête a expiré (fournisseur muet).
    // triedPeers est conservé PAR BLOC dans dl.triedPeers (survit à la suppression
    // de l'entrée inFlight) afin de ne pas re-solliciter indéfiniment un pair muet.
    for (const [hash, info] of dl.inFlight) {
      if (now - info.sentAt > CONFIG.DRIVE.CHUNK_REQUEST_TIMEOUT) {
        dl.inFlight.delete(hash);
      }
    }

    if (dl.inFlight.size >= MAX_PARALLEL) return;

    // Candidats = blocs manquants pas encore en vol, triés par rareté croissante.
    const candidates = [];
    for (const hash of dl.missingHashes) {
      if (dl.inFlight.has(hash)) continue;
      const providers = dl.providers.get(hash) || new Set();
      candidates.push({ hash, rarity: providers.size });
    }
    // rarest-first : rareté croissante ; à rareté égale, ordre stable.
    candidates.sort((a, b) => a.rarity - b.rarity);

    for (const cand of candidates) {
      if (dl.inFlight.size >= MAX_PARALLEL) break;
      const { hash } = cand;

      let tried = dl.triedPeers.get(hash);
      if (!tried) { tried = new Set(); dl.triedPeers.set(hash, tried); }

      // Choisit un fournisseur connu, connecté, pas encore essayé pour ce bloc.
      const providers = Array.from(dl.providers.get(hash) || []);
      let target = providers.find(p => !tried.has(p) && this.mesh.peers.has(p));

      // Aucun fournisseur connu (inventaire incomplet / ancien pair) :
      // repli sur un pair connecté non encore essayé, pour ne pas bloquer.
      if (!target) {
        target = Array.from(this.mesh.peers.keys()).find(p => !tried.has(p));
      }

      // Tous les pairs ont été essayés sans succès : on réinitialise l'historique
      // de ce bloc pour retenter un cycle complet (le pair peut avoir reçu le bloc
      // entre-temps), au lieu d'abandonner définitivement.
      if (!target) {
        if (tried.size > 0 && this.mesh.peers.size > 0) tried.clear();
        continue;
      }

      tried.add(target);
      dl.inFlight.set(hash, { peerId: target, sentAt: now });
      this.mesh.sendToPeer(target, { type: 'CHUNK_REQ', hash, fileId: dl.commit.fileId });
    }
  }

  /**
   * Lance le téléchargement d'un fichier complet via le maillage P2P (rarest-first).
   */
  async downloadFile(commit, onProgress = null) {
    const missingHashes = new Set();
    const providers = new Map(); // hash -> Set(peerId)
    let alreadyPresent = 0;

    for (const chunk of commit.chunks) {
      const exists = await dbManager.hasChunk(chunk.hash);
      if (exists) {
        alreadyPresent++;
      } else {
        missingHashes.add(chunk.hash);
        providers.set(chunk.hash, new Set());
      }
    }

    if (missingHashes.size === 0) {
      if (onProgress) onProgress(100);
      // Assemblage en flux même quand tout est en cache local (évite l'OOM sur un
      // gros fichier déjà entièrement répliqué).
      return await FileChunker.assembleFileStreaming(commit.chunks, commit.mimeType, commit.fileName);
    }

    return new Promise((resolve, reject) => {
      const dl = {
        commit,
        totalChunks: commit.chunks.length,
        completedChunks: alreadyPresent,
        missingHashes,
        providers,
        providersKnown: false,
        inFlight: new Map(),   // hash -> { peerId, sentAt }
        triedPeers: new Map(), // hash -> Set(peerId déjà sollicités) — survit aux timeouts
        onProgress,
        resolve,
        reject,
        startedAt: Date.now()
      };
      this.activeDownloads.set(commit.fileId, dl);

      if (onProgress) onProgress(Math.round((alreadyPresent / commit.chunks.length) * 100));

      // 1. Demande d'inventaire à tous les pairs (qui a quoi) -> carte de rareté.
      this.mesh.broadcast({
        type: 'CHUNK_AVAILABILITY_REQ',
        fileId: commit.fileId,
        hashes: Array.from(missingHashes)
      });

      // 2. Démarre une planification immédiate (repli) puis re-planifie à réception
      //    des inventaires. Boucle de relance périodique pour gérer les timeouts.
      this._scheduleRequests(dl);
      dl.pump = setInterval(() => {
        if (!this.activeDownloads.has(commit.fileId)) { clearInterval(dl.pump); return; }
        this._scheduleRequests(dl);
      }, 2000);

      // 3. Timeout global de sécurité.
      dl.timeout = setTimeout(() => {
        if (this.activeDownloads.has(commit.fileId)) {
          clearInterval(dl.pump);
          this.activeDownloads.delete(commit.fileId);
          reject(new Error(`Délai dépassé pour ${commit.fileName} (${dl.missingHashes.size} blocs manquants)`));
        }
      }, 180000);
    });
  }

  /**
   * Auto-réplication en arrière-plan (Swarm Auto-Seeding).
   */
  async autoReplicateFile(commit) {
    if (!commit || !commit.chunks || commit.chunks.length === 0) return;
    if (this.autoReplicatingFiles.has(commit.fileId)) return;
    this.autoReplicatingFiles.add(commit.fileId);

    const missing = [];
    for (const chunk of commit.chunks) {
      if (!(await dbManager.hasChunk(chunk.hash))) missing.push(chunk.hash);
    }
    if (missing.length === 0) {
      this.autoReplicatingFiles.delete(commit.fileId);
      return;
    }

    console.log(`%c[DriveTransfer] 🔄 Auto-réplication swarm pour "${commit.fileName}" (${missing.length}/${commit.chunks.length} blocs manquants)...`, 'color: #8b5cf6;');
    try {
      await this.downloadFile(commit, () => {});
      console.log(`%c[DriveTransfer] 🌟 "${commit.fileName}" entièrement répliqué ! Seeding actif.`, 'color: #10b981; font-weight: bold;');
    } catch (err) {
      console.warn(`[DriveTransfer] ⚠️ Auto-réplication partielle pour "${commit.fileName}":`, err.message);
    } finally {
      this.autoReplicatingFiles.delete(commit.fileId);
    }
  }

  async completeDownload(fileId) {
    const dl = this.activeDownloads.get(fileId);
    if (!dl) return;
    if (dl.pump) clearInterval(dl.pump);
    if (dl.timeout) clearTimeout(dl.timeout);
    this.activeDownloads.delete(fileId);

    try {
      // Assemblage en flux (streaming) pour supporter les fichiers > 1 Go sans OOM.
      const result = await FileChunker.assembleFileStreaming(dl.commit.chunks, dl.commit.mimeType, dl.commit.fileName);
      dl.resolve(result);
    } catch (e) {
      dl.reject(e);
    }
  }
}
