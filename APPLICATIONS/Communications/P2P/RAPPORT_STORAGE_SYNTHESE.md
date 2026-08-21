# 🗄️ Synthèse Maître — Swarm Groupe 2 : Stockage, Persistance & Moteur CRDT/DAG
### Projet : P2P Mesh Workspace (Extension Chrome Side Panel MV3 + Web App PWA)

**Auteurs** : Kurodo & Swarm des 10 Experts Stockage & Données Antigravity  
**Date d'évaluation** : 21 Août 2026  
**Périmètre audité** : IndexedDB v4, OPFS (Origin Private File System), Merkle Trees (RFC 6962), CRDT Anti-Entropie, Merkle DAG Versioning, Caches Bornés LRU, Quotas Disque & Éviction, Concurrence Multi-Onglets (Web Locks & BroadcastChannel), Sauvegarde ZK & Purge Zéro-Trace, Compression Temps Réel (`deflate-raw`).

---

## 1. Vue d'Ensemble & Métriques de l'Audit

Le Swarm de 10 experts a identifié **74 constats structurés** couvrant l'ensemble du cycle de vie des données décentralisées.

```
                                  ┌───────────────────────────────┐
                                  │   GROUPE 2 : DATA & STORAGE   │
                                  └───────────────┬───────────────┘
         ┌──────────────────┬─────────────────────┼─────────────────────┬──────────────────┐
         ▼                  ▼                     ▼                     ▼                  ▼
   1. OPFS Storage    2. IndexedDB v4       3. Merkle Trees & CID 4. CRDT Engine     5. Merkle DAG
      (SyncAccess)       (Composite Idx)       (RFC 6962 / CIDv1)    (Vector Clocks)    (Multi-Parents)
         │                  │                     │                     │                  │
         ├──────────────────┼─────────────────────┼─────────────────────┼──────────────────┤
         ▼                  ▼                     ▼                     ▼                  ▼
   6. Bounded Cache   7. Storage Quotas     8. Multi-Tab Locks    9. ZK Backup       10. Compression
      (LRU Byte-Aware)   (Anti-Eviction)       (BroadcastChannel)    (Zero-Trace Wipe)  (deflate-raw)
```

---

## 2. Synthèse Détaillée par Persona Expert (10 Domaines de Données)

### 1.1 Expert OPFS (Origin Private File System)
* **Recherches 2026** : Web Workers avec `FileSystemSyncAccessHandle` pour débit synchrone 300–600 Mo/s (saturation NVMe) au lieu des streams asynchrones IPC du main thread, hiérarchisation sharded `/chunks/xx/yy/<hash>.bin` (2-tier fan-out) pour éviter la saturation du dossier racine, allocation éparse (*sparse files*) et écriture in-place éliminant la double pénalité d'écriture, mode `{ mode: 'read-only' }` multi-lecteurs (Chrome 121+).
* **Findings Clés** : `OPFS-01` (P0 - Déport I/O Worker), `OPFS-02` (P1 - Sharding répertoires), `OPFS-03` (P1 - Écriture directe in-place), `OPFS-04` (P1 - Verrous read-only), `OPFS-05` (P2 - Purge `/tmp/` au boot).

### 1.2 Expert IndexedDB Avancé & Indexation
* **Recherches 2026** : Index composites avec clés sous forme de tableau (`['channelId', 'timestamp']`, `['fileId', 'versionNumber']`, `['folderPath', 'timestamp']`), requêtage par curseur paginé `IDBCursorWithValue` en direction `prev` éliminant les `getAll()` massifs (complexité $O(1)$ mémoire), transactions par lot `saveBatch` (accélération 20x sur synchro delta CRDT), hooks de cycle de vie multi-contextes `onversionchange`, `onblocked`, `onclose`.
* **Findings Clés** : `FINDING-IDB-01` (P0 - Remplacement `getAll()`), `FINDING-IDB-02` (P1 - Index composites), `FINDING-IDB-03` (P1 - Curseur générique `queryCursor`), `FINDING-IDB-04` (P1 - Migration incrémentale v4), `FINDING-IDB-05` (P1 - Hooks multi-onglets), `FINDING-IDB-06` (P1 - Écritures par lot `saveBatch`), `FINDING-IDB-07` (P2 - `getAllKeys` pour tombstones).

