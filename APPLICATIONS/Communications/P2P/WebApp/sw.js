/**
 * Service Worker — P2P Mesh (PWA statique)
 *
 * Rôle : rendre l'app installable et disponible hors-ligne (coquille applicative).
 * Il ne touche JAMAIS au trafic P2P : WebRTC et les WebSockets (trackers / relais
 * Nostr) ne passent pas par le Service Worker. On ne met en cache que les fichiers
 * statiques de MÊME ORIGINE, servis en GET.
 *
 * Stratégies :
 *  - Navigations (HTML)      → réseau d'abord, repli sur index.html en cache (hors-ligne)
 *  - Ressources statiques    → stale-while-revalidate (rapide + mise à jour en tâche de fond)
 */

const CACHE_VERSION = 'p2p-mesh-v1';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './permissions.html',
  './permissions.js',
  './js/platform-web.js',
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
  './icons/icon-128.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // On ignore tout ce qui n'est pas de notre origine (trackers, relais, CDNs…).
  if (url.origin !== self.location.origin) return;

  // Navigation HTML : réseau d'abord, repli hors-ligne sur index.html.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Ressources statiques : stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
