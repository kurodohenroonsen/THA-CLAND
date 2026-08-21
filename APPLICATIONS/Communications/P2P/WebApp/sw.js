/**
 * Service Worker PWA — P2P Mesh Workspace (Standards 2025/2026)
 * Stratégies de Cache Hybrides (SWR + Network-First), Mises à Jour Atomiques & Bypass Signalement WebRTC
 */

const CACHE_VERSION = 'v7';
const CACHE_PREFIX = 'pmesh-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

// Liste exhaustive des assets nécessaires au fonctionnement 100% hors-ligne (Pass 4 Hardened 2026)
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './permissions.html',
  './permissions.js',
  './js/platform-web.js',
  './js/app.js',
  './js/core/config.js',
  './js/core/logger.js',
  './js/core/sanitizer.js',
  './js/core/bounded-cache.js',
  './js/core/stream-compressor.js',
  './js/core/crypto-vault.js',
  './js/core/webrtc-telemetry.js',
  './js/core/crdt-engine.js',
  './js/core/p2p-mesh.js',
  './js/core/presence.js',
  './js/core/local-storage.js',
  './js/core/power-manager.js',
  './js/core/os-interop.js',
  './js/core/title-manager.js',
  './js/core/i18n.js',
  './js/core/a11y-announcer.js',
  './js/core/task-scheduler.js',
  './js/core/simd-vector-accelerator.js',
  './js/core/memory-leak-detector.js',
  './js/core/binary-buffer-pool.js',
  './js/core/lazy-module-loader.js',
  './js/core/schema-migration.js',
  './js/core/did-codec.js',
  './js/core/did-resolver.js',
  './js/core/verifiable-credentials.js',
  './js/core/wire-codec.js',
  './js/core/sender-keys.js',
  './js/core/trust-engine.js',
  './js/core/equivocation-engine.js',
  './js/core/hybrid-gossip-engine.js',
  './js/core/ice-manager.js',
  './js/core/binary-frame-router.js',
  './js/core/secure-signaling-e2ee.js',
  './js/core/datachannel-flow-controller.js',
  './js/modules/auth/auth-controller.js',
  './js/modules/chat/chat-controller.js',
  './js/modules/chat/forum-controller.js',
  './js/modules/drive/drive-controller.js',
  './js/modules/drive/drive-transfer.js',
  './js/modules/drive/file-chunker.js',
  './js/modules/drive/merkle-tree.js',
  './js/modules/drive/versioning-dag.js',
  './js/modules/drive/fast-cdc.js',
  './js/modules/drive/sequential-streamer.js',
  './js/modules/drive/media-source-streamer.js',
  './js/modules/drive/safe-thumbnail.js',
  './js/modules/drive/vfs-engine.js',
  './js/modules/media/call-controller.js',
  './js/modules/media/media-stream.js',
  './js/modules/media/audio-processor.js',
  './js/modules/media/audio-visualizer.js',
  './js/modules/media/vad-worklet-processor.js',
  './js/modules/media/spatial-audio.js',
  './js/ui/modal.js',
  './js/ui/toast.js',
  './js/ui/visualizer.js',
  './js/ui/virtual-list-renderer.js',
  './locales/fr.json',
  './locales/en.json',
  './css/variables.css',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/chat.css',
  './css/drive.css',
  './css/media.css',
  './css/enhancements.css',
  './css/mobile.css',
  './icons/icon-16.png',
  './icons/icon-32.png',
  './icons/icon-48.png',
  './icons/icon-128.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png'
];

// 1. INSTALLATION : Pré-cache résilient SANS skipWaiting automatique (protège les sessions actives)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of PRECACHE_ASSETS) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn(`[SW] Échec du pré-cache pour ${asset}:`, err);
        }
      }
    })
  );
});

// 2. ACTIVATION : Invalidation & Purge Atomique des anciens caches du namespace
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
          .map((k) => {
            console.log(`[SW] Purge atomique ancien cache : ${k}`);
            return caches.delete(k);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. MESSAGE : Bascule vers la nouvelle version à la demande de l'utilisateur
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Réception SKIP_WAITING : bascule vers la nouvelle version...');
    self.skipWaiting();
  }
});

// 4. FETCH : Routage & Stratégies Hybrides
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // A. NETWORK ONLY / BYPASS STRICT :
  // - WebSocket & WebRTC (ws:, wss:)
  // - Protocoles non-HTTP (chrome-extension:, blob:, data:)
  // - Requêtes partielles / Range (streaming média Drive pour éviter TypeError 206)
  // - Domaines distants (Trackers WebTorrent, Relais Nostr, serveurs STUN/TURNS)
  if (
    url.protocol === 'ws:' ||
    url.protocol === 'wss:' ||
    url.protocol === 'chrome-extension:' ||
    url.protocol === 'blob:' ||
    url.protocol === 'data:' ||
    req.headers.has('range') ||
    url.origin !== self.location.origin ||
    url.pathname.includes('/announce') ||
    url.pathname.includes('/api/') ||
    url.searchParams.has('info_hash')
  ) {
    return; // Bypass SW direct vers la pile réseau native
  }

  // B. NAVIGATION (HTML Shell) : Network-First avec repli Cache (Offline)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkRes;
        })
        .catch(() => {
          return caches.match('./index.html') || caches.match(req);
        })
    );
    return;
  }

  // C. ASSETS LOCAUX (JS, CSS, Images, Polices) : Stale-While-Revalidate (SWR)
  event.respondWith(
    caches.match(req).then((cachedRes) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
            const copy = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkRes;
        })
        .catch(() => cachedRes);

      return cachedRes || fetchPromise;
    })
  );
});
