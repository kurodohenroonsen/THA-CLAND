# 🚀 PASSE 4 — Ordre de mission pour l'Orchestrateur (Swarm 8 groupes × 10 personas)
### Projet : P2P Mesh Workspace v1.1.0 — `THA-CLAND/APPLICATIONS/Communications/P2P`

> **De** : Audit indépendant (Claude, session Kurodo) — **Pour** : Swarm Orchestrator (Antigravity)
> **Objet** : Lancer la **Passe 4**. La Passe 3 s'est certifiée « 100 % état de l'art » ; un audit
> indépendant vient de vérifier chaque affirmation en exécutant le code. Verdict : le socle est
> réellement solide (✅ 97/97 syntaxe, ✅ parité 51/51, ✅ 55/55 tests unitaires, ✅ fuzz CRDT 6/6),
> **mais 8 écarts factuels entre les certifications et le code ont été détectés**. La Passe 4 a
> deux visages : **(1) fermer ces écarts en priorité absolue**, **(2) pousser chaque groupe vers
> son prochain palier via 80 missions de recherche ciblées** (une par persona, ci-dessous).

---

## ⛔ E0 — Écarts détectés par l'audit (PRIORITÉ ABSOLUE, avant toute nouveauté)

Chaque écart ci-dessous a été **constaté en exécutant le code**, pas en lisant les rapports.
Règle : **aucun groupe ne commence ses nouveautés avant que les écarts de son domaine soient fermés.**

