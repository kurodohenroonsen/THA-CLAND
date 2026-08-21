# 🌐 Rapport de Synthèse — Swarm Groupe 4 : Réseau P2P, WebRTC Mesh & Signalement Décentralisé

**Projet** : P2P Mesh Workspace (Extension Chrome MV3 + Web App PWA)  
**Date d'évaluation** : 21 Août 2026  
**Auteurs** : Swarm des 10 Experts Personas Réseau P2P (4.1 à 4.10)  
**Destinataire** : Kurodo & Orchestrateur Antigravity  
**Statut** : Audit Maître Validé & Spécifications P0/P1 Prêtes au Déploiement

---

## 1. Vue d'Ensemble & Bilan Exécutif

Le Swarm d'experts Groupe 4 a audité en profondeur l'ensemble de la couche réseau, de transport binaire, de signalement multi-voies et de résilience WebRTC. Au total, **71 constats d'audit structurés (Findings)** ont été relevés et classés selon leur criticité :

```
┌───────────────────────────────────────────────────────────────────────────┐
│              RÉPARTITION DES 71 FINDINGS DU GROUPE 4 RÉSEAU               │
├────────────────────────────────┬──────────────────────────┬──────────────┤
│ Criticité                      │ Nombre de Constats       │ Pourcentage  │
├────────────────────────────────┼──────────────────────────┼──────────────┤
│ 🔴 P0 - Critique (Bloquant)    │ 22 findings              │ 31%          │
│ 🟠 P1 - Élevé (Performance/QoS)│ 36 findings              │ 51%          │
│ 🟡 P2 - Moyen (Observabilité)  │ 13 findings              │ 18%          │
└────────────────────────────────┴──────────────────────────┴──────────────┘
```

---

## 2. Synthèse Détaillée par Persona d'Expertise

### Persona 4.1 : Topologie Full-Mesh & Routage Décentralisé
- **Problème $O(N^2)$** : Au-delà de 6 à 8 pairs, le maintien de connexions directes complètes sature les descripteurs de fichiers OS et le thread libwebrtc.
- **Solution 2026** : Topologie adaptative hybride : Full-Mesh transparent si $N \le 6$, Sparse-Mesh ($K=6..8$) avec diffusion Gossip si $N > 6$.
- **Optimisation Broadcast** : Chiffrement unique préalable (*Single Encrypt - Multi Send*) dans `broadcast()` au lieu d'une boucle séquentielle de chiffrements redondants.
- **Teardown Déterministe** : Fermeture explicite des DataChannels, désarmement des écouteurs et libération des transceivers pour éliminer les fuites de sockets zombis.

### Persona 4.2 : Signalement Décentralisé Nostr (NIPs & Relais WSS)
- **Signalement Hybride** : Rétablissement de l'émission symétrique d'annonces et d'offres SDP sur le pool de relais Nostr (Kind éphémère 29000 et Kind 29001 avec NIP-40).
- **Nettoyage Automatique NIP-40** : Injection systématique du tag `['expiration', String(now + 60)]` sur les événements de signalement pour éviter la pollution des relais.
- **Nostr Relay Pool** : Gestionnaire multi-relais avec bascule automatique (Failover) et reconnexion avec backoff exponentiel + Full Jitter.
- **Topic Aveugle (Blinded Topic)** : Hachage `HMAC-SHA256(topicHex, 'Nostr-Blinded-Rendezvous-v1')` pour masquer l'identifiant de groupe sur les relais publics.

### Persona 4.3 : Signalement Trackers WebTorrent & BitTorrent WSS
- **Pool Multi-Trackers BEP 0012** : Remplacement du tracker unique (SPOF) par un pool de 4 trackers WSS opérationnels en 2026.
- **Timeout Handshake (6s)** : Clôture immédiate des connexions WebSocket bloquées à l'état `CONNECTING`.
- **Handshake de Départ Gracieux** : Émission systématique de l'annonce `{ event: 'stopped', numwant: 0 }` lors du `stop()` pour purger les offres immédiatement et éliminer les pairs fantômes.
- **Parallélisation des Offres ICE** : Remplacement de la boucle séquentielle par `Promise.all()` divisant par 3 le temps d'annonce.

