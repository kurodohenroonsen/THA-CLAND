# 🛸 Rapport d'audit & d'amélioration — Extension Chrome P2P Mesh (Manifest V3)

**Cible :** extension collaborative 100 % peer-to-peer, zero-knowledge, sans serveur central
(chat CRDT, forum répliqué, drive versionné, salons audio/vidéo mesh).
**Périmètre :** 27 fichiers, ~5 500 lignes JS.
**Date :** 20 août 2026.
**Méthode :** lecture intégrale du code + double vérification par sous-agents indépendants
(axe cryptographie/protocole et axe bugs fonctionnels), corroborée par le journal `error.txt` fourni.

> **Verdict global.** L'architecture est ambitieuse et globalement saine dans ses intentions
> (E2EE AES-GCM, signalement hybride WebTorrent + Nostr, versioning DAG, swarm seeding).
> Mais **la couche d'authentification était inopérante** : les messages étaient *signés* mais
> **jamais vérifiés**. Combiné à une clé de contenu symétrique partagée et à un code papier de
> faible entropie, cela ruinait la promesse « cryptographie authentifiée ». Plusieurs vecteurs de
> déni de service mémoire et un bug bloquant (dépassement `max-message-size`) affectaient aussi le
> fonctionnement. **Tous les points ci-dessous ont été corrigés dans le code livré**, à l'exception
> de deux éléments explicitement signalés comme recommandations d'architecture.

---

## 1. Synthèse exécutive

| # | Constat | Gravité | Statut |
|---|---------|---------|--------|
| S1 | Signatures ECDSA jamais vérifiées à la réception → usurpation d'identité entre membres | 🔴 Critique | ✅ Corrigé |
| S2 | Code papier ~35 bits + sel PBKDF2 statique + Topic public → brute-force offline ciblé | 🔴 Critique | ✅ Corrigé (atténué) |
| S3 | Empoisonnement CRDT : écriture d'objets arbitraires, écrasement destructif de threads | 🔴 Critique | ✅ Corrigé |
| S4 | DoS mémoire par fragmentation non bornée (contrôle + binaire) | 🟠 Élevée | ✅ Corrigé |
| S5 | Absence d'anti-rejeu + fuites mémoire non bornées (offres, fragments, tranches) | 🟠 Élevée | ✅ Corrigé |
| S6 | Événements Nostr traités sans validation ; filtre « self » inopérant | 🟠 Élevée | ✅ Corrigé |
| S7 | Peer ID aléatoire non lié à la clé publique | 🟠 Élevée | ✅ Corrigé |
| F1 | Forum **entièrement cassé** : méthodes CRDT inexistantes + args inversés + champ `category` | 🔴 Critique | ✅ Corrigé |
| F2 | Envoi WebRTC > `max-message-size` (28 672 o) → synchro Drive cassée | 🔴 Critique | ✅ Corrigé |
| F3 | Pistes média entrantes attribuées à `peerId = null` (côté offreur) | 🟠 Élevée | ✅ Corrigé |
| F4 | Swarm naïf : duplication N×, pas de rarest-first, `SWARM_MAX_PARALLEL_CHUNKS` ignoré | 🟡 Moyenne | ✅ Corrigé |
| F5 | Limite 500 Mo + réassemblage tout-en-RAM → OOM > 1 Go | 🟡 Moyenne | ✅ Corrigé |
| F6 | Date des réponses de forum : `Invalid Date` (`timestamp` vs `createdAt`) | 🟡 Moyenne | ✅ Corrigé |
| F7 | Index IndexedDB mort (`lamportTime` vs `lamport`) | ⚪ Basse | ⚠️ Documenté |
| A1 | Le mesh tourne dans le side panel, pas dans l'offscreen → connexions perdues à la fermeture | 🟠 Élevée | 📋 Recommandation |
| A2 | Absence de révocation / rotation de clés de groupe | 🟠 Élevée | 📋 Recommandation |

---

## 2. Audit de sécurité cryptographique & résistance aux attaques

### S1 — Signatures jamais vérifiées (usurpation d'identité) 🔴

