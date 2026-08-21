/**
 * Configuration Centrale - P2P Mesh Workspace
 * Définition des serveurs STUN publics, Trackers WebTorrent, Relais Nostr et constantes du protocole.
 */

export const CONFIG = {
  APP_NAME: 'P2P Mesh Workspace',
  APP_VERSION: '1.0.0',
  
  // Serveurs STUN Publics mondiaux pour la traversée NAT
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ],

  // Trackers WebTorrent Publics opérationnels (WebSockets WSS)
  TRACKERS: [
    'wss://tracker.openwebtorrent.com'
  ],

  // Relais Nostr Publics haute disponibilité pour le signalement résilient
  NOSTR_RELAYS: [
    'wss://relay.damus.io',
    'wss://relay.primal.net'
  ],

  // Paramètres du Drive & Chunking
  DRIVE: {
    CHUNK_SIZE: 512 * 1024, // 512 Ko par bloc
    MAX_FILE_SIZE: 8 * 1024 * 1024 * 1024, // 8 Go (OPFS + assemblage en flux, cf. audit >1 Go)
    SWARM_MAX_PARALLEL_CHUNKS: 6, // Nombre de requêtes de blocs en vol simultanément
    CHUNK_REQUEST_TIMEOUT: 12000, // Délai avant de re-planifier un bloc auprès d'un autre pair
    BUFFERED_AMOUNT_LOW_THRESHOLD: 1024 * 1024 // 1 Mo seuil de contre-pression
  },

  // Limites de sécurité (bornage anti-DoS)
  LIMITS: {
    MAX_DATACHANNEL_CHUNK: 15000,          // < 16 Ko : limite sûre RTCDataChannel
    MAX_FRAGMENT_PARTS: 20000,             // Nombre max de fragments d'un message de contrôle
    MAX_ASSEMBLED_CONTROL_BYTES: 32 * 1024 * 1024, // Taille max d'un message de contrôle réassemblé (32 Mo)
    MAX_BINARY_CHUNK_BYTES: 2 * 1024 * 1024,       // Taille max d'un bloc binaire annoncé (2 Mo > CHUNK_SIZE)
    MAX_BINARY_SLICES: 512                  // Nombre max de tranches par bloc binaire
  },

  // Adaptation dynamique du bitrate vidéo selon la latence RTT mesurée
  VIDEO_BITRATE: {
    // paliers [RTT max en ms, bitrate cible en bps]
    LADDER: [
      [80, 2500000],   // RTT < 80 ms  -> 2.5 Mbps (HD)
      [160, 1200000],  // RTT < 160 ms -> 1.2 Mbps
      [280, 600000],   // RTT < 280 ms -> 600 kbps
      [Infinity, 300000] // au-delà     -> 300 kbps (préserve la fluidité)
    ],
    ADAPT_INTERVAL: 4000 // Réévaluation toutes les 4s
  },

  // Intervalles de temps (en millisecondes)
  TIMINGS: {
    HEARTBEAT_INTERVAL: 5000,   // Ping toutes les 5s
    PEER_TIMEOUT: 15000,        // Déconnexion d'un pair après 15s sans signe de vie
    RECONNECT_DELAY: 5000,      // Tentative de reconnexion tracker après 5s
    OFFER_TTL: 45000,           // Durée de vie d'une offre SDP non répondue avant purge
    VAD_INTERVAL: 100           // Détection vocale toutes les 100ms
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