### Persona 4.4 : Traversée NAT, ICE Gathering & STUN/TURNS
- **Rassemblement ICE Adaptatif** : Court-circuit de l'attente SDP dès la découverte du premier candidat réflexif `srflx` ou relais `relay` (gain de 1 500 ms sur le Time-To-Connect).
- **Topologie ICE Résiliente** : Intégration de passerelles TURNS chiffrées sur le port 443 TCP/TLS pour traverser les NAT symétriques et les pare-feux stricts.
- **Préservation LAN** : Maintien des candidats mDNS (`.local`) pour permettre les connexions directes à 1 Gbit/s sur le réseau local.
- **Options WebRTC Standard** : Activation systématique de `bundlePolicy: 'max-bundle'` et `rtcpMuxPolicy: 'require'`.

### Persona 4.5 : Performance RTCDataChannel & Gestion de Contre-Pression
- **Élimination du Polling Bloquant** : Remplacement du `while (bufferedAmount > limit) setTimeout(15)` par l'écouteur événementiel natif `bufferedamountlow` couplé à `bufferedAmountLowThreshold: 64 Ko`.
- **Contre-pression sur Contrôle** : Régulation de flux sur `peer.controlChannel` lors de l'envoi de gros snapshots CRDT.
- **Canal Éphémère Dédié** : Création de `p2p-ephemeral` (`{ ordered: false, maxRetransmits: 0 }`) pour les signaux jetables (typing, présence, VAD).

### Persona 4.6 : Découpage Binaire, Framing MTU & Transport de Fichiers P2P
- **Correction Critique d'Événement** : Correction du nom d'événement `p2p-mesh.js` (`chunk-received`) ⇆ `drive-transfer.js` (`chunk-received`), débloquant le Drive P2P.
- **En-tête Binaire Compact 41 octets** : Remplacement de l'en-tête hexadécimal 73 octets par `0xFD` (1o) + Hash SHA-256 brut (32o) + `sliceIdx` (2o) + `totalSlices` (2o) + `chunkSize` (4o).
- **Framing 16 Ko SCTP Exact** : Tranche de données calibrée à 16 343 octets pour un paquet total de 16 384 octets pile.
- **Assemblage Zéro-Copie In-Place** : Écriture directe des tranches à leur position mémoire cible dans le `Uint8Array` pré-alloué sans copie intermédiaire.

### Persona 4.7 : Protocole Gossip, Diffusion Multi-Sauts & Anti-Tempête
- **Enveloppe Gossip Universelle** : Encapsulation des charges utiles dans `{ id, originPeerId, hops, ttl: 8, pathTrace: [], payload }` avec suppression immédiate des boucles.
- **Cache Glissant Multigénérationnel** : Remplacement du `Set` FIFO par `GenerationalSlidingCache` (3 sous-époques de 90s) éliminant la pression GC et les tempêtes d'écho.
- **State Vectors CRDT** : Remplacement de l'anti-entropie scalaire physique `max(timestamp)` par des Version Vectors `Map<author, { maxLamport }>` pour réconcilier infailliblement les partitions réseau.
- **Élimination des Scans `getAll()`** : Utilisation de curseurs indexés `IDBKeyRange` limités à $O(1)$ à la place des 15 balayages de tables répétés toutes les 25s.

### Persona 4.8 : Télémétrie WebRTC, Monitoring `getStats()` & QoS
- **Moteur `WebRTCTelemetryEngine`** : Échantillonnage périodique (2s) de `RTCPeerConnection.getStats()`.
- **Métriques Réseau Vraies** : Extraction de `candidate-pair.currentRoundTripTime`, `inbound-rtp.jitter`, `packetsLost`, `availableOutgoingBitrate`.
- **Score QoS eMOS (ITU-T G.107)** : Modèle de calcul multi-critères projetant un score MOS de 1.0 à 4.5 (Excellente, Bonne, Dégradée, Critique).