### 1.3 Expert Merkle Trees & Content Addressing (CID)
* **Recherches 2026** : Arbre de Merkle binaire conforme RFC 6962 avec séparation de domaine (`0x00` feuilles, `0x01` nœuds internes) remplaçant le faux hash plat `join(':')`, preuves d'inclusion Merkle SPV $O(\log N)$ (448 octets pour 8 Go), format d'adressage standardisé CIDv1 Base32 (`bafy...`), sanction et pénalisation automatique des pairs injectant des blocs corrompus (*Slice Poisoning defense*), validation de la racine Merkle à l'assemblage complet du fichier.
* **Findings Clés** : `CID-01` (P0 - Vrai arbre Merkle RFC 6962), `CID-02` (P0 - Recalcul de racine à l'assemblage), `CID-03` (P1 - Pénalisation pairs malveillants), `CID-04` (P1 - CIDv1 Base32), `CID-05` (P1 - FastCDC boundary-shift mitigation).

### 1.4 Expert Moteur CRDT & Anti-Entropie
* **Recherches 2026** : Vector Clocks / State Vectors `Map<peerId, seq>` éliminant la vulnérabilité aux dérives d'horloges physiques, tombstones de suppression pour les dossiers (`drive_folder_deletions`) empêchant la résurrection d'état au retour d'un pair hors-ligne, horizon de rétention des tombstones ($T_{\text{horizon}} = 30$ jours), initialisation de l'horloge de Lamport au maximum de la base locale + borne anti-empoisonnement (`MAX_DRIFT = 100 000`), mutex sur l'ajout de réponses de forum pour éliminer les Lost Updates.
* **Findings Clés** : `CRDT-01` (P0 - Vector Clocks anti-perte), `CRDT-02` (P0 - Tombstones dossiers), `CRDT-03` (P1 - Horizon GC tombstones), `CRDT-04` (P1 - Pagination curseur anti-entropie), `CRDT-05` (P1 - Persistance & borne Lamport), `CRDT-06` (P1 - Mutex forum), `CRDT-08` (P2 - Méthode `destroy()`).

### 1.5 Expert Versioning Git-like & Merkle DAG
* **Recherches 2026** : Identifiant de commit immuable 256-bit SHA-256 (`cmt_${fullHash}`) calculé sur la forme canonique normalisée (RFC 8785 JCS) éliminant la troncature 16 caractères et les collisions, topologie multi-parents (`parents: string[]`) pour la gestion des branches concurrentes et commits de fusion, détection des têtes actives de DAG (*DAG Heads*) et signalement des forks dans l'UI, contrôle pré-vol avant restauration (*Ghost Revert Prevention*), Ramasse-Miettes Mark-and-Sweep sur les blocs binaires orphelins.
* **Findings Clés** : `DAG-01` (P0 - CommitId SHA-256 canonique 256-bit), `DAG-02` (P0 - Gestion des forks Merkle-CRDT), `DAG-03` (P1 - CDC dédoublonnage), `DAG-04` (P1 - Arbre binaire), `DAG-05` (P1 - GC Mark-and-Sweep), `DAG-06` (P1 - Revert vérifié).

### 1.6 Expert Cache Borné & Fuites Mémoire (Memory Leaks)
* **Recherches 2026** : Cache LRU pondéré en octets (`BoundedLRUCache` avec double contrainte `maxItems` et `maxBytes` + repositionnement sur `get`), gestion de cycle de vie stricte des Blob URLs (révocation synchrone des vignettes staged dans `renderStaged`, révocation immédiate des Blob URLs de téléchargement non affichés), limitation de `pendingChunkSlices` à 128 blocs actifs, service de surveillance du Heap (`MemoryPressureService` observant `performance.memory` avec disjoncteur anti-OOM).
* **Findings Clés** : `FINDING-MEM-01` (P0 - LRU Byte-Aware), `FINDING-MEM-02` (P0 - Fuite Blob URLs staged), `FINDING-MEM-03` (P1 - Isolation cache média vs download), `FINDING-MEM-04` (P1 - Révocation modale synchronisée), `FINDING-MEM-05` (P1 - Bounded slices DoS protection), `FINDING-MEM-06` (P1 - Heap Monitor anti-crash).

### 1.7 Expert Quotas Disque & Éviction Navigateur
* **Recherches 2026** : Statut explicite de persistance (`isPersisted()` et `requestPersistence()`), correction de l'auto-réplication swarm (téléchargement des chunks seuls sans assemblage de fichier complet temporaire, éliminant la fuite de 200% d'espace disque), interception réactive de `QuotaExceededError` avec évacuation d'urgence automatique, balayage au démarrage des fichiers temporaires orphelins (`sweepStaleTempFiles`), marge pré-vol dynamique (2.1x download, 1.15x réplication).
* **Findings Clés** : `FINDING-DISK-01` (P0 - Persistance interactive), `FINDING-DISK-02` (P0 - Élimination fuite 200% auto-réplication), `FINDING-DISK-03` (P1 - Interception `QuotaExceededError`), `FINDING-DISK-04` (P1 - `purgeOrphanChunks` GC), `FINDING-DISK-05` (P1 - Marges quota dynamiques), `FINDING-DISK-07` (P2 - Balayage temporaires boot).

