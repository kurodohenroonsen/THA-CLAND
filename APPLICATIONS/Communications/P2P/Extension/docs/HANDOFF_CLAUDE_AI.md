# 🛸 DOSSIER DE TRANSMISSION (HANDOFF) — EXTENSION CHROME P2P MESH
**Destination :** Claude AI (Subagents, DeepSearch & Audit de Code)  
**Projet :** Extension Chrome Manifest V3 — Espace Collaboratif 100% Peer-to-Peer & Décentralisé  
**Date :** 20 Août 2026  
**Auteur initial :** Antigravity AI (Google DeepMind)  
**Emplacement Workspace :** `/Users/kurodohenroonsen/Documents/ExtensionP2P`

---

## 1. 🎯 OBJECTIFS DU PROJET & PHILOSOPHIE ARCHITECTURALE

L'extension **P2P Mesh** est une application collaborative décentralisée s'exécutant directement dans le **Side Panel** de Google Chrome (Manifest V3).

### 🌟 Principes Fondamentaux :
1. **0% Serveur Applicatif, 100% P2P** : Aucun backend centralisé, aucune base de données centrale, aucun compte email/mot de passe.
2. **Onboarding Zero-Knowledge par Code Papier** : Une simple phrase mnémonique maître (ex: `ECHO-6848-PULSAR-9835`) dérive cryptographiquement l'ensemble des clés du groupe.
3. **Chiffrement de Bout en Bout Authentifié (E2EE)** : Toutes les données transitant sur le maillage WebRTC et les relais de découverte sont chiffrées en AES-GCM 256 bits.
4. **Collaboration Multi-Modules** :
   - 💬 **Chat Temps Réel** : Salons thématiques, indicateurs de frappe (*"est en train d'écrire..."*), formatage Markdown.
   - 📑 **Forum Répliqué** : Fils de discussion persistants organisés par sujets avec tags et compteurs de réponses.
   - 📁 **Drive Partagé Décentralisé & Versioning DAG** : Explorateur arborescent (dossiers/sous-dossiers), fil d'Ariane, découpage en blocs Merkle SHA-256, historique de versions (type Git), téléchargement en essaim P2P et **auto-seeding en arrière-plan**.
   - 🎙️ **Salons Vocaux & Vidéo WebRTC Mesh** : Mosaïque vidéo dynamique, détection vocale VAD, visualiseur Canvas d'ondes spectrales, renégociation in-band ultra-rapide et page dédiée d'autorisation des périphériques.

---

## 2. 🗺️ CARTOGRAPHIE COMPLÈTE DES FICHIERS DU WORKSPACE