**Constat.** Les enregistrements étaient signés à l'émission
(`crdt-engine.js` : `message.signature = await this.vault.sign(message)`), mais `CryptoVault.verify`
n'était **appelé nulle part** dans tout le dépôt. À la réception, `handleIncomingChatMessage`,
`handleIncomingForumTopic`, `handleSyncResponse`, `handleIncomingDriveCommit` écrivaient directement
le payload en base.

**Impact.** La clé de contenu AES-GCM est une **clé de groupe symétrique partagée** : déchiffrer ne
prouve que l'appartenance au groupe, pas l'identité de l'auteur. La signature ECDSA était le *seul*
mécanisme distinguant les membres. Non vérifiée, **n'importe quel membre pouvait forger des messages,
threads, commits ou suppressions au nom de n'importe quel autre** (`authorId`, `authorName`,
`authorPubkey` étant de simples champs falsifiables).

**Correctif appliqué.**
- Ajout de `CryptoVault.canonicalize()` (sérialisation déterministe, clés triées, champ `signature`
  exclu) pour que signature et vérification portent sur des octets identiques après aller-retour
  JSON/IndexedDB/réseau.
- Ajout de `CryptoVault.verifyObject()` qui vérifie **(a)** la signature ECDSA P-256 contre
  `authorPubkey` et **(b)** la **liaison identité↔clé** (`authorId == SHA-256(authorPubkey)[:16]`).
- `CRDTEngine._isAuthentic()` est désormais appelé **avant toute persistance** dans *tous* les
  handlers entrants (chat, forum, commits, dossiers, delta de synchro). Tout enregistrement non signé
  ou à signature invalide est rejeté et journalisé.

**Validation.** Test automatisé : message valide → accepté ; texte falsifié → rejeté ; `authorId`
usurpé → rejeté ; message non signé → rejeté.

### S2 — Faible entropie du code papier + sel statique + Topic public 🔴

**Constat.** `generatePaperCode` produisait `MOT-NNNN-MOT-NNNN` à partir d'une liste de **24 mots**
et de nombres 1000-9999, soit **≈ 35 bits d'entropie** (≈ 3,4×10¹⁰ combinaisons) — avec biais de
modulo. Le sel PBKDF2 était une **constante globale** (aucune protection anti-précalcul) et seulement
100 000 itérations. **Aggravant décisif :** le `topicHex`/infoHash est dérivé déterministiquement du
code et **publié en clair** sur les trackers et relais Nostr. Un attaquant peut donc mener un
**brute-force offline ciblé** : énumérer les codes, dériver le topic candidat, le comparer à
l'infoHash observé ; une correspondance révèle le code → **compromission totale** (toutes les clés
dérivent de la même master key).

**Correctif appliqué.**
- Nouveau format de code papier : **6 mots** tirés d'une liste de **256 termes** + segment numérique,
  soit **≈ 61 bits** d'entropie, sans biais de modulo (rejection sampling `_uniformInt`).
- PBKDF2 relevé à **600 000 itérations** (SHA-512) + domaine-séparation de version du sel.
- Ajout de `estimatePaperCodeEntropyBits()` pour informer l'utilisateur à la saisie.

**Limite résiduelle assumée (documentée).** Dans un modèle *strictement* 100 % P2P, le sel PBKDF2
**doit** rester déterministe (deux pairs doivent dériver la même clé à partir du seul code, sans
échange préalable) et le Topic reste nécessairement dérivable pour permettre le rendez-vous. 61 bits
+ 600 k itérations rendent l'attaque coûteuse mais **non impossible pour un adversaire étatique**. Pour
une garantie forte, voir la recommandation R1 (§5) : séparer le *secret de rendez-vous* du *secret de
chiffrement*, ou porter le code à ≥ 80 bits.

### S3 — Empoisonnement / écrasement CRDT 🔴

