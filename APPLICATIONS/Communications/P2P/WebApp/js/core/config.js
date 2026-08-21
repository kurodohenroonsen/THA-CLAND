/**
 * Configuration Centrale - P2P Mesh Workspace (2025/2026)
 * STUN/TURNS souverains, Trackers WebTorrent, Relais Nostr, constantes ICE & Topologie.
 */

export const CONFIG = {
  APP_NAME: 'P2P Mesh Workspace',
  APP_VERSION: '1.4.0',

  PRIVACY: {
    FORCE_RELAY_ONLY: false,
    STRIP_HOST_CANDIDATES: false,
    SDP_PADDING_BLOCK_SIZE: 2048,
    HEARTBEAT_JITTER_MS: 600
  },
  
  // Serveurs STUN/TURNS souverains et publics haute disponibilité (2025/2026)
  ICE_SERVERS: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.cloudflare.com:53' },
    { urls: 'stun:stun.nextcloud.com:443' },
    { urls: 'stun:stun.matrix.org:3478' },
    {
      urls: [
        'turns:openrelay.metered.ca:443?transport=tcp',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turn:openrelay.metered.ca:80?transport=tcp',
        'turn:openrelay.metered.ca:443'
      ],
      username: 'openrelay',
      credential: 'openrelay'
    }
  ],

  ICE_CONFIG: {
    CANDIDATE_POOL_SIZE: 2,
    FAST_LAN_GATHER_TIMEOUT_MS: 120,
    MAX_GATHER_TIMEOUT_MS: 1800,
    TRICKLE_ENABLED: true
  },

  TOPOLOGY: {
    MIN_PEERS: 3,
    MAX_PEERS: 6,
    TARGET_PEERS: 4,
    MAX_PASSIVE_PEERS: 32,
    TUNE_INTERVAL_MS: 8000,
    SHUFFLE_INTERVAL_MS: 25000
  },

  TRACKERS: [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.files.fm:7073/announce',
    'wss://tracker.novage.com.ua'
  ],

  NOSTR: {
    ENABLED: true,
    RELAYS: [
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://relay.nostr.band',
      'wss://nos.lol'
    ],
    KIND_SIGNALING: 29000,
    KIND_SIGNALING_ASYNC: 29001,
    TTL_SECONDS: 60,
    BACKOFF: {
      INITIAL_DELAY_MS: 1000,
      MAX_DELAY_MS: 30000,
      FACTOR: 1.5,
      JITTER_RATIO: 0.3
    }
  },

  TIMINGS: {
    HEARTBEAT_INTERVAL: 2500,
    PEER_TIMEOUT: 15000,
    FAST_PROBE_TIMEOUT: 600,
    TRACKER_CONNECT_TIMEOUT: 5000,
    RECONNECT_DELAY: 1500,
    MAX_RECONNECT_DELAY: 30000,
    DEFAULT_ANNOUNCE_INTERVAL: 25000,
    ICE_DISCONNECT_GRACE_MS: 2000,
    OFFER_TTL: 30000,
    VAD_INTERVAL: 200
  },

  LIMITS: {
    MAX_ACTIVE_PEERS: 8,
    MAX_DATACHANNEL_CHUNK: 15000,
    MAX_FRAGMENT_PARTS: 20000,
    MAX_ASSEMBLED_CONTROL_BYTES: 32 * 1024 * 1024,
    MAX_BINARY_CHUNK_BYTES: 2 * 1024 * 1024,
    MAX_BINARY_SLICES: 512
  },

  DRIVE: {
    CDC_MIN_SIZE: 32 * 1024,
    CHUNK_SIZE: 128 * 1024,
    CDC_MAX_SIZE: 512 * 1024,
    CHUNKING_ALGO: 'fastcdc'
  },

  MEDIA: {
    DEFAULT_JITTER_TARGET_MS: 50,
    AUDIO: {
      STEREO: 1,
      SPROP_STEREO: 1,
      USE_INBAND_FEC: 1,
      USE_DTX: 1,
      MAX_BITRATE: 128000,
      MIN_BITRATE: 48000,
      SAMPLE_RATE: 48000
    },
    VIDEO: {
      PREFERRED_CODECS: ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'],
      MAX_BITRATE_DEFAULT: 2000000,
      MIN_BITRATE_CONGESTION: 180000,
      SCREEN_SHARE_BITRATE: 3000000
    }
  },

  VIDEO_BITRATE: {
    ADAPT_INTERVAL: 2000,
    MAX_BITRATE: 2500000,
    MIN_BITRATE: 150000
  }
};

