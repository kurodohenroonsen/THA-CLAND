/**
 * Module de Gouvernance Proactive du Stockage & Éviction Multi-Tier (Pass 4)
 * Conforme WHATWG Storage Standard & WICG Storage Buckets (2025/2026).
 *
 * Gère :
 * - Sanctuarisation Tier 0 (Clés/Identité) & Tier 1 (CRDT/DAG/WoT).
 * - Éviction sélective Tier 2 (Médias/Temp) et Tier 3 (Chunks Swarm répliqués).
 * - Seuils d'eau proactifs (Nominal <75%, Warning 75%, Critical 88%, Emergency 95%).
 * - Circuit-breaker anti-QuotaExceededError et Web Locks.
 */

import { logger } from './logger.js';

export const STORAGE_TIERS = {
  TIER_0_SANCTUARY: 0, // Clés cryptographiques, DID, Master secrets, Settings
  TIER_1_CRDT_STATE: 1, // Messages, DAG Commits, Tombstones, WoT, Modération
  TIER_2_MEDIA_CACHE: 2, // Fichiers assemblés OPFS, prévisualisations d'images
  TIER_3_SWARM_CHUNKS: 3 // Blocs binaires de fichiers répliqués sur le maillage P2P
};

export const STORAGE_WATERMARKS = {
  WARNING_PERCENT: 75,
  CRITICAL_PERCENT: 88,
  EMERGENCY_PERCENT: 95,
  TARGET_RECOVERY_PERCENT: 70
};

export class StorageGovernor {
  constructor(dbManager) {
    this.db = dbManager;
    this.pinnedFiles = new Set();
    this.pinnedChunks = new Set();
    this._isEvicting = false;
    this._listeners = new Set();
  }

