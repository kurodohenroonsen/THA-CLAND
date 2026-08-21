# Spécifications Techniques des Protocoles P2P & Formats de Trames

Ce document définit les protocoles de communication, le format binaire et JSON des trames transitant sur les canaux WebRTC (`RTCDataChannel`), ainsi que les mécanismes de synchronisation et de contrôle de flux.

---

## 1. Topologie Réseau & Canaux WebRTC

Chaque connexion entre deux pairs (`RTCPeerConnection`) initialise deux `RTCDataChannel` distincts :
1. **Canal de Contrôle & Messages (`p2p-control`)** :
   - `ordered: true`, `maxRetransmits: null` (garantie de livraison et ordre strict).
   - Utilisé pour le Heartbeat, la négociation CRDT, les messages de chat, les sujets de forum et les métadonnées de commits.
2. **Canal de Fichiers & Blocs (`p2p-data`)** :
   - `ordered: false`, `binaryType: "arraybuffer"`.
   - Utilisé pour le streaming haute vitesse des blocs de fichiers (Chunks SHA-256).

---

## 2. Format des Messages sur le Canal de Contrôle (`p2p-control`)

Tous les messages textuels sont sérialisés en JSON et encapsulés dans une enveloppe standardisée :

```json
{
  "type": "MESSAGE_TYPE",
  "senderId": "peer_a1b2c3d4",
  "timestamp": 1787224000000,
  "payload": { ... }
}
```

### 2.1 Types de Messages Pris en Charge

| Type | Rôle | Payload |
| :--- | :--- | :--- |
| `PING` | Battement de cœur (Liveness & RTT) | `{ "t": 1787224000123 }` |
| `PONG` | Réponse au battement de cœur | `{ "t": 1787224000123, "replyAt": 1787224000140 }` |
| `PEER_HELLO` | Présentation d'un nouveau membre | `{ "name": "Alice", "avatar": "data:image...", "pubkey": "..." }` |
| `CRDT_STATE_VECTOR` | Résumé des versions locales | `{ "vector": { "peer_1": 14, "peer_2": 8 } }` |
| `CRDT_UPDATE_DELTA` | Différentiel de messages manqués | `{ "updates": [ ... ] }` |
| `CHAT_BROADCAST` | Message de chat instantané | `{ "id": "...", "channel": "general", "content": "...", "lamport": 5 }` |
| `FORUM_POST` | Nouveau fil ou réponse | `{ "thread": { ... } }` |
| `DRIVE_COMMIT` | Nouveau commit de fichier | `{ "commit": { ... } }` |
| `CHUNK_REQUEST` | Demande d'un bloc de fichier | `{ "fileId": "...", "chunkHash": "...", "chunkIndex": 0 }` |
| `CHUNK_AVAILABLE` | Notification de possession d'un bloc | `{ "fileId": "...", "availableChunks": [0, 1, 2] }` |
| `MEDIA_SIGNAL` | Notification d'orateur / statut média | `{ "isAudioActive": true, "isVideoActive": false, "isScreenSharing": false }` |

---

## 3. Protocole de Transfert de Fichiers Swarm (`p2p-data`)

### 3.1 Découpage des Fichiers (Chunking)
- **Taille Standard de Chunk** : $524\,288$ octets ($512\text{ Ko}$).
- Le dernier chunk a une taille résiduelle $\le 512\text{ Ko}$.
- Chaque chunk $C_i$ est haché via `SHA-256` : $H_i = \text{SHA-256}(C_i)$.
- La racine Merkle $R$ est calculée par agrégation binaire de la liste $[H_0, H_1, \dots, H_{n-1}]$.

### 3.2 Structure d'un Paquet Binaire de Chunk
Chaque chunk envoyé sur le canal `p2p-data` est préfixé d'un en-tête binaire de 36 octets :

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      MAGIC (4 octets: 'P2PC')                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Chunk Index (4 octets - uint32 BE)       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                 File ID Hash (20 octets SHA-1 / Prefix)       |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   Payload Length (4 octets - uint32 BE)       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      CRC32 Checksum (4 octets)                |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  Données Brutes du Chunk (N octets)           |
|                                ...                            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### 3.3 Contrôle de Contre-Pression (Backpressure Control)
Pour éviter de saturer la mémoire du navigateur lors de l'envoi de gros fichiers :
```javascript
dataChannel.bufferedAmountLowThreshold = 1024 * 1024; // Seuil de 1 Mo

async function sendChunkWithBackpressure(dataChannel, buffer) {
  if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) {
    await new Promise((resolve) => {
      dataChannel.onbufferedamountlow = () => {
        dataChannel.onbufferedamountlow = null;
        resolve();
      };
    });
  }
  dataChannel.send(buffer);
}
```

---

## 4. Algorithme CRDT & Réplication sans Conflit

Pour garantir la convergence de l'état sans serveur central :
1. **Horloge de Lamport** :
   Chaque membre incrémente son compteur logique local $L$ lors de la création d'un événement :
   $$L_{\text{local}} = \max(L_{\text{local}}, L_{\text{reçu}}) + 1$$
2. **Ordre Total Déterministe** :
   Un événement $E_1$ précède $E_2$ si :
   $$(L(E_1) < L(E_2)) \quad \lor \quad (L(E_1) == L(E_2) \land \text{AuthorPubkey}(E_1) < \text{AuthorPubkey}(E_2))$$
3. **Résolution des Conflits de Versioning (Last-Write-Wins avec DAG Pointers)** :
   Si deux commits ont le même parent $P$, un embranchement (branch) est créé et visualisé dans l'historique du drive, permettant la fusion manuelle ou le choix de la branche active.

---

## 5. Salons Audio / Vidéo WebRTC Mesh & Négociation

### 5.1 Configuration WebRTC
```javascript
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ],
  iceCandidatePoolSize: 4
};
```

### 5.2 Négociation Dynamique des Pistes
- Dès qu'un pair rejoint le salon audio ou active sa caméra :
  1. `peerConnection.addTrack(track, localMediaStream)`
  2. L'événement `negotiationneeded` déclenche la création d'une nouvelle offre SDP chiffrée.
  3. L'offre est transmise via le canal de contrôle P2P déjà ouvert ou via le relais de signalement.
