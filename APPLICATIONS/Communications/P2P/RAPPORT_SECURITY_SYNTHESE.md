# 🛡️ Synthèse Maître — Swarm Groupe 3 : Sécurité Cryptographique, Zéro-Knowledge & Confidentialité
### Projet : P2P Mesh Workspace (Extension Chrome Side Panel MV3 + Web App PWA)

**Auteurs** : Kurodo & Swarm des 10 Experts Sécurité & Cryptographie Antigravity  
**Date d'évaluation** : 21 Août 2026  
**Périmètre audité** : WebCrypto API, PBKDF2-SHA512 (600k rounds), AES-256-GCM (Nonces déterministes partitionnés & AAD), Signatures ECDSA P-256 (RFC 8785 JCS), Memory Scrubbing (Zeroization RAM), Anti-MITM (Safety Numbers SAS 5200 rounds & Visual Identicons SVG), CSP MV3 & Secure Context, Anonymat Réseau (Anti-IP Leak & Ephemeral Signaling), DOM Sanitization (Trusted Types & Anti-Path Traversal), Moindre Privilège Matériel (Hardware Gating) et Threat Modeling (STRIDE/DREAD).

---

## 1. Vue d'Ensemble & Métriques de l'Audit

Le Swarm de 10 experts en sécurité offensive et défensive a identifié **71 constats structurés** couvrant l'intégralité de la chaîne cryptographique, réseau, mémoire et applicative.

```
                                  ┌───────────────────────────────┐
                                  │   GROUPE 3 : CRYPTO & SEC     │
                                  └───────────────┬───────────────┘
         ┌──────────────────┬─────────────────────┼─────────────────────┬──────────────────┐
         ▼                  ▼                     ▼                     ▼                  ▼
   1. KDF & Entropie  2. AES-GCM / Nonces   3. Signatures & JCS   4. Memory Scrubbing 5. Anti-MITM & SAS
      (600k PBKDF2)      (Nonces partitionnés) (RFC 8785)            (Zeroization RAM)  (Safety Numbers)
         │                  │                     │                     │                  │
         ├──────────────────┼─────────────────────┼─────────────────────┼──────────────────┤
         ▼                  ▼                     ▼                     ▼                  ▼
   6. CSP MV3 & Guard 7. Anonymat Réseau    8. DOM Sanitization   9. Hardware Gating  10. STRIDE / DREAD
      (Secure Context)   (Anti-IP Leak)        (SanitizerService)    (Pagehide Teardown)(Peer Quarantine)
```

---

## 2. Synthèse Détaillée par Persona Expert (10 Domaines de Sécurité)

### 2.1 Expert Dérivation de Clés & KDF
* **Recherches 2026** : PBKDF2 avec HMAC-SHA-512 à 600 000 itérations (conformité OWASP Password Storage 2025/2026 & NIST SP 800-132), calcul d'entropie pondéré `CryptoVault.calculateEntropy()` avec détection des répétitions de mots, clés asymétriques générées avec `extractable: false`, zeroization des tampons intermédiaires.
* **Findings Clés** : `KDF-FINDING-01` (P0 - Implémentation `calculateEntropy`), `KDF-FINDING-02` (P1 - Découplage Topic ID), `KDF-FINDING-06` (P1 - Clés privées non extractibles), `KDF-FINDING-07` (P1 - Memory zeroization).

### 2.2 Expert Chiffrement Symétrique E2EE & Gestion des Nonces
* **Recherches 2026** : Élimination de la *Nonce-Reuse Catastrophe* (attaque de Joux sur le polynôme GHASH $\text{GF}(2^{128})$) via la construction déterministe partitionnée NIST SP 800-38D §8.2.1 (préfixe de nœud 32-bit aléatoire + compteur monotone 64-bit Big-Endian), spécification explicite `tagLength: 128` interdisant les tags tronqués, injection de Données Authentifiées Additionnelles (AAD / `additionalData`) liant le Topic, le PeerID et le contexte.
* **Findings Clés** : `FINDING-SYM-01` (P0 - Nonces déterministes partitionnés), `FINDING-SYM-02` (P1 - AAD contextuel universel), `FINDING-SYM-03` (P1 - TagLength 128-bit forcé), `FINDING-SYM-06` (P2 - Unification des erreurs de déchiffrement).

### 2.3 Expert Signatures Asymétriques, Intégrité & Canonisation (JCS)
* **Recherches 2026** : Canonisation déterministe stricte RFC 8785 (JSON Canonicalization Scheme - JCS) avec tri lexicographique UTF-16 et normalisation des flottants IEEE 754 (`-0` $\rightarrow$ `0`), signature obligatoire de tous les commits de Drive (`commit.signature = await vault.sign(...)`), ajout de la méthode `broadcastDriveCommit` dans le moteur CRDT, authentification systématique des tombstones de suppression de fichiers dans `delta.deletions` (anti-DoS par effacement arbitraire), renforcement de l'empreinte `peerId` à 128/160 bits (32 hex) contre le pré-calcul GPU.
* **Findings Clés** : `SEC-P33-01` (P0 - Signature commits Drive & CRDT), `SEC-P33-02` (P0 - Authentification tombstones anti-entropie), `SEC-P33-03` (P1 - Canonisation RFC 8785 JCS), `SEC-P33-05` (P1 - Empreinte PeerId 128 bits).