```
ExtensionP2P/
├── manifest.json                                # Configuration Chrome Extension Manifest V3
├── permissions.html                             # Page dédiée d'autorisation Micro/Caméra avec VU-mètre
├── permissions.js                               # Logique interactive de test et d'autorisation WebRTC
├── verify_extension.py                          # Script de validation d'intégrité (imports JS, icônes, CSS)
├── test_trackers.py                             # Script de test des trackers WebSocket WebTorrent
├── test_relays.py                               # Script de test des relais Nostr WSS
├── generate_icons.py                            # Générateur d'icônes PNG de l'extension
├── background/
│   └── service-worker.js                        # Background Service Worker MV3 (Gestion SidePanel & Offscreen)
├── offscreen/
│   ├── offscreen.html                           # Document Offscreen pour survie de connexion & audio
│   └── offscreen.js                             # Maintien du heartbeat audio et persistance tâche de fond
├── icons/                                       # Icônes PNG (16x16, 32x32, 48x48, 128x128)
├── docs/
│   ├── DOSSIER_ANALYSE_ET_FONCTIONNALITES.md    # Cahier des charges et spécifications fonctionnelles
│   ├── SPECIFICATIONS_TECHNIQUES_P2P.md         # Spécifications cryptographiques et protocolaires P2P
│   └── HANDOFF_CLAUDE_AI.md                     # Ce présent dossier de transmission
└── sidepanel/
    ├── index.html                               # Interface principale du Side Panel
    ├── css/
    │   ├── variables.css                        # Design System (Tokens HSL, Dark Mode, Thèmes, Glassmorphism)
    │   ├── base.css                             # Reset CSS, typographie Inter et structure globale
    │   ├── layout.css                           # Grille, barre latérale d'onglets, en-tête et Roster
    │   ├── components.css                       # Boutons, badges, modales, toasts, alertes, formulaires
    │   ├── chat.css                             # Bulles de chat, animations de frappe à 3 points
    │   ├── drive.css                            # Arborescence dossiers, fil d'Ariane, timeline versioning
    │   └── media.css                            # Mosaïque vidéo, visualiseur Canvas, barre de contrôles d'appel
    └── js/
        ├── app.js                               # Point d'entrée principal & coordinateur d'initialisation
        ├── core/
        │   ├── config.js                        # Configuration (Trackers WSS, Relais Nostr, STUN ICE)
        │   ├── crypto-vault.js                  # Dérivation cryptographique (PBKDF2, HKDF, AES-GCM, ECDSA)
        │   ├── local-storage.js                 # Stockage local hybride IndexedDB v2 + OPFS
        │   ├── p2p-mesh.js                      # Maillage P2P WebRTC, fragmentation DataChannel, renégociation in-band
        │   ├── crdt-engine.js                   # Moteur de synchronisation CRDT (LWW-Element-Set, Sync Vectors)
        │   └── presence.js                      # Heartbeat, calcul de latence RTT, détection orateurs actifs
        ├── modules/
        │   ├── auth/
        │   │   └── auth-controller.js           # Générateur de code papier & persistance de session
        │   ├── chat/
        │   │   └── chat-controller.js           # Contrôleur de messagerie, frappe temps réel, Markdown
        │   ├── forum/
        │   │   └── forum-controller.js          # Contrôleur des fils de discussion et réponses
        │   ├── drive/
        │   │   ├── drive-controller.js          # Explorateur de dossiers/sous-dossiers, commits, navigation
        │   │   ├── drive-transfer.js            # Téléchargement multi-sources en tranches 16 Ko, auto-seeding
        │   │   ├── file-chunker.js              # Découpage binaire, Merkle Root SHA-256, réassemblage Blob
        │   └── versioning-dag.js                # Structure arborescente et graphe orienté acyclique de commits
        │   └── media/
        │       ├── call-controller.js           # Contrôleur d'appels, grille dynamique, toggle caméra
        │       ├── media-stream.js              # Capture audio Opus HD, vidéo 720p, partage d'écran
        │       ├── audio-processor.js           # Analyse spectrale Web Audio API & VAD (Voice Activity Detection)
        │       └── audio-visualizer.js          # Rendu Canvas de l'onde sonore temps réel
        └── ui/
            ├── modal.js                         # Gestionnaire d'ouverture/fermeture des modales
            └── toast.js                         # Notifications Toasts animées (succès, info, warning, erreur)
```

---

## 3. 🔐 PROTOCOLE CRYPTOGRAPHIQUE & SÉCURITÉ ZERO-KNOWLEDGE

### Pipeline de Dérivation (`crypto-vault.js`) :
```
[Code Papier Maître: ECHO-6848-PULSAR-9835]
      │
      ▼
[PBKDF2-SHA512] (100 000 itérations + Sel fixe normalisé)
      │
      ▼
[Clé Maîtresse HKDF-SHA256 (32 octets)]
      ├──▶ info="p2p-mesh-topic-v1"     ──▶ SHA-256 ──▶ [Topic ID / InfoHash (20 octets / 40 hex chars)]
      ├──▶ info="p2p-signal-key-v1"     ──▶ [Clé AES-GCM 256 (Chiffrement Offres/Réponses SDP)]
      ├──▶ info="p2p-content-key-v1"    ──▶ [Clé AES-GCM 256 (Chiffrement Payloads Données)]
      └──▶ info="p2p-peer-identity-v1"  ──▶ [Paire de clés ECDSA P-256 & Peer ID]
```

### Règles de Tunneling SDP & Signalement WebTorrent :
* Les trackers BitTorrent publics (ex: `bittorrent-tracker`) sanitizent les paquets et n'acceptent que `offer.type` et `offer.sdp`.
* **Solution robuste implémentée** : L'objet chiffré `{ iv, ciphertext, salt }` est sérialisé en JSON string et encapsulé directement dans le champ standard `offer.sdp` (`{ type: 'offer', sdp: JSON.stringify(encryptedOffer) }`). Le tracker transmet le paquet intact sans déchiffrer.

---

## 4. 🌐 COUCHE RÉSEAU WEBRTC & FLUX DE DONNÉES

