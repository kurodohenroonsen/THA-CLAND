# 🎙️🎥 Rapport de Synthèse — Swarm Groupe 5 : Média, Streaming Audio/Vidéo & Traitement du Signal

**Projet** : P2P Mesh Workspace (Extension Chrome MV3 + Web App PWA)  
**Date d'évaluation** : 21 Août 2026  
**Auteurs** : Swarm des 10 Experts Personas Média & Traitement du Signal (5.1 à 5.10)  
**Destinataire** : Kurodo & Orchestrateur Antigravity  
**Statut** : Audit Maître Validé & Spécifications P0/P1 Prêtes au Déploiement

---

## 1. Vue d'Ensemble & Bilan Exécutif

Le Swarm d'experts Groupe 5 a audité en profondeur l'ensemble de la chaîne de capture, traitement DSP, encodage de codecs, spatialisation 3D, gestion des périphériques et rendu visuel WebRTC dans l'Extension Side Panel et la WebApp PWA. Au total, **73 constats d'audit structurés (Findings)** ont été relevés et classés selon leur criticité :

```
┌───────────────────────────────────────────────────────────────────────────┐
│               RÉPARTITION DES 73 FINDINGS DU GROUPE 5 MÉDIA               │
├────────────────────────────────┬──────────────────────────┬──────────────┤
│ Criticité                      │ Nombre de Constats       │ Pourcentage  │
├────────────────────────────────┼──────────────────────────┼──────────────┤
│ 🔴 P0 - Critique (Bloquant/AV) │ 16 constats              │ 21.9 %       │
│ 🟠 P1 - Élevé (Qualité/Perf)   │ 43 constats              │ 58.9 %       │
│ 🟡 P2 - Moyen (UX/A11y/Fine)   │ 14 constats              │ 19.2 %       │
├────────────────────────────────┼──────────────────────────┼──────────────┤
│ TOTAL                          │ 73 constats d'audit      │ 100.0 %      │
└────────────────────────────────┴──────────────────────────┴──────────────┘
```

---

## 2. Synthèse Thématique par Expert Persona

### Persona 5.1 : Web Audio API, DSP & Traitement Audio Temps Réel
- **Chaîne DSP Complète** : Construction d'un graphe complet `MediaStreamSource` $\rightarrow$ `BiquadFilter` (Passe-Haut Butterworth 80 Hz anti-rumble) $\rightarrow$ `DynamicsCompressor` (voix douce, ratio 4:1) $\rightarrow$ `GainNode` (contrôle anti-pop avec rampe exponentielle 25 ms) $\rightarrow$ `Limiter` (-1.0 dBFS anti-écrêtage) $\rightarrow$ `MediaStreamDestination`.
- **Autoplay & Cycle de Vie** : Déblocage systématique de l'`AudioContext` (`state === 'suspended'`) sur geste utilisateur et écoute de `statechange`.
- **Découplage Audio du DOM** : Élimination de la destruction des balises audio lors des redessins de la grille vidéo.

### Persona 5.2 : VAD (Voice Activity Detection), Réduction de Bruit & Élimination d'Écho
- **VAD Spectral Psychoacoustique** : Analyse RMS bornée à la bande vocale humaine (300 Hz – 3400 Hz), rejetant les vibrations sous-graves et le souffle aigu.
- **Suivi Dynamique du Plancher de Bruit** : Plancher adaptatif avec seuil SNR relatif (+9 dB) et machine à états Attack (40 ms) / Hold-Hangover (400 ms) / Release (150 ms) supprimant le clignotement de l'indicateur d'orateur.
- **Diffusion P2P `SPEAKER_STATE`** : Signalement discret dans le maillage pour illuminer les tuiles distantes en temps réel.
- **Contraintes `voiceIsolation` 2026** : Activation de l'isolation vocale IA système (`voiceIsolation: true`, mono 48 kHz).

### Persona 5.3 : Visualisation Audio Temps Réel, Canvas 60 FPS & Animations CSS
- **Zero GC Churn dans `requestAnimationFrame`** : Mise en cache stricte de `CanvasGradient` (recalculé uniquement lors des `ResizeObserver`).
- **Retina / DPR Scaling Dynamique** : Mise à l'échelle automatique `canvas.width = cssWidth * dpr` avec clamp à 2.0 et barres arrondies `ctx.roundRect()`.
- **Économie d'Énergie Automatique** : Suspension instantanée de la boucle de rendu lorsque le panneau est masqué (`IntersectionObserver` et `document.visibilitychange`).
- **Élimination du Doublon `ui/visualizer.js`** : Unification vers `modules/media/audio-visualizer.js`.