### 2.4 Expert Hygiène des Secrets & Garbage Collection RAM (Memory Scrubbing)
* **Recherches 2026** : Méthode de destruction explicite `CryptoVault.prototype.destroy()` et utilitaire `wipeBuffer(buffer)` (double passe aléatoire + `.fill(0)`), assainissement normalisé des logs dans `LoggerService.sanitize()` filtrant les clés avec séparateurs (`paper_code`, `private_key`, `secret_key`, `master_key`, `passphrase`, `token`, `keybytes`, `seed`), purge intégrale de l'arborescence DOM au moment de la connexion (`displayCode.textContent = ''`, `generatedBox.remove()`), séquence de déconnexion Zéro-Trace (`vault.destroy()` $\rightarrow$ `crdt.destroy()` $\rightarrow$ `mesh.stop()` $\rightarrow$ `logger.clearBuffer()`).
* **Findings Clés** : `FINDING-MEM-01` (P0 - Zeroization des buffers KDF), `FINDING-MEM-02` (P0 - Clés privées non extractibles), `FINDING-MEM-03` (P1 - Purge DOM code papier), `FINDING-MEM-04` (P1 - Assainisseur de logs durci), `FINDING-MEM-05` (P1 - `vault.destroy()` Zéro-Trace).

### 2.5 Expert Anti-MITM & Authentification Hors-Bande (Safety Numbers SAS & QR)
* **Recherches 2026** : Implémentation du protocole de Numéros de Sécurité (Safety Numbers type Signal 5 200 itérations SHA-512) générant 60 chiffres décimaux et 7 SAS Emojis commutatifs (`[pubKeyA, pubKeyB].sort()`), génération d'Identicons vectoriels déterministes SVG 5x5 symétriques basés sur SHA-256 de la clé SPKI, détection immédiate de rupture de clé publique dans `presence.js` (`security-key-changed`) empêchant l'usurpation silencieuse dans le Roster.
* **Findings Clés** : `FINDING-MITM-01` (P0 - Algorithme Safety Numbers 5200 rounds SHA-512), `FINDING-MITM-02` (P0 - Alerte changement de clé publique), `FINDING-MITM-03` (P1 - Identicons vectoriels SHA-256), `FINDING-MITM-05` (P1 - Badges de confiance).

### 2.6 Expert Isolation de Contexte, CSP MV3 & Secure Context
* **Recherches 2026** : Déclaration explicite dans `manifest.json` de la CSP stricte (`script-src 'self' 'wasm-unsafe-eval' ; object-src 'none' ; base-uri 'none'`), contrôle synchrone bloquant de `window.isSecureContext` dès le début de `P2PApp.init()`, validation stricte de l'émetteur `sender.id === chrome.runtime.id` et `sender.url` dans `service-worker.js` et `offscreen.js`, gel récursif de l'objet global shim `window.chrome` (`Object.freeze`) dans `platform-web.js` avec protection `noopener,noreferrer` sur l'ouverture d'onglets.
* **Findings Clés** : `FINDING-SEC-01` (P0 - CSP MV3 manifest.json), `FINDING-SEC-02` (P0 - Validation sender.id SW/Offscreen), `FINDING-SEC-03` (P1 - Guard synchrone isSecureContext), `FINDING-SEC-04` (P1 - Object.freeze shim chrome).

### 2.7 Expert Anonymat Réseau & Prévention des Fuites de Métadonnées
* **Recherches 2026** : Élimination des fuites d'adresses IP réelles LAN/Host via le filtrage des candidats `typ host` dans le SDP, remplacement des serveurs STUN tiers Google par des serveurs neutres indépendants (`stun.cloudflare.com`, `stun.nextcloud.com`), utilisation d'identifiants éphémères aléatoires de signalement (20 octets) sur les trackers WebTorrent découplés de la clé publique ECDSA, injection d'un jitter aléatoire ($\pm 1\,000\text{ ms}$) sur les battements cardiaques (Heartbeat) et padding des payloads SDP à 2 048 octets pour contrer l'analyse de trafic.
* **Findings Clés** : `NET-PRIV-01` (P0 - Filtrage candidats host & STUN neutre), `NET-PRIV-02` (P0 - Ephemeral Signaling PeerID), `NET-PRIV-04` (P1 - Heartbeat Jitter anti-fingerprint), `NET-PRIV-05` (P1 - Padding SDP constant).