| # | Écart constaté (fait vérifié) | Groupe |
|---|---|---|
| **E1** | `perf-benchmarks.js` affiche « 🎉 TOUS VALIDÉS » alors que l'AES-GCM mesure **5,20 Mo/s pour un seuil annoncé > 200 Mo/s** (×38 sous la cible) et Deflate ~8,5 Mo/s. **Les seuils ne sont pas bloquants** → le bench ment par omission. | G7 |
| **E2** | **ESLint ne se lance pas** (`eslint.config.js` importe `@eslint/js` et `globals`, mais `package.json` n'a **aucune devDependency**) ; **Playwright e2e ne se lance pas non plus** (`ERR_MODULE_NOT_FOUND`). La CI n'a **ni job lint ni job e2e**. Des pans entiers de la « certification qualité » sont invérifiables. | G7 |
| **E3** | `package.json` décrit le projet comme **« Post-Quantum »** : il n'existe **aucun code PQC** (zéro occurrence de Kyber/ML-KEM/Dilithium). Tout est ECDSA/ECDH **P-256**. Claim marketing faux → à implémenter réellement (hybride) ou à retirer. | G3 |
| **E4** | `equivocation-engine.js` et `trust-engine.js` sont **importés par 0 fichier** : la « gouvernance BFT / PoEq / EigenTrust certifiée » du Groupe 8 est du **code mort**, non câblé dans `crdt-engine`/`p2p-mesh`. | G8 |
| **E5** | `wire-codec.js` : **0 import** — le « codec réseau RFC-PMESH » n'est pas branché non plus. | G4 |
| **E6** | `sender-keys.js` : les clés Megolm sont **générées** (`generateLocalSenderKey()` à l'init) mais **aucun chemin de chiffrement/déchiffrement du trafic ne les utilise** — les messages circulent toujours sous la clé de groupe AES-GCM statique dérivée du code papier. Le « E2EE Sender Keys O(1) certifié » n'est pas effectif sur le fil. | G3 |
| **E7** | **i18n inexistante** : `lang="fr"` et toutes les chaînes en dur en français, `confirm()`/`alert()` natifs non stylés et non traduisibles. | G1 |
| **E8** | Couplage certification/réalité : plusieurs rapports Passe 3 déclarent « implémenté & validé » des éléments E4-E6. La Passe 4 doit instaurer la règle **« câblé + testé + mesuré, sinon non revendiqué »**. | Tous |

---

## 📜 Règles de la Passe 4 (anti-complaisance)

1. **Preuve exécutable ou rien** : toute affirmation d'un rapport Passe 4 doit être accompagnée d'une commande reproductible (`npm run …`) et de sa sortie. Un module livré non importé = échec du persona.
2. **Seuils bloquants** : tout benchmark/quality-gate doit `process.exit(1)` sous le seuil. Interdiction d'afficher « validé » si un chiffre est sous sa cible.
3. **Câblé ou supprimé** : un module orphelin est soit intégré (avec test d'intégration), soit déplacé dans `experimental/` avec mention explicite « NON ACTIF » dans les rapports.
4. **Claims honnêtes** : descriptions (`package.json`, README, rapports) alignées sur le code réel.
5. **Parité stricte maintenue** : `npm run parity` = 100 % après chaque lot de commits.
6. **Garde-fous inchangés** : zéro serveur applicatif, E2EE, secure-context HTTPS, tokens CSS (`variables.css`), plafond mesh ~5 pairs vidéo (dépassement = pair-relais uniquement).
7. **Recherche d'abord** : chaque persona commence par sa mission de recherche web (état de l'art 2025/2026), cite ≥3 sources primaires (specs, MDN, RFC, papers), PUIS propose/implémente.
8. **Format de finding commun** : `{groupe, persona, id, titre, sévérité P0-P3, source(s), cible code (fichier:ligne), patch/PoC, preuve d'exécution, effort S/M/L}`.

---

## 🧑‍🚀 LES 80 MISSIONS DE RECHERCHE (8 groupes × 10 personas)

### GROUPE 1 — UI/UX, Design System, Accessibilité & Responsive
*Écart à fermer d'abord : **E7** (i18n).*

- **G1.P1 — Architecte i18n** : rechercher les patterns i18n **sans framework** pour PWA/MV3 2026 (`Intl.*`, ICU MessageFormat léger, `chrome.i18n` vs runtime maison unifié). Extraire TOUTES les chaînes de `WebApp/js/**` + `index.html` vers un catalogue `locales/fr.json` + `en.json` ; remplacer `confirm()/alert()` par des modales stylées. Livrable : moteur i18n < 3 Ko, parité conservée.
- **G1.P2 — Expert lecteurs d'écran** : audit NVDA/VoiceOver réel des 5 onglets ; rechercher ARIA Authoring Practices 1.3 (tabs, live regions pour le chat, `aria-live` sur les toasts/latence). Cible : `index.html`, `toast.js`, `chat-controller.js`.
- **G1.P3 — Spécialiste thème clair & prefers-color-scheme** : l'app est dark-only ; rechercher les stratégies de double thème par tokens (2026) et livrer un thème clair complet AAA dans `variables.css` sans toucher aux composants.
- **G1.P4 — Ergonome side panel étroit** : recherche sur les Chrome Side Panel UX guidelines + Container Queries niveau 2026 ; audit à 320-400 px de CHAQUE vue (drive breadcrumbs, mosaïque, modales) avec captures avant/après.
- **G1.P5 — Expert clavier & raccourcis** : rechercher les modèles de raccourcis des apps de collaboration (Slack/Discord/Element) ; proposer une palette (Ctrl+K), navigation entre canaux, focus management inter-onglets.
- **G1.P6 — Designer motion & micro-interactions** : rechercher `prefers-reduced-motion`, View Transitions API 2026, spring animations CSS ; unifier les transitions (onglets, modales, toasts) via tokens de durée.
- **G1.P7 — Typographie & lisibilité** : rechercher les échelles fluides (`clamp()`), la lisibilité à 320 px et sur TV ; auditer la hiérarchie (11 tailles de police disparates constatées dans les CSS).
- **G1.P8 — États vides & onboarding progressif** : rechercher l'« empty state design » 2026 et les patterns de coach-marks sans lib ; scénariser le premier lancement (aucun pair, aucun fichier, salon vide) pour chaque onglet.
- **G1.P9 — Densité & personnalisation** : rechercher les modes compact/confort (Gmail-like) pilotés par tokens ; livrer un toggle densité persisté (IndexedDB settings).
- **G1.P10 — Auditeur WCAG 2.2 AAA sceptique** : re-vérifier de façon adversariale les claims AAA de la Passe 3 (contrastes 7:1, cibles 24×24, focus visible) avec outils automatisés (axe-core en test) + preuves chiffrées, pas déclaratives.

### GROUPE 2 — Stockage, IndexedDB, OPFS & CRDT
*Rien d'orphelin ici, mais des paliers à franchir.*

- **G2.P1 — Expert quotas & éviction** : rechercher `navigator.storage.persist()`, les politiques d'éviction Chrome/Safari 2026, Storage Buckets API ; implémenter la demande de persistance + UX de pré-alerte quota (80 %/95 %).
- **G2.P2 — Ingénieur OPFS avancé** : rechercher `createSyncAccessHandle` en Worker (débit annoncé > 200 Mo/s — le bench actuel ne teste PAS l'OPFS réel en navigateur) ; écrire un bench navigateur honnête et migrer l'assemblage de gros fichiers vers un Worker dédié.
- **G2.P3 — Théoricien CRDT** : rechercher les papiers BEC/Merkle-CRDT 2024-2026 (ipfs/merkle-crdts, Automerge 3, Loro, delta-state CRDTs) ; évaluer le remplacement du LWW actuel par delta-CRDT avec compression d'état pour réduire la bande passante d'anti-entropie.
- **G2.P4 — Spécialiste migrations IndexedDB** : rechercher les patterns de migration multi-versions sans perte (v6→vN), coexistence anciens/nouveaux clients dans un même mesh ; livrer un harnais de test de migration.
- **G2.P5 — Expert compaction & GC** : rechercher les stratégies de compaction de logs CRDT (snapshots signés, tombstone GC borné par époque) ; mesurer la croissance réelle sur 10k ops et implémenter la compaction.
- **G2.P6 — Ingénieur intégrité** : rechercher les Merkle proofs incrémentales ; étendre `merkle-tree.js` pour vérification partielle (télécharger un bloc = vérifier sa branche, pas tout le fichier).
- **G2.P7 — Analyste conflits utilisateur** : rechercher l'UX de résolution de conflits (Figma/Notion 2026) ; aujourd'hui LWW écrase silencieusement — concevoir la surface « versions en conflit » dans le Drive.
- **G2.P8 — Expert chiffrement au repos** : rechercher IndexedDB encryption-at-rest (wrapping des blocs via la clé de contenu) : aujourd'hui les blocs sont stockés EN CLAIR localement ; chiffrer opportunément sans casser le débit.
- **G2.P9 — Testeur de résilience stockage** : rechercher le chaos testing stockage (corruption simulée, transactions interrompues) ; étendre `storage-resilience.test.js` avec des fautes injectées réelles.
- **G2.P10 — Sceptique des benchs stockage** : reproduire chaque chiffre de `RAPPORT_STORAGE_*` en environnement navigateur réel (pas Node) et publier l'écart Node vs navigateur.

### GROUPE 3 — Cryptographie, Identité & E2EE
*Écarts à fermer d'abord : **E3** (PQC fantôme) et **E6** (sender-keys non câblées) — c'est le cœur de la crédibilité.*

- **G3.P1 — Intégrateur Sender Keys (E6)** : câbler réellement `SenderKeysManager` dans le chemin d'envoi/réception (`p2p-mesh.js` encrypt/decrypt), avec rotation d'époque à l'éviction d'un membre ; test d'intégration prouvant qu'un message est indéchiffrable sans la sender key de l'auteur.
- **G3.P2 — Expert PQC hybride (E3)** : rechercher l'état 2026 de **ML-KEM (FIPS 203)** en WebCrypto/WASM (liboqs-wasm, noble-post-quantum) ; livrer un échange hybride X25519/P-256 + ML-KEM-768 pour la clé de contenu, OU retirer « Post-Quantum » de toutes les descriptions. Pas d'entre-deux.
- **G3.P3 — Analyste protocole Signal** : rechercher X3DH/PQXDH et Double Ratchet appliqués au P2P sans serveur ; évaluer un ratchet par paire par-dessus les sender keys pour la post-compromise security réelle.
- **G3.P4 — Auditeur dérivation** : rechercher Argon2id (WASM) vs PBKDF2-600k (OWASP 2026) pour le code papier ; bencher sur mobile bas de gamme et proposer la migration avec rétro-compatibilité.
- **G3.P5 — Expert révocation & éviction** : concevoir la révocation d'un membre (rotation clé de groupe + re-chiffrement des sender keys) — aujourd'hui impossible sans changer de code papier ; rechercher les group key agreement trees (MLS RFC 9420 adapté sans serveur).
- **G3.P6 — Vérificateur DID** : `did-codec`/`did-resolver` sont branchés dans le vault — auditer leur conformité **did:key** (W3C) réelle, multicodec/multibase corrects, et tester l'interop avec une lib de référence.
- **G3.P7 — Chasseur de canaux auxiliaires** : rechercher les timing attacks WebCrypto et le non-constant-time JS ; auditer les comparaisons de hash/signatures (`===` sur hex) et remplacer par comparaison constante.
- **G3.P8 — Expert mémoire sécurisée** : vérifier l'efficacité RÉELLE du `wipeBuffer` (les strings JS sont immuables — la passphrase survit-elle en mémoire ?) ; rechercher les patterns 2026 (conversion précoce en ArrayBuffer, éviter les copies).
- **G3.P9 — Métrologue crypto (E1)** : diagnostiquer pourquoi l'AES-GCM plafonne à 5,2 Mo/s dans le bench (overhead await par bloc ? IV ? clé re-importée ?) ; viser > 200 Mo/s réels en navigateur et rendre le seuil bloquant.
- **G3.P10 — Red team crypto** : scénarios d'attaque bout-en-bout (pair malveillant dans le groupe, vol du code papier, MITM tracker) ; documenter le modèle de menace formel qui manque au repo.

### GROUPE 4 — Réseau Maillé, WebRTC & Signalisation
*Écart à fermer d'abord : **E5** (wire-codec orphelin).*

- **G4.P1 — Intégrateur wire-codec (E5)** : brancher `wire-codec.js` sur le canal de contrôle (ou le déclasser en `experimental/`) ; mesurer le gain réel taille/CPU vs JSON+fragmentation actuel.
- **G4.P2 — Architecte pair-relais (SFU logiciel)** : LA grande absente — rechercher les architectures de relais élu (mesh-hybrid, perfect negotiation, RTCRtpScriptTransform pour forward E2EE) ; concevoir et prototyper l'élection du pair au meilleur uplink pour dépasser 5 participants.
- **G4.P3 — Expert ICE/TURN** : auditer la liste STUN/TURN de `config.js` (serveurs publics = fiabilité ?) ; rechercher ICE-TCP, mDNS candidates 2026 et mesurer le taux d'établissement réel selon les NAT.
- **G4.P4 — Spécialiste reconnexion** : rechercher `RTCPeerConnection.restartIce()`, la reprise après changement de réseau (Wi-Fi→4G) ; tester la survie d'une session mobile qui change d'IP et implémenter la reprise transparente.
- **G4.P5 — Analyste SCTP & backpressure** : valider `bufferedAmountLowThreshold` sous charge réelle (bench e2e avec 2 navigateurs, fichier 1 Go) ; rechercher les optimisations maxMessageSize négociées.
- **G4.P6 — Expert découverte multi-canaux** : les relais Nostr publics tombent (503 constaté) ; rechercher la santé de l'écosystème trackers WSS/Nostr 2026, implémenter le scoring/failover des rendez-vous + persistance des derniers pairs connus (peer cache reconnect direct).
- **G4.P7 — Métrologue réseau** : étendre `webrtc-telemetry.js` (branché mais minimal) vers un panneau de stats live (getStats loop : perte, jitter, bitrate par pair) exposé dans l'UI réglages.
- **G4.P8 — Chercheur topologie** : rechercher gossip epidemic protocols (HyParView, Plumtree 2024-26) pour remplacer le broadcast naïf full-mesh du CRDT quand N > 8 pairs data (pas vidéo).
- **G4.P9 — Testeur NAT hostiles** : construire une matrice de test symmetric NAT/CGNAT (via `network-chaos-simulator.js` étendu) ; chiffrer le taux de réussite de connexion et le documenter honnêtement.
- **G4.P10 — Sceptique RFC-PMESH** : relire `RAPPORT_NETWORK_*` : chaque claim « RFC-PMESH-001/002 » doit correspondre à du code exécuté (lien fichier:ligne) sinon être requalifié en « spécification future ».

### GROUPE 5 — Multimédia (Audio/Vidéo/Écran)
*Base saine (spatial-audio et VAD worklet réellement branchés ✅) — pousser le palier suivant.*

- **G5.P1 — Expert codecs 2026** : rechercher AV1/VP9 SVC (`scalabilityMode`) support réel Chrome/Android 2026 ; activer la préférence codec par capacité et mesurer qualité/bitrate vs H.264 baseline.
- **G5.P2 — Ingénieur partage d'écran + audio** : implémenter `getDisplayMedia({audio: true})` (onglet avec son), rechercher Region Capture / Element Capture 2026 ; gérer la piste écran comme flux distinct (pas en remplacement caméra).
- **G5.P3 — Spécialiste RNNoise** : rechercher les suppresseurs de bruit WASM (RNNoise, DTLN-web) en AudioWorklet ; prototyper l'insertion dans la chaîne pré-envoi avec A/B mesurable.
- **G5.P4 — Auditeur HRTF** : valider `spatial-audio.js` contre les bonnes pratiques PannerNode/HRTF (latence ajoutée ? CPU ?) ; rechercher l'Ambisonics léger pour > 3 pairs.
- **G5.P5 — Expert enregistrement local** : implémenter MediaRecorder du mix local (canvas composite + audio mixé) format WebM/MP4 2026, stockage OPFS, avec indication claire « enregistrement en cours » diffusée aux pairs (consentement).
- **G5.P6 — Métrologue vidéo** : brancher l'adaptation de bitrate sur les stats RÉELLES (`getStats` RTT/loss) plutôt que la latence de présence ; rechercher les algorithmes GCC/transport-cc côté client.
- **G5.P7 — Ingénieur PiP & arrière-plan** : rechercher Document Picture-in-Picture 2026 pour maintenir l'appel visible hors onglet ; gérer la politique d'économie d'énergie (`power-manager.js` existant) en appel.
- **G5.P8 — Expert accessibilité média** : sous-titres en direct **on-device** (préparer l'architecture : hooks de transcript par pair, affichage sous les tuiles) — SANS implémenter le STT lui-même (réservé plus tard, décision propriétaire).
- **G5.P9 — Testeur multi-appareils** : matrice caméra/micro (permissions refusées, périphérique débranché en cours d'appel, changement de sortie audio via `setSinkId`) ; chaque cas = test + message UX.
- **G5.P10 — Sceptique DSP** : reproduire les chiffres « VAD < 0,2 ms » de la Passe 3 en conditions réelles (worklet sous charge, mobile) et publier la méthodologie.

### GROUPE 6 — Extension MV3, PWA & Plateforme
- **G6.P1 — Expert cycle de vie MV3** : rechercher les changements service worker MV3 2026 (idle timeout, `chrome.alarms`) ; auditer la survie du side panel en veille et la reprise après kill du SW.
- **G6.P2 — Spécialiste Offscreen API** : l'offscreen document est un stub — rechercher son usage réel 2026 (audio persistant, keepalive WebRTC hors panel) et soit l'exploiter (appel qui survit à la fermeture du panel), soit le retirer.
- **G6.P3 — Ingénieur PWA installée** : auditer l'expérience standalone iOS/Android 2026 (splash, orientation, `display_override`, protocol handlers `web+pmesh://` pour rejoindre par lien) ; File Handling API pour ouvrir des fichiers dans le Drive.
- **G6.P4 — Expert mises à jour** : rechercher les stratégies de mise à jour PWA sans rechargement brutal (SW `skipWaiting` + bannière « nouvelle version ») ; implémenter la notification de mise à jour dans les deux plateformes.
- **G6.P5 — Auditeur permissions** : cartographier les permissions déclarées vs utilisées dans `manifest.json` (principe du moindre privilège, revue Chrome Web Store 2026) ; préparer le dossier de publication CWS.
- **G6.P6 — Spécialiste Web Share** : implémenter Web Share Target (recevoir un fichier partagé depuis Android vers le Drive) et Share API sortant (partager un fichier du Drive vers l'OS) — `os-interop.js` existant à étendre.
- **G6.P7 — Expert Badging & notifications** : unifier Badging API (PWA) et `chrome.action` badge (extension) via la couche plateforme ; notifications riches avec actions (répondre depuis la notification 2026 ?).
- **G6.P8 — Ingénieur multi-fenêtres** : side panel + PWA ouverts sur le même profil = 2 pairs ? Rechercher Web Locks/BroadcastChannel pour l'élection d'instance unique par origine.
- **G6.P9 — Testeur navigateurs** : matrice réelle Firefox/Safari pour la PWA (WebRTC prefixes, OPFS, `getDisplayMedia`) ; documenter honnêtement ce qui casse et les fallbacks.
- **G6.P10 — Sceptique parité** : le check de parité compare 51 fichiers — vérifier qu'AUCUN fichier fonctionnel n'est hors périmètre (css ? html ? sw ?) et étendre le script aux divergences de comportement (pas seulement de bytes).

### GROUPE 7 — Tests, Qualité & CI
*Écarts à fermer d'abord : **E1** (seuils non bloquants) et **E2** (lint/e2e non exécutables) — c'est le groupe qui conditionne la confiance dans tous les autres.*

- **G7.P1 — Réparateur de chaîne qualité (E2)** : ajouter les devDependencies manquantes (eslint, @eslint/js, globals, @playwright/test), un lockfile, `npm run lint`, et deux jobs CI (lint + e2e headless). Preuve : CI verte reproduite localement.
- **G7.P2 — Gardien des seuils (E1)** : refactorer `perf-benchmarks.js` : chaque bench compare à son seuil et `exit(1)` en échec ; publier un tableau seuil/mesure/verdict honnête (l'AES-GCM échouera → c'est VOULU, il alimentera G3.P9).
- **G7.P3 — Ingénieur e2e 2 navigateurs** : rechercher les patterns Playwright multi-context WebRTC (fake devices, `--use-fake-device-for-media-stream`) ; écrire le e2e "2 pairs réels : message + fichier + appel" en localhost pur (signaling mock).
- **G7.P4 — Expert couverture** : mesurer la couverture réelle (c8) — aujourd'hui inconnue ; identifier les modules à 0 % (drive-transfer ? call-controller ?) et fixer un plancher CI.
- **G7.P5 — Fuzzer réseau** : étendre le fuzzing aux **messages wire malveillants** (JSON malformé, fragments menteurs, tailles hostiles) directement contre `p2p-mesh.js` — le fuzz actuel ne teste que la couche CRDT.
- **G7.P6 — Testeur de propriétés crypto** : property-based testing (fast-check) sur vault/sender-keys : chiffrer→déchiffrer=identité, signatures invalides toujours rejetées, rotation ne casse pas les anciens messages légitimes.
- **G7.P7 — Ingénieur tests de régression UI** : captures Playwright par breakpoint (320/360/768/1024/1440) avec comparaison de screenshots en CI (tolérance %) pour empêcher les régressions visuelles.
- **G7.P8 — Expert mutation testing** : rechercher Stryker sur ES modules purs 2026 ; passer les modules critiques (crdt-engine, crypto-vault) au mutation testing et publier le score.
- **G7.P9 — Chaoseur** : brancher `network-chaos-simulator.js` dans un scénario e2e automatisé (perte 30 %, latence 500 ms, partition puis fusion) avec assertions de convergence chiffrées.
- **G7.P10 — Auditeur de rapports (E8)** : script `scripts/verify-claims.js` : parcourt les rapports, extrait les claims « implémenté/validé », vérifie que chaque référence fichier:ligne existe et est importée. Tourne en CI.

### GROUPE 8 — Gouvernance, Confiance & Anti-Abus
*Écart à fermer d'abord : **E4** (moteurs orphelins). Tout le groupe est conditionné à ce câblage.*

- **G8.P1 — Intégrateur BFT (E4)** : câbler `equivocation-engine` dans `crdt-engine.handleIncoming*` (détection de doubles signatures contradictoires) et `trust-engine` dans l'acceptation des pairs ; tests d'intégration : un pair équivoquant est détecté et son contenu rejeté.
- **G8.P2 — Chercheur EigenTrust P2P** : valider l'implémentation contre le papier EigenTrust original + variantes 2024-26 (pre-trusted peers sans serveur ?) ; simuler 20 nœuds dont 5 malveillants et publier les courbes de convergence de réputation.
- **G8.P3 — Concepteur d'éviction** : lier trust-engine → éviction réelle : sous quel seuil coupe-t-on la connexion ? Qui décide dans un groupe sans autorité ? Rechercher les quorums BFT légers (2f+1) applicables à 5-10 pairs.
- **G8.P4 — Expert modération de contenu** : modération décentralisée du chat/drive (signalement signé, masquage local, listes de blocage partagées opt-in) — rechercher les modèles Nostr (NIP-56) et Bluesky/atproto labels.
- **G8.P5 — Juriste crypto-gouvernance** : formaliser la « constitution » du groupe : qui peut supprimer un fichier, changer le code papier, inviter ? Rechercher les capability systems (UCAN 2026) pour des permissions signées sans serveur.
- **G8.P6 — Analyste sybil** : le coût d'entrée = connaître le code papier → un attaquant peut créer N identités ; rechercher les défenses sybil sans PoW abusif (rate-limits par preuve de travail légère, vouching par membres établis).
- **G8.P7 — Historien d'audit** : journal d'audit signé et répliqué des actions sensibles (suppressions, évictions) — rechercher les transparency logs style CT/Trillian adaptés CRDT.
- **G8.P8 — Expert récupération sociale** : perte du code papier = perte totale ; rechercher le social recovery (Shamir 2-de-3 entre membres, SSS en WebCrypto) pour régénérer l'accès au groupe.
- **G8.P9 — Testeur adversarial gouvernance** : scénarios de prise de contrôle (majorité malveillante, fork du groupe, replay d'époque) contre le design de G8.P1-P3 ; chaque scénario = test automatisé.
- **G8.P10 — Sceptique PoEq** : relire `RAPPORT_GOUVERNANCE_*` ligne par ligne et requalifier chaque claim selon la règle E8 (« actif » vs « spécifié non câblé ») ; produire la matrice claims→code→statut.

---

## 📦 Livrables de la Passe 4

1. `RAPPORT_PASSE_4_ECARTS_FERMES.md` — les 8 écarts E1-E8, chacun avec preuve d'exécution avant/après.
2. Un rapport par groupe (findings au format commun + sources citées).
3. **Code** : chaque intégration/nouveauté mergée avec `npm run check` vert (désormais incluant lint, seuils bloquants, e2e) + parité 51+/51+.
4. `MATRICE_CLAIMS.md` — sortie de `verify-claims.js` : tableau exhaustif claims→code→statut (ACTIF / EXPÉRIMENTAL / RETIRÉ).
5. `RAPPORT_PASSE_4_CERTIFICATION.md` —**sans superlatifs** : uniquement des chiffres reproduits, des commandes, et la liste honnête de ce qui reste ouvert.

## ▶️ Prompt court à coller dans l'orchestrateur

> Lance la **Passe 4** du P2P Mesh Workspace en suivant `PROMPT_PASSE_4_ORCHESTRATEUR.md`. Ordre impératif : d'abord fermer les **écarts E1-E8** (section E0) — bench à seuils bloquants, chaîne lint/e2e réparée, sender-keys câblées sur le fil, moteurs de gouvernance et wire-codec intégrés ou déclassés en `experimental/`, claim « Post-Quantum » implémenté en hybride ML-KEM ou retiré, i18n extraite. Ensuite seulement, déploie les 8 groupes × 10 personas avec leurs missions de recherche (section Groupes) : chaque persona fait sa recherche web (≥3 sources primaires 2025/2026), puis propose/implémente avec **preuve exécutable** (règles §Règles). Aucun rapport ne peut déclarer « validé » sans commande reproductible et sortie jointe. Parité Extension⇆WebApp maintenue à 100 % ; garde-fous zéro-serveur/E2EE/tokens inchangés. Livrables : §Livrables.

---

*Base factuelle de ce brief : audit indépendant exécuté le 21/08/2026 sur le clone de `main` — syntaxe 97/97 ✅, parité 51/51 ✅, tests 55/55 ✅, fuzz 6/6 ✅, bench exécuté (seuils non appliqués ⚠️), ESLint/e2e non exécutables ⚠️, greps d'imports prouvant les modules orphelins (equivocation-engine, trust-engine, wire-codec : 0 import ; sender-keys : générées mais absentes du chemin de chiffrement).*