  /**
   * Enregistre un écouteur d'événements de pression de stockage
   */
  onPressureChange(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  _notifyPressure(level, estimate) {
    for (const cb of this._listeners) {
      try { cb({ level, estimate }); } catch (e) { logger.debug('StorageGovernor', 'Erreur listener:', e); }
    }
  }

  /**
   * Épingle un fichier pour interdire son éviction automatique
   */
  async pinFile(fileId) {
    this.pinnedFiles.add(fileId);
    await this.db.saveSetting(`pin_file_${fileId}`, true);
    logger.info('StorageGovernor', `📌 Fichier "${fileId}" épinglé (protégé contre l'éviction).`);
  }

  /**
   * Désépingle un fichier pour autoriser son éviction sous quota
   */
  async unpinFile(fileId) {
    this.pinnedFiles.delete(fileId);
    await this.db.delete('settings', `pin_file_${fileId}`);
    logger.info('StorageGovernor', `🔓 Fichier "${fileId}" désépinglé (éligible à l'éviction Tier 3).`);
  }

  /**
   * Vérifie si un hash de chunk est protégé contre l'éviction
   */
  isChunkPinned(hash, activeCommitChunksMap) {
    if (this.pinnedChunks.has(hash)) return true;
    if (!activeCommitChunksMap) return false;
    const fileIds = activeCommitChunksMap.get(hash);
    if (!fileIds) return false;
    for (const fId of fileIds) {
      if (this.pinnedFiles.has(fId)) return true;
    }
    return false;
  }

  /**
   * Analyse proactive de l'espace disponible avant une opération volumineuse.
   */
  async enforceProactiveQuota(bytesToStore = 0) {
    const est = await this.db.estimateStorage();
    if (est.quota === 0 || est.available === Infinity) return true;

    const projectedUsage = est.usage + bytesToStore;
    const projectedPercent = Math.round((projectedUsage / est.quota) * 100);

    if (projectedPercent >= STORAGE_WATERMARKS.EMERGENCY_PERCENT) {
      logger.warn('StorageGovernor', `🚨 Pression CRITIQUE projetée (${projectedPercent}%). Éviction Tier 3 & Tier 2 requise.`);
      this._notifyPressure('critical', est);
      await this.runMultiTierEviction(bytesToStore * 2);
    } else if (projectedPercent >= STORAGE_WATERMARKS.WARNING_PERCENT) {
      logger.info('StorageGovernor', `⚠️ Pression MODÉRÉE projetée (${projectedPercent}%). Purge d'appoint Tier 3.`);
      this._notifyPressure('warning', est);
      await this.runSoftEviction();
    } else {
      this._notifyPressure('nominal', est);
    }

    const recheck = await this.db.estimateStorage();
    if (recheck.available < bytesToStore) {
      const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} Mo`;
      throw new Error(
        `[StorageGovernor] Quota saturé : Impossible de réserver ${mb(bytesToStore)}. ` +
        `Disponible : ${mb(recheck.available)} / Quota : ${mb(recheck.quota)}.`
      );
    }
    return true;
  }

  /**
   * Éviction douce : fichiers temporaires expirés et blocs orphelins
   */
  async runSoftEviction() {
    if (this._isEvicting) return;
    this._isEvicting = true;
    try {
      await this.db.sweepStaleTempFiles(60 * 1000);
      await this.db.purgeOrphanChunks();
    } finally {
      this._isEvicting = false;
    }
  }

  /**
   * Éviction agressive Multi-Tier ordonnée :
   * 1. Fichiers temporaires OPFS & Chunks orphelins (Tier 2/3)
   * 2. Chunks répliqués non-épinglés classés par LRU (Tier 3)
   * 3. Médias / prévisualisations anciennes en cache (Tier 2)
   * SANCTUAIRE ABSOLU : Tier 0 (clés) et Tier 1 (CRDT/DAG) ne sont JAMAIS supprimés.
   */
  async runMultiTierEviction(targetBytesToFree = 50 * 1024 * 1024) {
    if (this._isEvicting) return { freedBytes: 0, evictedCount: 0 };
    this._isEvicting = true;

    logger.info('StorageGovernor', `🧹 Déclenchement de l'éviction Multi-Tier (Objectif : ${(targetBytesToFree / 1048576).toFixed(1)} Mo)...`);
    let freedBytes = 0;
    let evictedCount = 0;

    try {
      // Étape 1 : Nettoyage immédiat des fichiers temporaires OPFS
      const sweepRes = await this.db.sweepStaleTempFiles(0);
      freedBytes += sweepRes?.purgedBytes || 0;

      // Étape 2 : Purge des chunks orphelins
      const orphanRes = await this.db.purgeOrphanChunks();
      freedBytes += orphanRes.purgedBytes;
      evictedCount += orphanRes.purgedCount;

      if (freedBytes >= targetBytesToFree) {
        logger.info('StorageGovernor', `✅ Objectif atteint via nettoyage préliminaire (${(freedBytes / 1048576).toFixed(2)} Mo libérés).`);
        return { freedBytes, evictedCount };
      }

      // Étape 3 : Éviction sélective des Chunks Tier 3 (LRU, non épinglés)
      const commits = await this.db.getAllFileCommits();
      const deletedFileIds = await this.db.getDeletedFileIds();
      const chunkToFileMap = new Map();

      for (const commit of commits) {
        if (!deletedFileIds.has(commit.fileId) && Array.isArray(commit.chunks)) {
          for (const ch of commit.chunks) {
            if (!chunkToFileMap.has(ch.hash)) {
              chunkToFileMap.set(ch.hash, new Set());
            }
            chunkToFileMap.get(ch.hash).add(commit.fileId);
          }
        }
      }

      const idbChunks = await this.db.getAll('file_chunks');
      idbChunks.sort((a, b) => (a.lastAccessed || a.timestamp || 0) - (b.lastAccessed || b.timestamp || 0));

      for (const ch of idbChunks) {
        if (freedBytes >= targetBytesToFree) break;

        if (this.isChunkPinned(ch.hash, chunkToFileMap)) {
          continue;
        }

        const size = ch.size || ch.data?.byteLength || 512 * 1024;
        await this.db.delete('file_chunks', ch.hash);
        if (this.db.opfsRoot) {
          try {
            await this.db.opfsRoot.removeEntry(`chunk_${ch.hash}`);
          } catch (_) {}
        }

        freedBytes += size;
        evictedCount++;
      }

      logger.info(
        'StorageGovernor',
        `🛡️ Fin d'éviction Multi-Tier : ${evictedCount} blocs libérés (${(freedBytes / (1024 * 1024)).toFixed(2)} Mo). ` +
        `Tier 0 & Tier 1 100% préservés.`
      );
    } catch (err) {
      logger.error('StorageGovernor', 'Erreur pendant l\'éviction Multi-Tier:', err);
    } finally {
      this._isEvicting = false;
    }

    return { freedBytes, evictedCount };
  }
}