### Persona 5.4 : Codecs Audio/Vidéo WebRTC, Paramètres SDP & Encodage Adaptatif
- **Opus FEC & DTX** : Configuration de `sdpFmtpLine` avec `useinbandfec=1;usedtx=1;stereo=0;maxplaybackrate=48000;maxaveragebitrate=32000` via `setCodecPreferences()`.
- **Ordre Préférentiel des Codecs Vidéo** : Hiérarchie `VP9 > H.264 > VP8 > AV1` négociée par transceiver.
- **Encodage Adaptatif Multidimensionnel** : Régulation conjointe de `maxBitrate`, `scaleResolutionDownBy` (1.0, 1.5, 2.0, 3.0) et `maxFramerate` (30, 25, 20, 15, 12 fps).
- **Budget Montant Global (Mesh Uplink Budgeting)** : Plafonnement de l'upload total à 3.5 Mbps partagé entre les $N-1$ pairs.

### Persona 5.5 : Partage d'Écran & Capture Média Système
- **Options Standardisées `getDisplayMedia` 2026** : `selfBrowserSurface: 'exclude'` (anti-miroir), `surfaceSwitching: 'include'`, `systemAudio: 'include'`, `CaptureController` avec `no-focus-change`.
- **Correction Prévisualisation Locale** : Affichage de l'écran partagé sur la tuile locale même si la webcam est éteinte.
- **Bascule Idempotente `replaceTrack`** : Détection de l'événement natif `track.onended` et bascule instantanée sans renégociation SDP superflue.
- **Profil Netteté Texte/Code** : Application de `contentHint: 'detail'` et `degradationPreference: 'maintain-resolution'`.

### Persona 5.6 : Gestion des Périphériques, Permissions Matérielles & Sélection de Sortie
- **Énumération Sécurisée (`enumerateDevices`)** : Partitionnement `audioInputs`, `audioOutputs`, `videoInputs`.
- **Résilience Hot-Plug (`devicechange` & `track.onended`)** : Basculement automatique en cas de débranchement de casque/caméra.
- **Routage de Sortie `setSinkId`** : Application sur tous les éléments sonores pour envoyer le flux vers le casque et éliminer l'écho.
- **Persistance Multi-Critères IndexedDB** : Sauvegarde `{ deviceId, label, groupId }` avec cascade de résolution au démarrage.
- **Test Sonore Intégré** : Synthèse Web Audio d'un carillon pour tester la sortie sélectionnée.

### Persona 5.7 : Audio Spatial / 3D & Positionnement Sonore de la Grille Vidéo
- **Moteur `SpatialAudioEngine`** : Architecture Web Audio dédiée avec `PannerNode`, `AudioListener` et modèles `HRTF` (casque) / `equalpower` (haut-parleurs).
- **Projection Géométrique de Grille** : Calcul en temps réel des coordonnées 3D $(X, Y, Z)$ à partir des rectangles DOM (`getBoundingClientRect()`) et lissage continu `setTargetAtTime` ($\tau = 80\text{ ms}$).
- **Protection Anti-GC Chromium** : Rétention des références fortes de `MediaStreamAudioSourceNode`.
- **Toggle Audio Spatial** : Option dans les réglages et bouton `🎧 3D` dans la barre de contrôle.

### Persona 5.8 : AudioWorklet, Traitement Hors Thread Principal & Buffers Basse Latence
- **Processeur Dédié `vad-worklet-processor.js`** : Calcul VAD par bloc de 128 échantillons (~2.67 ms @ 48 kHz) exécuté dans `AudioWorkletGlobalScope`, immunisé contre le Garbage Collector et les gels UI.
- **Chargement Isomorphique Conforme CSP MV3** : Utilisation de `chrome.runtime.getURL()` sous Extension et `import.meta.url` sous PWA (zéro Blob URL bloqué par la CSP).
- **IPC Throttlé & Zéro Allocation** : Émission instantanée des changements d'état et télémétrie RMS cadencée à 25 ms.

