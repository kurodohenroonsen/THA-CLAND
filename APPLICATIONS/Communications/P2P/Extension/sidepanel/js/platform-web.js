/**
 * Amorçage plateforme WEB & Cycle de Vie PWA (2025/2026)
 * - Shim window.chrome universel pour compatibilité totale avec l'extension
 * - Enregistrement Service Worker PWA avec détection de mises à jour atomiques
 * - App Badging API (navigator.setAppBadge / clearAppBadge)
 */
(function () {
  'use strict';

  // Si on tourne réellement dans une extension Chrome, ne rien faire.
  if (typeof window.chrome !== 'undefined' && window.chrome.runtime && window.chrome.runtime.id) {
    return;
  }

  var ICON = 'icons/icon-128.png';

  function showWebNotification(title, body) {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      if (document.visibilityState === 'visible') return;
      var n = new Notification(title || 'P2P Mesh', {
        body: body || '',
        icon: ICON,
        badge: ICON,
        tag: 'p2p_notification',
        renotify: true
      });
      n.onclick = function () { try { window.focus(); n.close(); } catch (e) {} };
    } catch (e) { /* silencieux */ }
  }

  function syncAppBadge(count) {
    if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
      try {
        if (count && count > 0) {
          navigator.setAppBadge(count).catch(function () {});
        } else {
          navigator.clearAppBadge().catch(function () {});
        }
      } catch (e) {}
    }
  }

  // Routeur de messages : reproduit le comportement du SW côté web
  function routeRuntimeMessage(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'SHOW_NOTIFICATION':
        showWebNotification(message.title, message.body);
        break;
      case 'UPDATE_UNREAD_BADGE':
        syncAppBadge(message.unreadCount);
        break;
      case 'UPDATE_PEERS_COUNT':
      case 'INIT_OFFSCREEN':
      case 'CLOSE_OFFSCREEN':
      case 'KEEP_AWAKE_ACQUIRE':
      case 'KEEP_AWAKE_RELEASE':
      case 'PING':
      default:
        break;
    }
  }

  var noop = function () {};

  window.chrome = {
    runtime: {
      id: undefined, // Marqueur : pas une vraie extension
      sendMessage: function (message) {
        try { routeRuntimeMessage(message); } catch (e) {}
        return Promise.resolve({ received: true });
      },
      onMessage: { addListener: noop, removeListener: noop },
      getURL: function (path) { return path; },
      getContexts: function () { return Promise.resolve([]); }
    },
    tabs: {
      create: function (opts) {
        try {
          var url = (opts && typeof opts.url === 'string') ? opts.url : '';
          if (/^https?:\/\//i.test(url)) {
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        } catch (e) {}
      }
    },
    action: {
      setBadgeText: function (o) {
        if (o && typeof o.text !== 'undefined') {
          var n = parseInt(o.text, 10);
          syncAppBadge(isNaN(n) ? 0 : n);
        }
      },
      setBadgeBackgroundColor: noop,
      setBadgeTextColor: noop,
      setTitle: noop
    },
    notifications: {
      create: function (idOrOpts, maybeOpts) {
        var o = maybeOpts || idOrOpts || {};
        showWebNotification(o.title, o.message || o.body);
      }
    },
    offscreen: {
      createDocument: function () { return Promise.resolve(); },
      closeDocument: function () { return Promise.resolve(); }
    },
    sidePanel: {
      setPanelBehavior: function () { return Promise.resolve(); }
    },
    permissions: {
      request: function () { return Promise.resolve(true); },
      remove: function () { return Promise.resolve(true); }
    }
  };

  function deepFreeze(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    Object.keys(obj).forEach(function (prop) {
      if (obj[prop] && typeof obj[prop] === 'object') deepFreeze(obj[prop]);
    });
    return Object.freeze(obj);
  }
  deepFreeze(window.chrome);

  // --- CYCLE DE VIE PWA & MISES À JOUR ATOMIQUES (Standards 2026) ---
  function initPWALifecycle() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js', { scope: './' })
        .then(function (reg) {
          console.log('[PWA] Service Worker actif, portée :', reg.scope);

          // 1. Détection de worker en attente au chargement
          if (reg.waiting) {
            promptUpdateAvailable(reg.waiting);
          }

          // 2. Détection d'une nouvelle version en cours d'installation
          reg.addEventListener('updatefound', function () {
            var newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', function () {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                promptUpdateAvailable(newWorker);
              }
            });
          });

          // 3. Polling périodique de mise à jour (toutes les 60 minutes)
          setInterval(function () {
            reg.update().catch(noop);
          }, 3600000);

          // 4. Vérification à chaque retour au premier plan
          document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
              reg.update().catch(noop);
            }
          });
        })
        .catch(function (err) {
          console.warn('[PWA] Échec enregistrement SW :', err);
        });

      // 5. Rechargement propre lors de la bascule de contrôleur (SKIP_WAITING)
      var isRefreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (isRefreshing) return;
        isRefreshing = true;
        console.log('[PWA] Nouveau contrôleur actif. Rechargement...');
        window.location.reload();
      });
    });
  }

  function promptUpdateAvailable(worker) {
    if (document.getElementById('pwa-update-toast')) return;

    var toast = document.createElement('div');
    toast.id = 'pwa-update-toast';
    toast.setAttribute('role', 'alert');
    toast.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;background:#161b26;border:1px solid #06b6d4;color:#ffffff;padding:12px 16px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);display:flex;align-items:center;gap:12px;font-size:13px;';

    toast.innerHTML = [
      '<span>🚀 <strong>Nouvelle version disponible</strong></span>',
      '<button id="btn-pwa-refresh" style="background:#06b6d4;color:#000;border:none;padding:6px 12px;border-radius:4px;font-weight:600;cursor:pointer;">Rafraîchir</button>',
      '<button id="btn-pwa-close" style="background:transparent;color:#888;border:none;cursor:pointer;font-size:14px;">✕</button>'
    ].join('');

    document.body.appendChild(toast);

    document.getElementById('btn-pwa-refresh').onclick = function () {
      toast.remove();
      worker.postMessage({ type: 'SKIP_WAITING' });
    };

    document.getElementById('btn-pwa-close').onclick = function () {
      toast.remove();
    };
  }

  initPWALifecycle();
  console.log('[Platform] Shim web & Cycle de vie PWA initialisés.');
})();