### Résolution des Limites RTCDataChannel :
1. **Canal de Contrôle (`p2p-control`)** :
   * Découpage automatique de tout message JSON supérieur à **28 Ko** en paquets numérotés (`_isFrag: true, _fragId, _part, _total, _data`).
   * Réassemblage transparent à la réception avant déchiffrement.
2. **Canal de Données Binaires (`p2p-data`)** :
   * Découpage des blocs de 512 Ko en **tranches séquencées de 16 Ko** (Safe MTU UDP).
   * En-tête de trame compact de 73 octets : `[0xFD (Magic Byte)][64 octets Hash SHA-256][2 octets Index Tranche][2 octets Total Tranches][4 octets Taille Totale][Tranche Binaire]`.
   * Contrôle de contre-pression (*Backpressure*) surveillant `bufferedAmount` (< 512 Ko).

### Renégociation Média In-Band :
* Transceivers `audio` et `video` initialisés en `{ direction: 'sendrecv' }`.
* Injection dynamique de caméra ou partage d'écran via `sender.replaceTrack()` et renégociation SDP instantanée en direct sur le canal `p2p-control` (`MEDIA_RENEGOTIATE_OFFER` / `MEDIA_RENEGOTIATE_ANSWER`), sans repasser par les trackers externes.

---

## 5. 📦 CRDT, VERSIONING DAG & AUTO-SEEDING DU DRIVE

1. **Synchronisation CRDT** :
   * Vecteur d'horloge incrémental (`msgsSince`, `threadsSince`, `commitsSince`, `foldersSince`).
   * Algorithme LWW (*Last-Write-Wins*) sans conflit pour messages, réactions, votes et arborescence.
2. **Organisation en Dossiers & Sous-Dossiers** :
   * Normalisation des chemins absolus (ex: `/Projets/Mobile/Assets/`).
   * Magasin IndexedDB dédié `drive_folders` synchronisé en temps réel via `DRIVE_FOLDER_CREATE` et `DRIVE_FOLDER_DELETE`.
3. **Auto-Réplication Décentralisée (*Swarm Auto-Seeding*)** :
   * Dès qu'un nouveau commit est annoncé par un pair, tous les nœuds en ligne déclenchent le téléchargement silencieux des blocs manquants en arrière-plan.
   * Chaque pair devient instantanément miroir/co-seeder du fichier. Même si l'uploader initial se déconnecte, les fichiers restent 100% disponibles.

---

## 6. 🛠️ DIRECTIVES & PISTES D'AUDIT POUR CLAUDE AI

Voici les axes recommandés pour que Claude AI approfondisse l'audit, les optimisations de performance et les fonctionnalités avancées :

### Pistes d'Amélioration & Audit Suggérées :
1. **Sécurité Cryptographique & Zero-Knowledge** :
   * Auditer la résistance contre les attaques de rejeu sur le canal Nostr et WebTorrent.
   * Vérifier l'implémentation de la rotation de clés et de la révocation de membres.
2. **Performances WebRTC & Bande Passante** :
   * Analyser l'algorithme de téléchargement Swarm multi-pairs (stratégie Rarest-First comme BitTorrent).
   * Optimiser le bitrate vidéo adaptatif (Simulcast WebRTC / VP9 / AV1) en fonction de la latence RTT mesurée par `PresenceManager`.
3. **Persistance & Scalabilité Stockage** :
   * Auditer les quotas OPFS (Origin Private File System) pour le stockage de fichiers de plusieurs gigaoctets.
   * Implémenter un garbage collector de blocs orphelins dans IndexedDB.
4. **Fonctionnalités Collaboratives Avancées** :
   * Ajout d'un éditeur de texte collaboratif Markdown en temps réel (CRDT Yjs / Automerge intégré en P2P).
   * Ajout d'un tableau blanc interactif P2P (Canvas vectoriel partagé).
5. **Résilience Réseau & NAT Traversal** :
   * Intégration de serveurs TURN publics / WebTorrent DHT signalers supplémentaires.

---

## 7. 🧪 COMMANDES DE VALIDATION DU CODEBASE

```bash
# Vérification d'intégrité de l'extension (manifest, imports JS, icônes, CSS)
python3 verify_extension.py

# Test de connectivité des trackers WebTorrent WSS
python3 test_trackers.py

# Test de connectivité des relais Nostr WSS
python3 test_relays.py
```