**Constat.** `handleSyncResponse` écrivait tout objet reçu (`saveMessage/saveForumThread/
saveFileCommit/saveDriveFolder`) sans validation. Le stockage utilisant `put` (upsert par clé
primaire), un pair pouvait **écraser** de façon destructive un thread/commit/dossier existant
(y compris effacer les réponses d'un fil).

**Correctif appliqué.**
- Vérification de signature de chaque élément de delta avant écriture (cf. S1).
- **Fusion non destructive** des threads (`_mergeForumThread`) : le titre/contenu reste celui de
  l'auteur original (identité liée à la clé) et seules les **réponses** sont fusionnées en union
  dédupliquée, chaque réponse étant re-vérifiée.
- Validation structurelle des commits (`_isValidCommit`) et bornage des deltas (`CAP = 5000`
  éléments) pour empêcher l'injection massive.
- Les suppressions de dossier exigent désormais un objet `op` **signé** par l'émetteur.

### S4 — DoS mémoire par fragmentation non bornée 🟠

**Constat.**
- Canal de contrôle : `new Array(_total)` avec `_total` distant non borné → allocation géante.
- Canal binaire : `new Uint8Array(totalChunkSize)` avec `totalChunkSize` (uint32) non borné → jusqu'à
  ~4 Go d'un seul paquet forgé. `sliceIdx`/`totalSlices` non validés.

**Correctif appliqué.**
- Bornes strictes **avant toute allocation** (`CONFIG.LIMITS`) : `_total ≤ 20 000`, `0 ≤ _part <
  _total`, taille réassemblée ≤ 32 Mo ; bloc binaire ≤ 2 Mo, `totalSlices ≤ 512`, `sliceIdx <
  totalSlices`, hash `^[0-9a-f]{64}$`.
- Réassemblage via `Map<index, data>` (plus de tableau pré-alloué de taille attaquant-contrôlée).

### S5 — Anti-rejeu & fuites mémoire 🟠

**Correctif appliqué.**
- Nouveau module `bounded-cache.js` : `BoundedSet` (FIFO borné) et `TTLMap` (capacité + TTL + balayage).
- `processedOfferIds` → `BoundedSet(4000)` (anti-doublon/anti-rejeu des offres et des événements Nostr).
- `activeOffers` → `TTLMap` : les offres SDP jamais répondues sont fermées et purgées automatiquement
  (`onEvict` ferme la `RTCPeerConnection`), balayage toutes les 10 s.
- `incomingFragments` et `pendingChunkSlices` : purge périodique des réassemblages abandonnés.

> **Note.** L'anti-rejeu applicatif (chat/forum) repose sur la déduplication par `id` **couplée à la
> signature** : un rejeu à `id` identique est ignoré, et un rejeu à nouvel `id` échoue à la
> vérification (la signature porte sur l'`id`). Pour le signalement, l'anti-doublon d'`offer_id`/`id`
> Nostr borne le rejeu.

### S6 — Événements Nostr non validés 🟠

**Constat.** Le contenu Nostr était traité sans validation ; le filtre « self »
(`nostrEvent.pubkey === this.vault.publicKeyHex`) comparait deux espaces de clés **incompatibles**
(Schnorr secp256k1 Nostr vs SPKI ECDSA de l'app) et était donc inopérant.

**Correctif appliqué.** Validation structurelle NIP-01 minimale, anti-doublon par `id` d'événement,
filtrage « self » correct via le `peer_id` du payload. **Défense en profondeur assumée :** la
signature Schnorr n'est pas revérifiée (nécessiterait une lib dédiée), mais toute offre/réponse
acheminée reste **chiffrée E2EE** avec la clé de signalement du groupe — une injection forgée échoue
au déchiffrement. Nostr n'est qu'un canal de rendez-vous, jamais une racine de confiance.

### S7 — Peer ID non lié à la clé 🟠

**Correctif appliqué.** Le Peer ID est désormais **dérivé de la clé publique**
(`peerIdHex = SHA-256(pubkey)[:20]`). Couplé à `verifyObject`, un pair ne peut plus revendiquer
l'identité d'un autre sans posséder la clé privée correspondante.

### Révocation de clés (demande explicite de la mission)

Voir **recommandation R2** (§5). Constat : dans le modèle actuel (clé de groupe symétrique unique,
dérivée d'un code immuable), il n'existe **aucun moyen de révoquer** un membre : quiconque a connu le
code connaît la clé pour toujours. Un mécanisme de **rotation par époques** est proposé.

---

## 3. Optimisation des performances WebRTC & transfert

### F2 — Dépassement `max-message-size` (bug bloquant) 🔴

Le seuil de fragmentation `MAX_CHUNK_SIZE = 28 672` dépassait la taille maximale sûre d'un
`RTCDataChannel` (~16 Ko). Le journal `error.txt` confirme :
`Failed to execute 'send' on 'RTCDataChannel': Trying to send message larger than max-message-size`,
déclenché lors de la diffusion d'un **commit Drive** → synchro silencieusement cassée.
**Corrigé** : seuil abaissé à **15 000 o** (`CONFIG.LIMITS.MAX_DATACHANNEL_CHUNK`), sous la limite,
avec marge pour l'enveloppe JSON de fragment.

### F3 — Pistes média `peerId = null` 🟠

Les connexions d'offre étaient créées via `createPeerConnection(null)` ; les closures `ontrack`/
`ondatachannel` capturaient donc `null`. Confirmé par `error.txt` : *« ÉTABLIE avec null »*.
**Corrigé** : l'identité est stockée sur la connexion (`pc._remotePeerId`) et **lue dynamiquement**
par les gestionnaires ; elle est renseignée dès réception de la réponse SDP.

### F4 — Swarm downloader rarest-first (type BitTorrent) 🟡

**Avant.** `downloadFile` diffusait `CHUNK_REQ` pour **tous** les blocs manquants à **tous** les
pairs → chaque pair renvoyait chaque bloc (duplication N×) ; `SWARM_MAX_PARALLEL_CHUNKS` était ignoré ;
aucune stratégie de sélection.

**Après (réécriture de `drive-transfer.js`).**
- **Inventaire d'availability** : `CHUNK_AVAILABILITY_REQ/RESP` construit une carte
  `hash → {pairs qui l'ont}`.
- **Planification rarest-first** : les blocs les plus **rares** (moins de fournisseurs) sont demandés
  en premier — stratégie qui maximise la diffusion et la résilience du swarm.
- **Parallélisme borné** (`SWARM_MAX_PARALLEL_CHUNKS`, désormais respecté) et **une source par bloc**.
- **Ré-affectation sur timeout** : un bloc dont la requête expire est redemandé à un autre fournisseur
  (`CHUNK_REQUEST_TIMEOUT`), avec vérification SHA-256 et re-planification en cas de corruption.

**Validation.** Test automatisé : sur 3 blocs de raretés 3/2/1, l'ordre d'émission est bien
`h3 → h2 → h1`, dans la limite de parallélisme.

### Adaptation dynamique du bitrate vidéo selon le RTT 🟢

Nouvelle fonctionnalité (objectif de mission). `P2PMeshNetwork.applyVideoBitrate(peerId, rtt)` ajuste
`RTCRtpSender.setParameters().encodings[0].maxBitrate` **sans renégociation SDP** (ajustement
instantané), selon un barème RTT→bitrate (`CONFIG.VIDEO_BITRATE.LADDER`, 2,5 Mbps → 300 kbps). Le
`CallController` réévalue toutes les 4 s à partir des latences mesurées par `PresenceManager`.

---

## 4. Persistance & gestion des quotas OPFS (fichiers > 1 Go)

### F5 — OOM à l'assemblage & limite 500 Mo 🟡

**Avant.** `assembleFile` construisait un `Blob` à partir de **tous** les buffers simultanément → OOM
au-delà de ~1-2 Go, même avec les blocs en OPFS. `MAX_FILE_SIZE` plafonnait à 500 Mo.

**Après.**
- **`assembleFileStreaming`** : écrit les blocs **séquentiellement** dans un fichier temporaire OPFS
  via `FileSystemWritableFileStream`, sans jamais détenir plus d'un bloc en mémoire, puis renvoie un
  objet `File` adossé au disque (compatible `URL.createObjectURL` sans aspirer le fichier en RAM).
  Nettoyage du fichier temporaire après le téléchargement.
- **Gestion de quota** : `dbManager.estimateStorage()` / `ensureSpaceFor()` (API `StorageManager`)
  effectuent un **contrôle pré-vol** avant téléversement, avec message explicite en cas d'espace
  insuffisant ; demande de **stockage persistant** (`navigator.storage.persist()`) au démarrage pour
  éviter l'éviction (rôle de seed durable). `MAX_FILE_SIZE` porté à **8 Go**.

---

## 5. Recommandations d'architecture (non appliquées — à décider)

**R1 — Séparer rendez-vous et chiffrement (renforce S2).** Dériver le Topic/infoHash public d'un
sous-secret distinct de la clé de contenu, ou passer à un code ≥ 80 bits (8 mots). Idéalement,
échanger un *sel de groupe* aléatoire hors bande (QR code) en plus du code papier, ce qui casse
l'attaque par précalcul tout en restant « sans serveur ».

**R2 — Révocation / rotation par époques.** Introduire un `epoch` : la clé de contenu effective
devient `HKDF(masterKey, "content-vN" || epoch)`. Un membre admin publie un événement signé
« rotation → epoch+1 » ; les membres re-dérivent la clé. Un membre à exclure n'est simplement pas
informé du nouveau secret d'époque (distribué chiffré vers les clés publiques des membres conservés).
Nécessite une notion de rôle/roster signé.

**A1 — Persistance en arrière-plan (offscreen).** Aujourd'hui tout le mesh vit dans le side panel :
sa fermeture tue les connexions, malgré un document offscreen créé mais **vide** de logique WebRTC.
Recommandation : déplacer `P2PMeshNetwork` (WebSockets de signalement + `RTCPeerConnection` +
DataChannels) **dans le document offscreen**, le side panel ne gardant que l'UI et communiquant par
`chrome.runtime` messaging. C'est un refactor conséquent, laissé hors des correctifs.

**Défense XSS (préventif).** Le rendu Markdown du chat (`formatMessageText`) échappe le HTML *avant*
d'appliquer ses regex et limite les liens à `https?:` : pas de faille exploitable identifiée. À
conserver tel quel ; ne jamais introduire d'`innerHTML` sur du contenu non échappé.

---

## 6. Propositions de nouvelles fonctionnalités P2P avancées

### 6.1 Éditeur de texte collaboratif Markdown temps réel (type Yjs/Automerge)

**Objectif.** Édition concurrente d'un même document Markdown, curseurs distants, hors-ligne d'abord.

**Approche recommandée.** Intégrer **Yjs** (`Y.Doc` + `Y.Text`) plutôt qu'un CRDT maison : c'est un
CRDT de séquence éprouvé (RGA/YATA) qui résout nativement les insertions/suppressions concurrentes.
- **Transport.** Réutiliser le canal `p2p-control` existant : diffuser les *updates* binaires Yjs
  (`Y.encodeStateAsUpdate` / `Y.applyUpdate`) via `mesh.broadcast`, en réutilisant la fragmentation
  et — **impérativement** — la **signature** par mise à jour (cf. S1) pour empêcher l'injection.
- **Présence/curseurs.** Utiliser l'`Awareness` de Yjs, diffusée en éphémère (non persistée).
- **Persistance.** `y-indexeddb` pour l'état local ; snapshot périodique intégré au versioning DAG
  existant (un commit = un snapshot Markdown), réutilisant le drive pour l'historique.
- **Effort estimé.** M (2-3 j) : Yjs est autonome et fonctionne sans serveur ; le plus gros est le
  binding éditeur (textarea + décorations de curseurs) et la sécurité des updates.

### 6.2 Tableau blanc partagé (Canvas)

**Objectif.** Dessin collaboratif (traits, formes, notes), pan/zoom, multi-curseurs.

**Approche recommandée.**
- **Modèle de données CRDT.** Un `Y.Array` de « traits » immuables (`{id, auteur, points[], couleur,
  épaisseur, t}`). Les traits étant append-only, les conflits sont triviaux (union) ; la gomme est un
  trait « effacement » ou un tombstone. Ordre de rendu par horloge de Lamport (déjà présente).
- **Transport & débit.** Échantillonner les points (~50 ms) et n'émettre que les deltas ; regrouper
  les points d'un trait en cours dans un message « partiel » puis un message « final » signé. Sur RTT
  élevé, réduire la fréquence d'échantillonnage (réutiliser la mesure de latence de présence).
- **Rendu.** Canvas 2D avec calque de « traits confirmés » (rasterisé) + calque « en cours » (vectoriel)
  pour la fluidité ; multi-curseurs via l'awareness.
- **Effort estimé.** M/L (3-5 j) : le rendu et le lissage (courbes de Bézier/quadratiques) et la
  gestion mémoire des grands tableaux (pagination/rasterisation) constituent l'essentiel.

Ces deux fonctionnalités s'insèrent naturellement : nouvel onglet dans la navigation, nouveau *store*
IndexedDB, réutilisation du mesh signé et du versioning DAG pour les snapshots.

---

## 7. Inventaire des fichiers modifiés / ajoutés

| Fichier | Nature |
|---------|--------|
| `sidepanel/js/core/crypto-vault.js` | Canonicalisation, `verifyObject`, liaison identité↔clé, code 61 bits sans biais, PBKDF2 600 k |
| `sidepanel/js/core/bounded-cache.js` | **Nouveau** — `BoundedSet`/`TTLMap` (anti-rejeu, anti-fuite) |
| `sidepanel/js/core/config.js` | `LIMITS`, `VIDEO_BITRATE`, quotas Drive, `OFFER_TTL` |
| `sidepanel/js/core/p2p-mesh.js` | Fragments bornés, seuil 15 Ko, `peerId` dynamique, Nostr durci, caches bornés, `applyVideoBitrate` |
| `sidepanel/js/core/crdt-engine.js` | Vérification de signature partout, fusion non destructive, forum réparé, commits/dossiers signés |
| `sidepanel/js/core/local-storage.js` | Persistance + quotas OPFS (`estimateStorage`, `ensureSpaceFor`) |
| `sidepanel/js/modules/drive/drive-transfer.js` | **Réécrit** — swarm rarest-first, bornage binaire, ré-affectation |
| `sidepanel/js/modules/drive/file-chunker.js` | `assembleFileStreaming` (OPFS, > 1 Go) |
| `sidepanel/js/modules/drive/drive-controller.js` | Contrôle de quota pré-vol, nettoyage OPFS |
| `sidepanel/js/modules/media/call-controller.js` | Boucle d'adaptation de bitrate |

**Bugs fonctionnels restants documentés (non bloquants) :** F7 (index IndexedDB `lamportTime` mort —
sans impact car non requêté) ; A1/A2 (recommandations d'architecture).

---

---

## 8. Vérification

Les correctifs ont été validés par :
- **Contrôle syntaxique** (`node --check`) sur l'intégralité des fichiers JS.
- **Tests automatisés ciblés** : aller-retour signature/vérification (message valide accepté ;
  texte falsifié, `authorId` usurpé et message non signé rejetés) ; ordre de planification
  **rarest-first** (h3→h2→h1 selon la rareté) ; bornage `TTLMap` (capacité + expiration TTL).
- **Revue de régression indépendante** par un second relecteur, qui a détecté **une régression**
  (la signature du thread de forum couvrait le champ mutable `replies`, ce qui aurait fait rejeter
  tout thread ayant reçu une réponse lors de la synchro CRDT). **Corrigée** : `replies` est désormais
  exclu de la signature du thread (les réponses restent signées individuellement), avec test
  automatisé confirmant qu'un thread reste valide après ajout d'une réponse. Deux défauts mineurs de
  robustesse du swarm (perte de l'historique des pairs essayés au timeout ; assemblage en mémoire sur
  le chemin « tout en cache ») ont également été corrigés.

*Fin du rapport. Le code corrigé est livré dans l'archive `p2p-mesh-corrige.zip`. Chaque correctif est
annoté dans le code par un commentaire `CORRECTIF (audit §…)` pour faciliter la relecture.*
