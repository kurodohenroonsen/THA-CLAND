# P2P Mesh - Espace Collaboratif Décentralisé (Extension Chrome MV3)

Plateforme collaborative 100% **Peer-to-Peer (P2P)** sans aucun serveur applicatif centralisé, opérant directement dans le **Side Panel de Google Chrome (Manifest V3)**.

---

## ✨ Fonctionnalités Incluses

1. **Onboarding Hors-Réseau (Zero-Knowledge)** :
   - Rejoignez un groupe avec un simple **Code Papier** (ex: `ALPHA-8842-OMEGA-9912`) ou générez un nouveau groupe en 1 clic.
   - Dérivation locale déterministe (`PBKDF2-HMAC-SHA512` avec 100 000 itérations + `HKDF`) pour créer le Topic de rendez-vous et les clés de chiffrement de bout en bout (**AES-256-GCM**).
2. **Signalement & Découverte Décentralisés (Zéro Serveur Propriétaire)** :
   - Utilisation conjointe de trackers publics WebTorrent WebSockets (`wss://tracker.openwebtorrent.com`, etc.) et de relais Nostr publics.
   - Poignée de main WebRTC (SDP / ICE) chiffrée E2EE : les relais ne voient que du bruit et ignorent qui communique.
3. **Messagerie Instantanée & Salons P2P** :
   - Canaux thématiques (`#général`, `#projets`, `#annonces`).
   - Synchronisation sans conflit par **CRDT** (horloges de Lamport et vecteurs d'état).
   - Historique persistant dans `IndexedDB` pour un fonctionnement 100% hors-ligne.
4. **Forums & Discussions Arborescentes** :
   - Création de sujets avec catégories, tags et statut épinglé.
   - Réponses en cascade répliquées en temps réel.
5. **Drive Partagé P2P & Versioning Git-like** :
   - Découpage des fichiers en blocs réguliers de **512 Ko** avec empreintes **SHA-256** (Content-Addressing).
   - Arborescence de commits immuables (**Merkle DAG**) : historique complet des versions, métadonnées, messages de commit et auteur.
   - Dédoublonnage automatique des données inchangées.
   - Téléchargement en essaim (**Swarm Downloader**) multi-pairs avec contrôle de flux (backpressure).
   - Restauration immédiate vers n'importe quelle version passée.
6. **Salons Vocaux & Vidéo (WebRTC Mesh)** :
   - Appels vocaux légers avec codec Opus haute fidélité (jusqu'à 10-15 participants sans serveur).
   - Mosaïque vidéo dynamique pour 2 à 6 participants.
   - Détection d'activité vocale (**VAD**) et visualiseur de spectre audio Canvas HTML5.
   - Partage d'écran natif (`getDisplayMedia`).
   - Document **Offscreen** (`chrome.offscreen`) pour le maintien des flux et des connexions en tâche de fond.

---

## 🚀 Installation & Test dans Google Chrome

1. Ouvrez Google Chrome et rendez-vous sur la page : `chrome://extensions/`
2. Activez le **Mode développeur** (en haut à droite).
3. Cliquez sur le bouton **"Charger l'extension non empaquetée"** (Load unpacked).
4. Sélectionnez le dossier du projet :
   ```
   /Users/kurodohenroonsen/Documents/ExtensionP2P
   ```
5. Cliquez sur l'icône de l'extension dans la barre d'outils Chrome : le **Side Panel P2P Mesh** s'ouvre instantanément !

---

## 👥 Comment Tester l'Échange P2P entre 2 Utilisateurs

1. **Sur l'Instance A (ex: fenêtre Chrome normale)** :
   - Cliquez sur *"✨ Générer un Nouveau Groupe & Code Papier"*.
   - Cliquez sur *"Rejoindre le Groupe"*.
2. **Sur l'Instance B (ex: Profil Invité Chrome ou 2ème navigateur)** :
   - Copiez le code papier généré sur l'instance A (ex: `ALPHA-8842-OMEGA-9912`).
   - Renseignez un pseudonyme (ex: *Bob*) et collez le code papier.
   - Cliquez sur *"Rejoindre le Groupe"*.
3. **Résultat** :
   - Les deux instances se découvrent automatiquement sur le maillage P2P.
   - Le compteur de pairs passe à `👥 1`.
   - Les messages de chat, sujets de forum, fichiers partagés du drive et appels vocaux/vidéo s'échangent en direct de machine à machine !

---

## 📁 Structure du Projet

```
ExtensionP2P/
├── manifest.json                  # Déclaration Manifest V3
├── icons/                         # Icônes PNG réelles (16, 32, 48, 128px)
├── background/
│   └── service-worker.js         # Service Worker MV3 (SidePanel, Offscreen, Badges)
├── offscreen/
│   ├── offscreen.html            # Document Offscreen headless
│   └── offscreen.js
├── sidepanel/
│   ├── index.html                # UI Principale Glassmorphism
│   ├── css/                      # Styles modulaires (variables, chat, drive, media, layout)
│   └── js/
│       ├── app.js                # Contrôleur d'application
│       ├── core/                 # Moteurs (crypto-vault, p2p-mesh, crdt-engine, local-storage, presence)
│       ├── modules/              # Modules métiers (auth, chat, forum, drive, media)
│       └── ui/                   # Helpers UI (toast, modal, visualizer)
└── docs/
    ├── DOSSIER_ANALYSE_ET_FONCTIONNALITES.md
    └── SPECIFICATIONS_TECHNIQUES_P2P.md
```
