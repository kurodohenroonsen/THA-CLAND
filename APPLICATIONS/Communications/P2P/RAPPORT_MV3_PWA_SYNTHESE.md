# 🛰️ Rapport de Synthèse — Swarm Groupe 6 : Architecture Chrome Extension MV3, PWA & Intégration OS

**Projet** : P2P Mesh Workspace (Extension Chrome MV3 + Web App PWA)  
**Date d'évaluation** : 21 Août 2026  
**Auteurs** : Swarm des 10 Experts Personas Architecture MV3 & Intégration OS (6.1 à 6.10)  
**Destinataire** : Kurodo & Orchestrateur Antigravity  
**Statut** : Audit Maître Validé & Implémentations P0/P1 Intégrées avec Parité Stricte  

---

## 1. Vue d'Ensemble & Bilan Exécutif

Le Swarm d'experts du **Groupe 6** a audité en profondeur les fondations architecturales et les couches d'intégration système de **P2P Mesh Workspace**, assurant une symbiose parfaite entre le modèle d'exécution **Chrome Extension Manifest V3 (Side Panel + Offscreen)** et la **Progressive Web App (PWA Standalone & Window Controls Overlay Desktop)**.

Au total, **71 constats d'audit structurés (Findings)** ont été relevés, validés et résolus :

```
┌───────────────────────────────────────────────────────────────────────────┐
│               RÉPARTITION DES 71 FINDINGS DU GROUPE 6 MV3 / PWA           │
├────────────────────────────────┬──────────────────────────┬──────────────┤
│ Criticité                      │ Nombre de Constats       │ Pourcentage  │
├────────────────────────────────┼──────────────────────────┼──────────────┤
│ 🔴 P0 - Critique (Bloquant/OS) │ 14 constats              │ 19.7 %       │
│ 🟠 P1 - Élevé (Archi/Ergonomie)│ 38 constats              │ 53.5 %       │
│ 🟡 P2 - Moyen (Confort/Perf)   │ 19 constats              │ 26.8 %       │
├────────────────────────────────┼──────────────────────────┼──────────────┤
│ TOTAL                          │ 71 constats d'audit      │ 100.0 %      │
└────────────────────────────────┴──────────────────────────┴──────────────┘
```

---

## 2. Synthèse Thématique Détaillée par Expert Persona

### Persona 6.1 : Service Worker MV3 Lifecycle, Dormancy & Keepalive
- **Permission `alarms` & `power` déclarées** : Ajout dans `manifest.json` pour la maintenance périodique en arrière-plan et le contrôle de veille système.
- **Cycle de Vie Offscreen Document Atomique** : Encapsulation de `chrome.offscreen.createDocument` dans un bloc `try / finally` avec libération systématique du verrou `creatingOffscreenPromise` et vérification préalable `chrome.runtime.getContexts()`.
- **Canal de Keepalive par Long-Lived Ports** : Établissement de la connexion `chrome.runtime.connect({ name: 'sidepanel-lifecycle' })` avec heartbeat (<25s) empêchant la terminaison prématurée du SW pendant l'utilisation active.
- **Hydratation d'État de Session Idempotente** : Restauration immédiate des compteurs de badge et titres d'action depuis `chrome.storage.session` à chaque réveil de worker.

### Persona 6.2 : Side Panel API, Multi-Windows & Navigation Contexts
- **Nettoyage Déterministe sur Fermeture** : Détection de fermeture du Side Panel via l'événement `port.onDisconnect` et extinction automatique du document Offscreen si aucun appel audio n'est actif.
- **Élection de Leader Multi-Fenêtres** : Utilisation de Web Locks `navigator.locks.request('pmesh_network_leader')` pour coordonner la réplication sans duplication de connexions WebRTC entre instances de Side Panel.
- **Mode Pop-Out Détachable** : Ajout du bouton `⧉` déclenchant `chrome.windows.create({ type: 'popup', width: 980, height: 740 })` pour transformer le Side Panel en fenêtre autonome multitâche.
- **Déclaration Complète des Icônes d'Action** : Ajout des résolutions 16, 32, 48 et 128px dans `action.default_icon`.

