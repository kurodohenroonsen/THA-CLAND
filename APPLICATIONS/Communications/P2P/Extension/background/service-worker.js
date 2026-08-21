/**
 * Service Worker Manifest V3 - P2P Mesh Workspace
 * Gère le cycle de vie de l'extension, l'ouverture du Side Panel,
 * le cycle de vie du document Offscreen et le pontage des notifications.
 */

// Configuration du comportement du Side Panel au clic sur l'icône de l'action
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[SW] Erreur setPanelBehavior:', error));

// Gestionnaire d'installation et de démarrage
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[SW] Extension P2P Mesh installée/mise à jour:', details.reason);
  chrome.action.setBadgeText({ text: 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
});

// État du document Offscreen
let creatingOffscreenPromise = null;

/**
 * Assure l'existence du document Offscreen pour les opérations WebRTC/Audio d'arrière-plan
 */
async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) {
    return; // Le document existe déjà
  }

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: offscreenUrl,
    reasons: ['AUDIO_PLAYBACK', 'USER_MEDIA', 'WEB_RTC'],
    justification: 'Maintien de la connexion WebRTC P2P et lecture des flux audio de groupe en tâche de fond'
  });

  await creatingOffscreenPromise;
  creatingOffscreenPromise = null;
  console.log('[SW] Document Offscreen initialisé avec succès.');
}

/**
 * Ferme le document Offscreen lorsqu'il n'est plus requis
 */
async function closeOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
    console.log('[SW] Document Offscreen fermé.');
  }
}

// Écouteur des messages inter-contextes (Sidepanel <-> SW <-> Offscreen)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) {
    console.warn('[SW Security] Message rejeté : sender.id non autorisé', sender?.id);
    return false;
  }
  if (sender.url && !sender.url.startsWith(chrome.runtime.getURL(''))) {
    console.warn('[SW Security] Message rejeté : URL émettrice hors périmètre', sender.url);
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'INIT_OFFSCREEN':
          await ensureOffscreenDocument();
          sendResponse({ success: true });
          break;

        case 'CLOSE_OFFSCREEN':
          await closeOffscreenDocument();
          sendResponse({ success: true });
          break;

        case 'UPDATE_BADGE':
          if (message.peersCount !== undefined) {
            const count = message.peersCount;
            if (count > 0) {
              await chrome.action.setBadgeText({ text: `${count}` });
              await chrome.action.setBadgeBackgroundColor({ color: '#10b981' }); // Vert émeraude
            } else {
              await chrome.action.setBadgeText({ text: '0' });
              await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // Ambre
            }
          }
          sendResponse({ success: true });
          break;

        case 'SHOW_NOTIFICATION':
          chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
            title: message.title || 'P2P Mesh Notification',
            message: message.body || ''
          });
          sendResponse({ success: true });
          break;

        default:
          sendResponse({ received: true });
          break;
      }
    } catch (err) {
      console.error('[SW] Erreur de traitement de message:', err);
      sendResponse({ error: err.message });
    }
  })();

  return true; // Maintient le canal ouvert pour les réponses asynchrones
});
