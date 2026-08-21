# Chrome Web Store Listing: P2P Mesh Workspace

## Store Listing Metadata

- **Name**: P2P Mesh - Espace Collaboratif Décentralisé
- **Summary**: Espace de travail collaboratif 100% Peer-to-Peer : Chat, Forums, Drive partagé avec versioning et Appels Audio/Vidéo sans serveur.
- **Category**: Productivité / Communication
- **Version**: 1.0.0

## Description

P2P Mesh Workspace transforme votre navigateur Chrome en un nœud de collaboration décentralisé sécurisé et autonome.

### Fonctionnalités Clés :
- 🔐 **Onboarding Zero-Knowledge** : Rejoignez n'importe quel espace avec un code papier hors réseau.
- 💬 **Messagerie & Forums P2P** : Échanges instantanés répliqués par CRDT avec persistance hors-ligne.
- 📁 **Drive Partagé & Versioning Git-like** : Découpage en blocs SHA-256 de 512 Ko, historique complet des versions, dédoublonnage et téléchargement en essaim multi-pairs.
- 🎙️ **Salons Vocaux & Vidéo Mesh** : Appels directs WebRTC avec détection d'activité vocale (VAD), visualiseur de fréquences et partage d'écran.
- 🔒 **Chiffrement de Bout en Bout** : Clés dérivées localement via Web Crypto API (AES-256-GCM).

## Justification des Permissions

- `sidePanel`: Requis pour afficher l'interface de travail collaborative intégrée au volet latéral de Chrome.
- `offscreen`: Requis pour maintenir la connexion WebRTC de données et les flux audio d'arrière-plan sans interruption.
- `storage` / `unlimitedStorage`: Requis pour stocker localement les messages de chat, les sujets de forum et les blocs de fichiers du drive dans IndexedDB.
- `notifications`: Requis pour avertir l'utilisateur lors de la réception de messages importants d'autres pairs.

## Confidentialité & Données

Cette extension ne collecte, ne transmet et ne stocke aucune donnée sur un serveur centralisé propriétaire. Toutes les données sont chiffrées localement et transmises exclusivement de pair à pair.