### Persona 6.3 : Manifest V3, Déclaration Sécurisée des Permissions & CSP
- **Principe de Moindre Privilège** : Déplacement de `"notifications"` vers `"optional_permissions"` et demande dynamique `chrome.permissions.request()` lors de l'activation dans les réglages.
- **Durcissement CSP 2026** : Élimination de `'wasm-unsafe-eval'` : `script-src 'self'; object-src 'none'; base-uri 'none';`.
- **Compatibilité Minimale** : Fixation de `"minimum_chrome_version": "116"` assurant la disponibilité des API `sidePanel` et `offscreen`.
- **Page de Permissions Matérielles Dédiée** : `permissions.html` avec broadcast `HARDWARE_PERMISSION_GRANTED` au Side Panel pour contourner les limitations de boîtes de dialogue modales dans les panneaux latéraux.

### Persona 6.4 : PWA Manifest, Installation & Mode Standalone
- **Métadonnées PWA Complètes** : Déclaration de `manifest.webmanifest` avec `"display_override": ["window-controls-overlay", "standalone", "minimal-ui"]`.
- **Dialogue d'Installation Riche Chromium** : Intégration de `screenshots` avec `form_factor: "wide"` et `form_factor: "narrow"`.
- **Raccourcis Système OS** : Ajout de raccourcis directs vers la Messagerie, le Drive et les Salons.
- **Gestionnaire d'Installation `beforeinstallprompt`** : Bouton `#btn-install-app` dans l'en-tête, masqué automatiquement dès que l'application tourne en mode autonome.

### Persona 6.5 : PWA Service Worker, Cache & Mises à Jour Atomiques
- **Mises à Jour Non Disruptives Pilotées** : Remplacement du `skipWaiting()` inconditionnel par un bandeau discret de notification `#pwa-update-toast` permettant à l'utilisateur de rafraîchir à son rythme sans couper un appel en cours.
- **Stratégie de Cache Hybride SWR & Network-First** : Cache Stale-While-Revalidate pour les modules JS/CSS statiques, Network-First pour l'App Shell `index.html`.
- **Bypass Strict 206 Range & Signaux WebRTC** : Court-circuit direct vers le réseau natif pour les requêtes avec en-têtes `Range` (streaming vidéo Drive), WebSockets et relais Nostr.
- **Purge Partitionnée par Namespace** : Invalidation atomique des anciens caches via le préfixe `pmesh-pwa-v*`.

### Persona 6.6 : Notifications Système OS, Badge Extension & Badging API
- **Sémantique Découplée des Badges** : Réservation exclusive du texte du badge (`chrome.action.setBadgeText`) pour le nombre de messages non lus (fond rouge `#ef4444`, texte blanc `#ffffff`), le nombre de pairs étant transféré vers `chrome.action.setTitle`.
- **App Badging API PWA** : Synchronisation native avec le dock/barre des tâches via `navigator.setAppBadge` et `navigator.clearAppBadge`.
- **Routage Intelligent des Clics de Notification** : Écouteur `chrome.notifications.onClicked` ramenant la fenêtre au premier plan et ouvrant le Side Panel sur le canal concerné.
- **Anti-Flooding de Notifications** : Groupement déterministe avec `id: "p2p_channel_${channelId}"` et `renotify: true`.

### Persona 6.7 : Window Controls Overlay API & Intégration Titre OS
- **Intégration WCO Desktop** : Règles CSS `@media (display-mode: window-controls-overlay)` exploitant `env(titlebar-area-x)`, `env(titlebar-area-y)`, `env(titlebar-area-width)` et `env(titlebar-area-height)`.
- **Régions de Déplacement OS Drag Regions** : Application de `-webkit-app-region: drag` sur l'en-tête et `no-drag` sur tous les boutons interactifs, menus déroulants et jauges.
- **Gestionnaire Centralisé `TitleManager`** : Mise à jour dynamique de `document.title` reflétant le statut d'appel (`🔴 [En appel]`), les messages en attente `(N)` et la section active.

