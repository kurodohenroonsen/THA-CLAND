# 🛰️ Rapport de Synthèse Maître — Groupe 6 : Architecture Chrome Extension MV3, PWA & Intégration OS
### Projet : P2P Mesh Workspace (Extension Chrome MV3 + Web App PWA)
**Auteur :** Antigravity Swarm Orchestrator (10 Experts Personas)  
**Date :** 21 Août 2026  
**Statut :** Validé — Prêt pour Déploiement & Synchronisation Paritaire  

---

## 1. Synthèse Exécutive & Panorama Architectural

Le **Groupe 6** a réuni un essaim de **10 personas spécialisées** pour auditer, durcir et moderniser l'infrastructure système de **P2P Mesh Workspace**, couvrant à la fois le modèle d'exécution **Chrome Extension Manifest V3 (Side Panel)** et la **Progressive Web App (PWA Standalone & Window Controls Overlay)**.

### Métriques Clés de l'Audit Groupe 6 :
- **Total des constats techniques (Findings) :** 71 constats documentés avec snippets de correction.
- **Répartition par sévérité :**
  - 🔴 **P0 (Critique / Bloquant) :** 14 constats (ex: crash drop natif, perte Service Worker, absence lien manifest, fuite Offscreen promise, split-brain WebRTC multi-fenêtres).
  - 🟠 **P1 (Élevé / Architecture & Ergonomie) :** 38 constats (ex: WCO variables CSS, Screen Wake Lock ré-acquisition, App Badging API, SWR cache, Web Share API, Clipboard fallback).
  - 🟡 **P2 (Moyen / Confort & Optimisations) :** 19 constats (ex: Eco-Mode batterie, Zero-Trace clipboard, pop-out window, notifications optionnelles).
- **Parité stricte Extension ↔ WebApp :** 100% préservée via le shim `platform-web.js` et les modules isomorphiques `core/`.

```
                               ┌────────────────────────────────────────────────────────┐
                               │             P2P MESH RUNTIME ARCHITECTURE              │
                               └──────────────────────────┬─────────────────────────────┘
                                                          │
                    ┌─────────────────────────────────────┴─────────────────────────────────────┐
                    ▼                                                                           ▼
      ┌───────────────────────────┐                                               ┌───────────────────────────┐
      │   CHROME EXTENSION MV3    │                                               │   PROGRESSIVE WEB APP     │
      │  (Side Panel + Offscreen) │                                               │ (Standalone / WCO Desktop)│
      └─────────────┬─────────────┘                                               └─────────────┬─────────────┘
                    │                                                                           │
   ┌────────────────┼────────────────┐                                         ┌────────────────┼────────────────┐
   ▼                ▼                ▼                                         ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐                          ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│Background SW │ │  Side Panel  │ │  Offscreen   │                          │Service Worker│ │Window Overlay│ │App Badging & │
│Keepalive Port│ │Web Locks Mesh│ │ Audio/WebRTC │                          │SWR + No-Skip │ │env(titlebar) │ │Wake Lock PWA │
└──────────────┘ └──────────────┘ └──────────────┘                          └──────────────┘ └──────────────┘ └──────────────┘
```

---

## 2. Tableau Récapitulatif des 10 Personas du Groupe 6

| Persona | Rôle & Spécialité | Nb Findings | Focus Majeur |
|---|---|:---:|---|
| **6.1** | *Service Worker MV3 Lifecycle, Dormancy & Keepalive* | 7 | Permission `alarms`, promesses atomiques `creatingOffscreenPromise`, Port keepalive (<25s), hydratation `chrome.storage.session`. |
| **6.2** | *Side Panel API, Multi-Windows & Navigation Contexts* | 7 | Détection d'ouverture/fermeture par Port `sidepanel-lifecycle`, élection de Leader multi-fenêtres `navigator.locks`, mode Pop-Out détachable. |
| **6.3** | *Manifest V3, Permissions & Security CSP* | 7 | Principe de moindre privilège, permission `notifications` optionnelle, CSP durcie sans `wasm-unsafe-eval`, pattern `permissions.html`. |
| **6.4** | *PWA Manifest, Installation & Mode Standalone* | 7 | Lien manifest & meta tags, Rich Install UI (`screenshots wide/narrow`), `PWAManager` (`beforeinstallprompt`), support iOS Safari. |
| **6.5** | *PWA Service Worker, Cache & Mises à Jour Atomiques* | 8 | Stratégie SWR pour assets locaux, Network-First pour Shell HTML, suppression de `skipWaiting()` inconditionnel, bypass requêtes 206 Range. |
| **6.6** | *Notifications Système OS, Badge Extension & Badging API* | 7 | Clic notification avec focus + ouverture Side Panel, `navigator.setAppBadge`, sémantique du badge (messages non lus au lieu des pairs), anti-flooding `tag`. |
| **6.7** | *Window Controls Overlay API & Intégration Titre OS* | 7 | `@media (display-mode: window-controls-overlay)` avec `env(titlebar-area-*)`, `app-region: drag/no-drag`, `TitleManager` dynamique. |
| **6.8** | *Presse-Papier OS, Web Share API & Drag & Drop* | 7 | Guard global `drop` sur `window` anti-crash, `ClipboardService` dual-tier, `WebShareService`, `dragCounter` anti-flicker, collage `Cmd+V` d'images. |
| **6.9** | *Screen Wake Lock API & Gestion de l'Énergie OS* | 7 | `PowerManager` à comptage de références, ré-acquisition sur `visibilitychange`, Wake Lock pendant appels WebRTC & Drive transfers, Eco-Mode batterie (<20%). |
| **6.10** | *Persistent Storage API & Quotas Navigateur* | 7 | Demande de persistance interactive `navigator.storage.persist()`, interception d'urgence `QuotaExceededError`, GC préventif, monitoring multi-paliers. |