### 2.8 Expert Sanitization DOM & Prévention XSS / Injections
* **Recherches 2026** : Création du module centralisé `SanitizerService` (`core/sanitizer.js`) avec échappement universel des 7 caractères dangereux (`&`, `<`, `>`, `"`, `'`, `/`, `` ` ``), assainissement strict des noms de fichiers téléchargés (`SanitizerService.sanitizeFileName` éliminant les traversées de répertoires `../`, le caractère d'inversion d'écriture RTLO `\u202E`, les caractères de contrôle et les noms réservés Windows `CON`, `PRN`, `AUX`, `NUL`), validation de schémas d'URI sûrs pour les avatars (`isSafeImageURI`), formatage sécurisé du Markdown sans injection d'attributs.
* **Findings Clés** : `SEC-XSS-01` (P0 - Échappement complet entités HTML), `SEC-XSS-02` (P0 - URLs Markdown sécurisées), `SEC-FIL-05` (P1 - Sanitizer noms de fichiers anti-RTLO/Traversal), `SEC-DOM-03` (P1 - Architecture SanitizerService).

### 2.9 Expert Permissions & Moindre Privilège (Hardware Gating)
* **Recherches 2026** : Coupure déterministe garantie des flux matériels caméra/micro et fermeture de l'`AudioContext` dans `permissions.js` et lors de la fermeture du Side Panel via les hooks `pagehide` et `beforeunload` dans `app.js` et `call-controller.js`, détachement propre et renégociation WebRTC à l'arrêt du partage d'écran (y compris sur déclenchement natif OS `onended`), gestion d'erreur non bloquante sur l'Autoplay audio avec support `setSinkId`.
* **Findings Clés** : `FINDING-PERM-01` (P0 - Libération matérielle permissions.js), `FINDING-PERM-02` (P0 - Hook d'évacuation pagehide/beforeunload), `FINDING-PERM-07` (P1 - Arrêt partage d'écran WebRTC), `FINDING-PERM-04` (P1 - Autoplay promise catch).

### 2.10 Expert Threat Modeling & Pentest Décentralisé (STRIDE / DREAD)
* **Recherches 2026** : Matrice des risques DREAD/STRIDE identifiant les 3 scénarios critiques du maillage P2P (suppression arbitraire de données par tombstones non signés, dérive artificielle de l'horloge de Lamport pour monopoliser la résolution LWW, famine de téléchargement swarm par déclaration frauduleuse de blocs), mise en place d'un système de réputation de pairs (`PeerReputationTracker`) avec mise en quarantaine automatique des nœuds défaillants.
* **Findings Clés** : `SEC-FINDING-01` (P0 - Authentification tombstones), `SEC-FINDING-02` (P0 - Entropie UI), `SEC-FINDING-03` (P1 - Bornage dérive Lamport), `SEC-FINDING-06` (P1 - Peer scoring & quarantaine).

---

## 3. Plan d'Implémentation Immédiat des Correctifs P0/P1

1. **`core/sanitizer.js`** : Création du module centralisé de sanitization DOM, échappement universel, nettoyage anti-RTLO et validation d'images.
2. **`core/crypto-vault.js`** :
   - Implémentation de `calculateEntropy(code)` (bits, label, cls, pct).
   - Nonces déterministes partitionnés (32-bit prefix + 64-bit counter).
   - TagLength 128-bit explicite et AAD universel.
   - Canonisation RFC 8785 (JCS) stricte.
   - `computeSafetyNumber` (5200 rounds SHA-512) et `generateVisualFingerprint` (SVG 5x5).
   - `destroy()` et `wipeBuffer()`.
   - Clés privées ECDSA générées avec `extractable: false`.
   - Zeroization des buffers KDF.
3. **`core/config.js`** : Ajout des paramètres PRIVACY (STUN neutres Cloudflare/Nextcloud, strip host candidates, SDP padding).
4. **`core/logger.js`** : Assainissement durci des clés d'objets (normalisation regex).
5. **`core/crdt-engine.js`** : Ajout de `broadcastDriveCommit`, authentification stricte des suppressions dans `delta.deletions` et limitation de la dérive Lamport.
6. **`core/presence.js`** : Intégration de `generateVisualFingerprint`, détection d'usurpation / changement de clé publique, jitter sur le heartbeat.
7. **`core/p2p-mesh.js`** : Ephemeral signaling peerId sur trackers et filtrage des candidats host du SDP.
8. **`modules/drive/drive-transfer.js`** : Système de réputation et mise en quarantaine des pairs.
9. **`modules/drive/drive-controller.js` & `modules/chat/chat-controller.js`** : Utilisation de `SanitizerService.sanitizeFileName` et `SanitizerService.formatSafeChatMessage`.
10. **`permissions.js`** : Nettoyage déterministe du flux micro/caméra et AudioContext.
11. **`manifest.json`** : Ajout de la CSP stricte `extension_pages` (`wasm-unsafe-eval`, `object-src 'none'`).
12. **`background/service-worker.js` & `offscreen/offscreen.js`** : Validation `sender.id === chrome.runtime.id`.
13. **`platform-web.js`** : `Object.freeze` sur `window.chrome`.
14. **`app.js`** : Guard synchrone `isSecureContext`, écouteurs `pagehide`/`beforeunload` et déconnexion Zéro-Trace complète.
15. **`sw.js`** : Mise à jour du cache PWA.