### 1.8 Expert Concurrence Multi-Onglets & Web Locks
* **Recherches 2026** : Verrous exclusifs Web Locks (`navigator.locks.request('opfs:chunk:${hash}')`) éliminant les collisions `NoModificationAllowedError`, bus local `BroadcastChannel('pmesh_tab_sync')` propageant instantanément les mutations d'état entre fenêtres locales (Side Panel ⇆ WebApp) sans boucle réseau WebRTC, élection de leader (`TabLeaderElection`) dédiant les connexions relais Nostr et l'auto-seeding à un unique onglet actif, synchronisation de l'horloge de Lamport au démarrage.
* **Findings Clés** : `FINDING-LOCK-01` (P0 - Verrous Web Locks OPFS), `FINDING-CRDT-02` (P1 - Verrous threads/dossiers), `FINDING-SYNC-03` (P1 - BroadcastChannel inter-onglets), `FINDING-LEAD-04` (P1 - Leader Election), `FINDING-IDB-05` (P1 - Migration multi-onglets sûre).

### 1.9 Expert Sauvegarde, Export & Portabilité Zéro-Serveur
* **Recherches 2026** : Élimination absolue du code papier maître en clair dans IndexedDB (`settings.last_paper_code`), conteneur de sauvegarde sécurisé Zéro-Knowledge chiffré en AES-GCM-256 avec PBKDF2-SHA512 (600 000 itérations) et sel aléatoire 256-bit, validation de schéma stricte anti-pollution de prototype avant restauration avec transaction atomique réversible (Rollback), procédure de purge intégrale irréversible (*Zero-Trace Wipe* / Database Shredding).
* **Findings Clés** : `EXP-1.9-001` (P0 - Suppression secret clair), `EXP-1.9-002` (P0 - Zero-Trace Wipe complet), `EXP-1.9-003` (P0 - Format export chiffré ZK), `EXP-1.9-004` (P1 - Restauration atomique validée), `EXP-1.9-005` (P1 - Vérification SHA-256 à la lecture).

### 1.10 Expert Compression Temps Réel & WebAssembly
* **Recherches 2026** : Micro-module natif `StreamCompressor` utilisant `CompressionStream('deflate-raw')` et `DecompressionStream('deflate-raw')` pour réduire de 75% à 85% la bande passante des deltas CRDT et historiques, compression en amont du chiffrement (éliminant la pénalité d'inflation hexadécimale du transport WebRTC), seuil adaptatif de compression ($\ge 256$ octets) évitant l'overhead CPU sur les signaux de frappe éphémères.
* **Findings Clés** : `COMP-01` (P0 - Compression deltas CRDT), `COMP-02` (P0 - Compression avant chiffrement binaire), `COMP-03` (P1 - Compression archives locales), `COMP-05` (P1 - Seuil adaptatif 256B), `COMP-06` (P1 - Réassemblage Uint8Array).

---

## 3. Plan d'Implémentation Immédiat des Correctifs P0/P1

1. **`core/stream-compressor.js`** : Création du module natif de compression/décompression par flux (`deflate-raw`).
2. **`modules/drive/merkle-tree.js`** : Création du module d'arbre de Merkle binaire RFC 6962 et validation de racine.
3. **`core/local-storage.js`** : Montée en IndexedDB v4 avec index composites, pagination `queryCursor`, `saveBatch`, `sweepStaleTempFiles()`, `purgeOrphanChunks()`, `isPersisted()`, `requestPersistence()`, et vérification SHA-256.
4. **`core/bounded-cache.js`** : Refonte en `BoundedLRUCache` avec double seuil `maxItems`/`maxBytes` et ordonnancement LRU dynamique.
5. **`modules/drive/versioning-dag.js`** : Hash de commit canonique SHA-256 256-bit, détection de forks multi-parents et Merkle root intégrée.
6. **`modules/drive/drive-transfer.js`** : Correction de l'auto-réplication pour ne plus accumuler de fichiers assemblés temporaires, recalcul de racine Merkle dans `completeDownload`.
7. **`core/crdt-engine.js`** : Intégration de `BroadcastChannel` local, initialisation Lamport depuis la base locale et support de `drive_folder_deletions`.
8. **`modules/auth/auth-controller.js`** : Suppression de l'écriture en clair du code papier dans IndexedDB.