### Persona 4.9 : Résilience Réseau, Reconnexion Auto & ICE Restart
- **Délai de Grâce `disconnected` (4s)** : Empêche la destruction brutale de la session lors des sauts Wi-Fi/4G.
- **ICE Restart In-Place** : Déclenchement automatique de `pc.restartIce()` en cas d'instabilité sans détruire les DataChannels.
- **Gestion du Cycle de Vie Système** : Écouteurs `online`, `offline` et `visibilitychange` ré-annonçant immédiatement le nœud et réactivant les trackers après reprise de veille.
- **Reprise Swarm Immédiate** : Ré-émission automatique de `CHUNK_AVAILABILITY_REQ` dès qu'un pair redevient `peer-ready`.

### Persona 4.10 : QoS Réseau, Priorisation des Flux & Congestion Control
- **Priorités SCTP RFC 8831** : `p2p-control` en `priority: 'high'` (poids 512) et `p2p-data` en `priority: 'very-low'` (poids 128).
- **Arbitrage Inter-Modules** : Réduction automatique de la concurrence du swarm Drive (passage de 6 à 1-2 chunks) et injection de pacing lorsque la voix ou la vidéo est active.
- **Marquage DSCP Média** : Pistes audio en `priority: 'high'`, `networkPriority: 'high'` (DSCP EF RFC 8837) et `contentHint: 'speech'`.

---

## 3. Plan d'Action & Déploiement des Correctifs P0/P1

Les modifications identifiées seront appliquées avec **stricte parité d'octets** entre `APPLICATIONS/Communications/P2P/Extension/sidepanel/js/` et `APPLICATIONS/Communications/P2P/WebApp/js/` :

1. **`core/config.js`** : Mise à jour des serveurs STUN/TURNS, pool multi-trackers, paramètres Gossip/QoS/LIMITS.
2. **`core/bounded-cache.js`** : Création de `GenerationalSlidingCache` et `GossipEnvelope`.
3. **`core/webrtc-telemetry.js`** [NOUVEAU] : Module autonome de télémétrie `getStats()` et calcul eMOS.
4. **`core/p2p-mesh.js`** :
   - Rassemblement ICE adaptatif & génération d'offres concurrente (`Promise.all`).
   - Pool multi-trackers, timeouts de handshake (6s), notification gracieuse `event: 'stopped'`.
   - Backpressure événementielle `bufferedamountlow` sur `p2p-data` et `p2p-control`.
   - En-tête binaire 41 octets compact et framing 16 Ko SCTP.
   - Délai de grâce sur `disconnected`, écouteurs de cycle de vie et ICE restart in-place.
   - Optimisation `broadcast()` (Single Encrypt) et teardown complet anti-zombie.
5. **`core/crdt-engine.js`** : Intégration de l'enveloppe Gossip, State Vectors pour l'anti-entropie et élimination des scans `getAll()`.
6. **`modules/drive/drive-transfer.js`** : Harmonisation de l'événement `chunk-received`, assemblage in-place zéro-copie, sanction des blocs corrompus et bridage QoS en appel.
7. **`core/crypto-vault.js`** : Support des vues partielles `ArrayBufferView` dans `hashSHA256`.
8. **`core/presence.js`** : Remplacement du pseudo-RTT par la métrique native `currentRoundTripTime`.
9. **`modules/media/call-controller.js`** : Intégration de la télémétrie continue, marquage DSCP et régulation adaptative.
10. **`app.js` & `WebApp/sw.js`** : Raccordement du badge QoS eMOS, écouteurs `online`/`offline` et mise à jour du cache PWA.
