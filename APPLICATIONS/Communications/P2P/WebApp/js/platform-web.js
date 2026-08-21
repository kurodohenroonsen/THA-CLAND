/**
 * Amorçage plateforme WEB — P2P Mesh (version hébergée statique / PWA)
 *
 * Le code applicatif est partagé avec l'extension Chrome et appelle par endroits
 * l'API `chrome.*` (notifications, badge d'icône, document offscreen, onglet de
 * permissions). Dans un navigateur web classique, `chrome.runtime` n'existe pas.
 *
 * Ce shim fournit un `window.chrome` minimal qui traduit ces appels vers des API
 * web standard, de sorte qu'AUCUN fichier de logique n'a besoin d'être modifié.
 *
 * Doit être chargé en <script> classique dans le <head>, AVANT les modules ES.
 */
(function () {
  'use strict';

  // Si on tourne réellement dans une extension, ne rien faire.
  if (typeof window.chrome !== 'undefined' && window.chrome.runtime && window.chrome.runtime.id) {
    return;
  }

  var ICON = 'icons/icon-128.png';

  function showWebNotification(title, body) {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      if (document.visibilityState === 'visible') return; // pas de doublon si l'app est au premier plan
      var n = new Notification(title || 'P2P Mesh', { body: body || '', icon: ICON, badge: ICON });
      n.onclick = function () { try { window.focus(); n.close(); } catch (e) {} };
    } catch (e) { /* silencieux */ }
  }

  function updateTabBadge(count) {
    var base = 'P2P Mesh';
    document.title = (count && count > 0) ? '(' + count + ') ' + base : base;
  }

  // Routeur de messages : reproduit ce que faisait le service worker de l'extension.
  function routeRuntimeMessage(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'SHOW_NOTIFICATION':
        showWebNotification(message.title, message.body);
        break;
      case 'UPDATE_BADGE':
        updateTabBadge(message.peersCount);
        break;
      case 'INIT_OFFSCREEN':
      case 'PING':
      default:
        // Sans objet en contexte web (pas de document offscreen) — ignoré.
        break;
    }
  }

  var noop = function () {};

  window.chrome = {
    runtime: {
      id: undefined, // marqueur : pas une vraie extension
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
          updateTabBadge(isNaN(n) ? 0 : n);
        }
      },
      setBadgeBackgroundColor: noop
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

  console.log('[Platform] Shim web actif — API chrome.* traduites vers les API navigateur.');
})();
