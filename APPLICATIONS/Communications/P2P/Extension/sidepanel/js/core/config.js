/**
 * Configuration Centrale - P2P Mesh Workspace (2025/2026)
 * Définition des serveurs STUN/TURNS indépendants, Trackers WebTorrent, Relais Nostr et constantes de résilience.
 */

export const CONFIG = {
  APP_NAME: 'P2P Mesh Workspace',
  APP_VERSION: '1.3.0',

  // Paramètres d'anonymat et de confidentialité réseau
  PRIVACY: {
    FORCE_RELAY_ONLY: false,         // Si true : force le transit exclusif par serveurs TURN
    STRIP_HOST_CANDIDATES: false,    // Conserve les candidats mDNS LAN pour transferts locaux ultra-rapides
    SDP_PADDING_BLOCK_SIZE: 2048,    // Rembourrage constant des paquets de signalement
    HEARTBEAT_JITTER_MS: 1500        // Dispersion aléatoire sur le heartbeat (anti-traffic analysis)
  },
  
  // Serveurs STUN/TURNS Publics indépendants et neutres pour la traversée NAT (2025/2026)
  ICE_SERVERS: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.cloudflare.com:53' },
    { urls: 'stun:stun.nextcloud.com:443' },
    {
      urls: [
        'turns:openrelay.metered.ca:443?transport=tcp',
        'turn:openrelay.metered.ca:80?transport=tcp',
        'turn:openrelay.metered.ca:443'
      ],
      username: 'openrelay',
      credential: 'openrelay'
    }
  ],

  // Pool Multi-Trackers WebTorrent Publics opérationnels (WebSockets WSS)
  TRACKERS: [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.files.fm:7073/announce',
    'wss://tracker.novage.com.ua'
  ],

  // Relais Nostr Publics haute disponibilité pour le signalement résilient (NIP-01, NIP-40, Kind 29000)
  NOSTR: {
    ENABLED: true,
    RELAYS: [
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://relay.nostr.band',
      'wss://nos.lol'
    ],
    KIND_SIGNALING: 29000,           // Kind éphémère NIP-16/NIP-01
    KIND_SIGNALING_ASYNC: 29001,     // Kind court-terme avec NIP-40
    TTL_SECONDS: 60,                 // Expiration NIP-40 (60s)
    BACKOFF: {
      INITIAL_DELAY_MS: 1000,
      MAX_DELAY_MS: 30000,
      FACTOR: 1.5,
      JITTER_RATIO: 0.3              // 30% de dispersion aléatoire
    }
  },

  // Rétro-compatibilité Nostr simple
  NOSTR_RELAYS: [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://relay.nostr.band',
    'wss://nos.lol'
  ],

  // Paramètres du Drive & Swarm Transfer
  DRIVE: {
    CHUNK_SIZE: 512 * 1024,                      // 512 Ko par bloc
    MAX_FILE_SIZE: 8 * 1024 * 1024 * 1024,        // 8 Go
    SWARM_MAX_PARALLEL_CHUNKS: 6,                 // Nombre max de requêtes de blocs en vol
    CHUNK_REQUEST_TIMEOUT: 8000,                  // Délai avant de re-planifier un bloc (8s)
    BUFFERED_AMOUNT_LOW_THRESHOLD: 64 * 1024,     // 64 Ko seuil de réveil événementiel
    BUFFERED_AMOUNT_HIGH_WATERMARK: 256 * 1024,   // 256 Ko seuil de suspension de flux
    RATE_LIMIT_WITH_MEDIA_BPS: 250 * 1024,        // 250 Ko/s max pendant les appels visio
    QOS_CALL_PARALLEL_CHUNKS: 1                   // 1 bloc max en vol pendant un appel vocal/vidéo
  },

  // Limites de sécurité et maillage
  LIMITS: {
    MAX_ACTIVE_PEERS: 8,                          // Taille cible maximale du maillage actif
    MAX_DATACHANNEL_CHUNK: 15000,                 // < 16 Ko : limite sûre RTCDataChannel
    MAX_FRAGMENT_PARTS: 20000,                    // Nombre max de fragments d'un message de contrôle
    MAX_ASSEMBLED_CONTROL_BYTES: 32 * 1024 * 1024,// Taille max d'un message réassemblé (32 Mo)
    MAX_BINARY_CHUNK_BYTES: 2 * 1024 * 1024,      // Taille max d'un bloc binaire annoncé (2 Mo)
    MAX_BINARY_SLICES: 512                        // Nombre max de tranches par bloc binaire
  },

  // Configuration des Codecs et Médias WebRTC 2025/2026 (Personas 5.4 & 5.9)
  MEDIA: {
    AUDIO: {
      OPUS_FMTP: 'minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxplaybackrate=48000;maxaveragebitrate=32000;cbr=0',
      MAX_BITRATE: 32000,
      SAMPLE_RATE: 48000
    },
    VIDEO: {
      PREFERRED_CODECS: ['video/VP9', 'video/H264', 'video/VP8', 'video/AV1'],
      H264_PROFILE_LEVEL: '42e01f;packetization-mode=1'
    },
    DEFAULT_JITTER_TARGET_MS: 50
  },

  // Adaptation multidimensionnelle vidéo selon latence RTT et pertes RTP (Personas 5.4 & 4.10)
  VIDEO_BITRATE: {
    TOTAL_UPLINK_CAP_BPS: 3500000, // Plafond upload global partagé entre les N-1 pairs (3.5 Mbps)
    LADDER: [
      { maxRtt: 80,  maxBitrate: 2200000, scaleResolutionDownBy: 1.0, maxFramerate: 30 },
      { maxRtt: 160, maxBitrate: 1100000, scaleResolutionDownBy: 1.0, maxFramerate: 25 },
      { maxRtt: 260, maxBitrate: 550000,  scaleResolutionDownBy: 1.5, maxFramerate: 20 },
      { maxRtt: 400, maxBitrate: 300000,  scaleResolutionDownBy: 2.0, maxFramerate: 15 },
      { maxRtt: Infinity, maxBitrate: 160000, scaleResolutionDownBy: 3.0, maxFramerate: 12 }
    ],
    SCREEN_SHARE: {
      maxBitrate: 1800000,
      scaleResolutionDownBy: 1.0,
      maxFramerate: 15,
      degradationPreference: 'maintain-resolution'
    },
    ADAPT_INTERVAL: 2000
  },

  // Intervalles de temps (en millisecondes)
  TIMINGS: {
    HEARTBEAT_INTERVAL: 5000,
    PEER_TIMEOUT: 20000,
    TRACKER_CONNECT_TIMEOUT: 6000,        // Timeout handshake WebSocket tracker
    RECONNECT_DELAY: 5000,
    MAX_RECONNECT_DELAY: 60000,
    DEFAULT_ANNOUNCE_INTERVAL: 30000,     // Annonce standard par défaut (30s)
    ICE_DISCONNECT_GRACE_MS: 4000,        // 4s de grâce avant de considérer un pair perdu
    OFFER_TTL: 45000,
    VAD_INTERVAL: 200
  },

  // Canaux de chat par défaut créés à l'initialisation du groupe
  DEFAULT_CHANNELS: [
    { id: 'general', name: 'Général', description: 'Discussions générales du groupe' },
    { id: 'projets', name: 'Projets & Tâches', description: 'Coordination et suivi des travaux' },
    { id: 'annonces', name: 'Annonces', description: 'Informations importantes et synthèses' }
  ],

  // Catégories du Forum par défaut
  DEFAULT_FORUM_CATEGORIES: [
    'Général',
    'Architecture',
    'Développement',
    'Idées & Brainstorming',
    'Support & Questions'
  ]
};
