/**
 * Service Worker PWA — P2P Mesh Workspace
 * Cache complet pour fonctionnement 100% hors-ligne & modules ES6
 */

const CACHE_NAME = 'pmesh-pwa-v2';

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
  './js/core/bounded-cache.js',
  './js/core/stream-compressor.js',
  './js/core/crypto-vault.js',
  './js/core/crdt-engine.js',
  './js/core/p2p-mesh.js',
  './js/core/presence.js',
  './js/core/local-storage.js',
  './js/modules/auth/auth-controller.js',
  './js/modules/chat/chat-controller.js',
  './js/modules/chat/forum-controller.js',
  './js/modules/drive/drive-controller.js',
  './js/modules/drive/drive-transfer.js',
  './js/modules/drive/file-chunker.js',
  './js/modules/drive/merkle-tree.js',
  './js/modules/drive/versioning-dag.js',
  './js/modules/media/call-controller.js',
  './js/modules/media/media-stream.js',
  './js/modules/media/audio-processor.js',
  './js/modules/media/audio-visualizer.js',
  './js/ui/modal.js',
  './js/ui/toast.js',
  './js/ui/visualizer.js',
  './css/variables.css',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/chat.css',
  './css/drive.css',
  './css/media.css',
  './css/enhancements.css',
  './css/mobile.css',
  './icons/icon-32.png',
  './icons/icon-48.png',
  './icons/icon-128.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Pré-cache partiel:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((networkRes) => {
        if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkRes;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