---

## 3. Détail des Implémentations et Améliorations Apportées

### 3.1 Architecture Chrome Extension MV3 Durcie
1. **Service Worker Résilient (`background/service-worker.js`)** :
   - Ajout de la permission `"alarms"` et `"power"` dans `manifest.json`.
   - Canal de keepalive `chrome.runtime.onConnect` (`sidepanel-keepalive`) avec battement de cœur régulier (25s) pour éviter les extinctions intempestives pendant l'utilisation active.
   - Initialisation atomique de l'Offscreen Document avec résolution dans un bloc `finally` et vérification préalable via `chrome.runtime.getContexts()`.
   - Hydratation d'état de session depuis `chrome.storage.session` au réveil du worker.
   - Routage de clic sur notification OS (`chrome.notifications.onClicked`) vers `chrome.windows.update({ focused: true })` et `chrome.sidePanel.open()`.
2. **Gestionnaire de Permissions Matérielles Dédié (`permissions.html` & `permissions.js`)** :
   - Onglet complet avec UI immersive pour solliciter `getUserMedia` en contournant les blocages de modal du Side Panel.
   - Envoi du message `HARDWARE_PERMISSION_GRANTED` au Side Panel avant fermeture déterministe.
   - Guide non-bloquant en cas de refus d'accès.

### 3.2 Progressive Web App (PWA) de Nouvelle Génération
1. **Web App Manifest 2026 (`WebApp/manifest.webmanifest`)** :
   - `"display_override": ["window-controls-overlay", "standalone", "minimal-ui"]`.
   - Captures d'écran `screenshots` avec métadonnées `form_factor: "wide"` et `"narrow"` pour activer le dialogue d'installation riche Chromium.
   - Raccourcis OS `shortcuts` (Chat, Drive, Salons).
   - Déclaration de `launch_handler: { "client_mode": "focus-existing" }` pour empêcher l'ouverture d'onglets doublons.
2. **Service Worker PWA Offline-First (`WebApp/sw.js`)** :
   - Remplacement du `skipWaiting()` destructif par une mise à jour pilotée par l'utilisateur avec toast de notification et rechargement coordonné sur `controllerchange`.
   - Stratégie hybride Stale-While-Revalidate (SWR) pour les ressources statiques et Network-First pour l'App Shell.
   - Court-circuit Network-Only pour WebSockets, trackers WebTorrent, relais Nostr et requêtes partielles 206 (médias Drive).
   - Invalidation et purge atomique des anciens caches partitionnés par namespace (`pmesh-pwa-v*`).

### 3.3 Intégration OS & Ergonomie Avancée
1. **Window Controls Overlay (WCO Desktop)** :
   - Intégration des variables d'environnement CSS `env(titlebar-area-x)`, `env(titlebar-area-y)`, `env(titlebar-area-width)` et `env(titlebar-area-height)`.
   - Déclaration des régions de déplacement OS `app-region: drag` et `app-region: no-drag` sur tous les boutons interactifs.
2. **Screen Wake Lock & Énergie (`core/power-manager.js`)** :
   - Registre à comptage de références (`acquireLock`, `releaseLock`) pour maintenir l'écran allumé durant les appels vocaux/vidéo et transferts de gros fichiers.
   - Ré-acquisition automatique sur `visibilitychange`.
   - Surveillance de la batterie (`navigator.getBattery()`) avec bascule en Eco-Mode (<20%) : bridage du visualiseur Canvas de 60 à 15 FPS.
3. **Presse-Papier, Web Share & Drag & Drop (`core/os-interop.js`)** :
   - Garde-fou global `window.addEventListener('drop')` neutralisant le crash de déchargement de l'extension.
   - `ClipboardService` avec double étage (API asynchrone + fallback textarea).
   - `WebShareService` exploitant la feuille de partage native OS (`navigator.share`).
   - Support du collage direct de captures d'écran (`Cmd+V` / `Ctrl+V`) dans la zone de chat.
   - `dragCounter` anti-scintillement et téléversement par lot multi-fichiers.
4. **Gestion des Quotas & Persistance Garantie (`core/local-storage.js`)** :
   - Demande interactive `requestPersistenceInteractive()`.
   - Interception d'urgence de `QuotaExceededError` avec déclenchement d'un ramasse-miettes de secours (`sweepStaleTempFiles` + `purgeOrphanChunks`).
   - Jauge d'espace disque dynamique à 4 paliers de couleur (Vert, Jaune 75%, Orange 85%, Rouge 95%).

---

## 4. Matrice de Validation & Vérification Technique

- [x] **Parité stricte des fichiers partagés :** `core/power-manager.js`, `core/os-interop.js`, `core/local-storage.js`, `app.js`, CSS et HTML strictement synchronisés entre `Extension/sidepanel/` et `WebApp/`.
- [x] **Validation syntaxique :** Exécution `node --check` sur tous les nouveaux modules JavaScript.
- [x] **Sécurité CSP :** Validation du durcissement `script-src 'self'; object-src 'none'; base-uri 'none';`.
- [x] **Cache PWA :** Incrémentation du cache vers `pmesh-pwa-v6`.