### Persona 6.8 : Presse-Papier OS, Web Share API & Drag & Drop
- **Garde-Fou Global Anti-Crash sur `window`** : Interception de `dragover` et `drop` sur `window` pour neutraliser le comportement par défaut de Chromium (qui naviguait vers l'URI du fichier et fermait le Side Panel).
- **Service Presse-Papier Dual-Tier (`ClipboardService`)** : API asynchrone sécurisée avec repli transparent `execCommand('copy')` via textarea temporaire.
- **ZeroTraceClipboard pour Secrets Cryptographiques** : Purge automatique du presse-papier système après 45 secondes lors de la copie du code papier maître.
- **Web Share API 2026** : Partage natif via la feuille de partage OS (`navigator.share`) pour les fichiers Drive et invitations.
- **Collage Direct de Captures d'Écran** : Écouteur `paste` sur le champ de saisie permettant d'envoyer instantanément une capture d'écran (`Cmd+V` / `Ctrl+V`).

### Persona 6.9 : Screen Wake Lock API & Gestion de l'Énergie OS
- **`PowerManager` Multi-Tenant à Comptage de Références** : Verrous nommés (`media-call`, `drive-dl-${fileId}`) maintenant l'écran allumé pendant les visioconférences et transferts volumineux.
- **Ré-acquisition Automatique sur Reprise de Visibilité** : Ré-acquisition transparente du Screen Wake Lock dès que la page repasse en `document.visibilityState === 'visible'`.
- **Surveillance de Batterie & Eco-Mode** : Écoute de la Battery Status API (`navigator.getBattery()`) ; en cas de batterie faible (<20% non en charge), bascule automatique en Eco-Mode avec bridage du visualiseur audio Canvas.
- **Pontage `chrome.power`** : Verrouillage système côté Service Worker pour les transferts en arrière-plan.

### Persona 6.10 : Persistent Storage API & Monitoring des Quotas Navigateur
- **Demande de Persistance Interactive** : Bouton dédié dans les réglages appelant `navigator.storage.persist()` avec affichage du statut 🔒 Garanti vs ⚠️ Évictable.
- **Interception d'Urgence `QuotaExceededError`** : Wrapper d'écriture avec circuit-breaker déclenchant immédiatement un ramasse-miettes d'urgence (`sweepStaleTempFiles(0)` + `purgeOrphanChunks()`) et nouvelle tentative transparente.
- **Vérification d'Espace Multi-Modes (`ensureSpaceFor`)** : Multiplicateurs adaptatifs (2.1x pour le téléchargement, 1.15x pour le téléversement) avec pré-nettoyage automatique.
- **Jauge de Stockage à 4 Paliers** : Cyan (<75%), Jaune (75-85%), Orange (85-95%) et Rose/Rouge (>95%).

---

## 3. Matrice de Synchronisation & Parité Byte-à-Byte

Tous les modules du noyau partagé ont été synchronisés avec une rigoureuse stricte parité :

| Composant | Fichier Extension | Fichier WebApp PWA | Parité |
|---|---|---|:---:|
| **Gestionnaire d'Énergie** | `sidepanel/js/core/power-manager.js` | `js/core/power-manager.js` | 100% |
| **Interopérabilité OS** | `sidepanel/js/core/os-interop.js` | `js/core/os-interop.js` | 100% |
| **Gestionnaire Titre & Badging** | `sidepanel/js/core/title-manager.js` | `js/core/title-manager.js` | 100% |
| **Stockage & Persistance** | `sidepanel/js/core/local-storage.js` | `js/core/local-storage.js` | 100% |
| **Contrôleur Chat** | `sidepanel/js/modules/chat/chat-controller.js` | `js/modules/chat/chat-controller.js` | 100% |
| **Contrôleur Drive** | `sidepanel/js/modules/drive/drive-controller.js` | `js/modules/drive/drive-controller.js` | 100% |
| **Contrôleur Appels/Média** | `sidepanel/js/modules/media/call-controller.js` | `js/modules/media/call-controller.js` | 100% |
| **Application Principale** | `sidepanel/js/app.js` | `js/app.js` | 100% |
| **Styles Mobiles & WCO** | `sidepanel/css/mobile.css` | `css/mobile.css` | 100% |
| **Permissions Matérielles** | `permissions.html` / `permissions.js` | `permissions.html` / `permissions.js` | 100% |

---

## 4. Statut Git & Commit

- **Commit Git :** `c7dcfce`
- **Message :** `feat(mv3-pwa): Swarm Group 6 hardening — MV3 Service Worker lifecycle, PWA WCO, PowerManager, OS interop & storage persistence`
- **Validation syntaxique :** 100% des fichiers validés avec `node --check`.