### Persona 5.9 : Synchronisation A/V, Lip-Sync & Gestion du Buffer de Gigue (Jitter Buffer)
- **Suppression du Double Playout** : Unification du rendu A/V sur la balise `<video>` (et `<audio>` réservé au mode sans vidéo).
- **Association MSID Stricte** : Appel systématique de `sender.setStreams(stream)` dans `p2p-mesh.js` pour garantir le groupement `a=msid` dans le SDP.
- **Contrôle Jitter Buffer W3C** : Configuration de `jitterBufferTarget = 50\text{ ms}` (fallback `playoutDelayHint = 0.05\text{ s}`).
- **Télémétrie Lip-Sync** : Extraction de `estimatedPlayoutTimestamp` et détection des désynchronisations (> 80 ms).

### Persona 5.10 : UX des Appels, Grille Vidéo Réactive, Mode PiP & Raccourcis Clavier
- **Raccourcis Clavier Universels** : Barre d'espace pour le Push-to-Talk (`keydown`/`keyup` avec garde `e.repeat`), touche `M` (Mute micro) et touche `V` (Caméra), avec exclusion stricte des éléments de formulaire (`INPUT`, `TEXTAREA`).
- **Picture-in-Picture Natif** : Support prioritaire de la Document Picture-in-Picture API (`window.documentPictureInPicture`) avec fallback `video.requestPictureInPicture()`.
- **Grille Vidéo Réactive & Container Queries** : CSS Container Queries `@container` et attributs d'état `data-peer-count="1|2|3-4|5+"`.
- **Barre de Contrôle Sticky Glassmorphic** : `position: sticky; bottom: 0; backdrop-filter: blur(16px)` toujours accessible.
- **Accessibilité WCAG 2.2** : `aria-pressed`, live region `#call-a11y-announcer`, infobulles `aria-keyshortcuts`.

---

## 3. Plan d'Action & Déploiement des Correctifs P0/P1

Les modifications identifiées seront déployées avec **stricte parité d'octets** entre `APPLICATIONS/Communications/P2P/Extension/sidepanel/` et `APPLICATIONS/Communications/P2P/WebApp/` :

1. **`modules/media/vad-worklet-processor.js`** [NOUVEAU] : Processeur AudioWorklet temps réel (High-Pass 85Hz + RMS + Noise Floor + Hangover).
2. **`modules/media/spatial-audio.js`** [NOUVEAU] : Moteur d'audio spatial 3D (PannerNodes, HRTF, projection de grille et persistance).
3. **`modules/media/audio-processor.js`** : Refactorisation complète intégrant le chargement isomorphique AudioWorklet, chaîne DSP vocale et fallback résilient.
4. **`modules/media/audio-visualizer.js`** & **`ui/visualizer.js`** : Zero-GC loop, Retina DPR adaptatif, pause de visibilité et déduplication.
5. **`modules/media/media-stream.js`** : Énumération de périphériques, contraintes 2026 (`voiceIsolation`, `selfBrowserSurface`, `CaptureController`), écoute `devicechange`/`track.onended` et commutation à chaud.
6. **`core/config.js`** : Paramètres codecs Opus (FEC/DTX), ordre vidéo VP9/H264, ladder adaptatif multidimensionnel et uplink budgeting.
7. **`core/p2p-mesh.js`** : `setCodecPreferences`, `setStreams` pour Lip-Sync MSID, `replaceVideoTrack` sans renégociation, `jitterBufferTarget = 50ms`.
8. **`core/webrtc-telemetry.js`** : Télémétrie Lip-Sync `estimatedPlayoutTimestamp` et détection de désynchronisation A/V.
9. **`modules/media/call-controller.js`** :
   - Raccourcis clavier (Push-to-Talk Espace, M, V).
   - Mode Picture-in-Picture (Document PiP API + Video PiP fallback).
   - Intégration SpatialAudioEngine & gestion du routage `setSinkId`.
   - Suppression du double playout `<audio>` + `<video>`.
   - Réconciliation différentielle du DOM des tuiles vidéo.
   - Signalisation bidirectionnelle `SPEAKER_STATE` et `isScreenSharing`.
10. **`sidepanel/index.html` & `sidepanel/css/media.css`** :
    - Grille CSS réactive Container Queries (`data-peer-count`).
    - Barre sticky glassmorphism, contrôles PiP et Son 3D.
    - Sélecteurs de périphériques et bouton test sonore dans les réglages.
    - Live region WCAG 2.2 `#call-a11y-announcer` et `aria-pressed`.
11. **`WebApp/sw.js`** : Bump du cache PWA (`pmesh-pwa-v5`) et pré-mise en cache des modules `vad-worklet-processor.js` et `spatial-audio.js`.
