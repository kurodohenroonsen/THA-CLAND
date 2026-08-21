/**
 * Service Worker Manifest V3 - P2P Mesh Workspace (2026 Hardened Edition)
 * Gère le cycle de vie éphémère, la persistance chrome.storage.session,
 * le keepalive via Ports, le document Offscreen, les alarmes et notifications.
 */

// 1. Configuration initiale du Side Panel
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[SW] Erreur setPanelBehavior:', error));

// 2. Hydratation d'état idempotente depuis chrome.storage.session
async function hydrateServiceWorkerState() {
  try {
    const session = await chrome.storage.session.get(['badgeText', 'badgeColor', 'actionTitle']);
    if (session.badgeText !== undefined) {
      await chrome.action.setBadgeText({ text: session.badgeText });
      await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    }
    if (session.badgeColor !== undefined) {
      await chrome.action.setBadgeBackgroundColor({ color: session.badgeColor });
    }
    if (session.actionTitle !== undefined) {
      await chrome.action.setTitle({ title: session.actionTitle });
    }
  } catch (err) {
    console.debug('[SW] Échec hydratation état de session:', err);
  }
}
hydrateServiceWorkerState();

// 3. Gestionnaire d'installation & démarrage
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[SW] Extension installée/mise à jour:', details.reason);
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  await chrome.action.setTitle({ title: 'P2P Mesh Workspace : Prêt' });
  // Alarme de maintenance périodique (toutes les 5 minutes)
  try {
    chrome.alarms.create('sw-maintenance-alarm', { periodInMinutes: 5 });
  } catch (_) {}
});

chrome.runtime.onStartup.addListener(hydrateServiceWorkerState);

// 4. Gestionnaire d'alarmes périodiques
chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sw-maintenance-alarm') {
    console.debug('[SW Alarm] Exécution de la maintenance périodique...');
    await hydrateServiceWorkerState();
  }
});

// 5. Gestion atomique du document Offscreen
let creatingOffscreenPromise = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) return;

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  try {
    creatingOffscreenPromise = chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['AUDIO_PLAYBACK', 'USER_MEDIA', 'WEB_RTC'],
      justification: 'Maintien de la connexion WebRTC P2P et lecture des flux audio de groupe en tâche de fond'
    });
    await creatingOffscreenPromise;
    console.log('[SW] Document Offscreen initialisé.');
  } catch (err) {
    console.error('[SW] Erreur initialisation Offscreen:', err);
    throw err;
  } finally {
    creatingOffscreenPromise = null;
  }
}

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

// 6. Gestionnaire de ports de cycle de vie et keepalive
const activePanels = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel-lifecycle' || port.name === 'sidepanel-keepalive') {
    const windowId = port.sender?.tab?.windowId || port.sender?.windowId || 'default';
    activePanels.set(windowId, port);
    console.debug(`[SW Lifecycle] Panel connecté (Window ${windowId}). Total: ${activePanels.size}`);

    port.onMessage.addListener((msg) => {
      if (msg.type === 'PING') {
        try { port.postMessage({ type: 'PONG', timestamp: Date.now() }); } catch (_) {}
      }
    });

    port.onDisconnect.addListener(async () => {
      activePanels.delete(windowId);
      console.debug(`[SW Lifecycle] Panel déconnecté (Window ${windowId}). Restants: ${activePanels.size}`);
      if (activePanels.size === 0) {
        await closeOffscreenDocument();
      }
    });
  }
});

// 7. Écouteurs de clics et d'actions sur notifications OS
chrome.notifications?.onClicked.addListener(async (notificationId) => {
  try {
    const lastWindow = await chrome.windows.getLastFocused({ populate: true });
    if (lastWindow && lastWindow.id) {
      await chrome.windows.update(lastWindow.id, { focused: true });
      await chrome.sidePanel.open({ windowId: lastWindow.id });
    }
    if (notificationId.startsWith('p2p_channel_')) {
      const channelId = notificationId.replace('p2p_channel_', '');
      chrome.runtime.sendMessage({ type: 'NAVIGATE_CHANNEL', channelId }).catch(() => {});
    }
    chrome.notifications.clear(notificationId);
  } catch (err) {
    console.error('[SW] Erreur lors du clic notification:', err);
  }
});

chrome.notifications?.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  try {
    if (notificationId.startsWith('call_incoming_')) {
      chrome.notifications.clear(notificationId);
      const lastWindow = await chrome.windows.getLastFocused({ populate: true });
      if (lastWindow && lastWindow.id) {
        await chrome.windows.update(lastWindow.id, { focused: true });
        await chrome.sidePanel.open({ windowId: lastWindow.id });
      }
      if (buttonIndex === 0) {
        chrome.runtime.sendMessage({ type: 'ACCEPT_CALL' }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[SW] Erreur clic bouton notification:', err);
  }
});

// 8. Gestion de l'énergie (chrome.power)
let activeKeepAwakeCount = 0;

// 9. Écouteur des messages inter-contextes (Sidepanel <-> SW <-> Offscreen)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'UNAUTHORIZED_SENDER' });
    return false;
  }
  if (sender.url && !sender.url.startsWith(chrome.runtime.getURL(''))) {
    sendResponse({ error: 'FORBIDDEN_ORIGIN' });
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

        case 'UPDATE_UNREAD_BADGE': {
          const unread = Math.max(0, message.unreadCount || 0);
          const badgeText = unread > 0 ? (unread > 99 ? '99+' : String(unread)) : '';
          const badgeColor = '#ef4444';
          await chrome.action.setBadgeText({ text: badgeText });
          await chrome.action.setBadgeTextColor({ color: '#ffffff' });
          await chrome.action.setBadgeBackgroundColor({ color: badgeColor });
          await chrome.storage.session.set({ badgeText, badgeColor });
          sendResponse({ success: true });
          break;
        }

        case 'UPDATE_PEERS_COUNT': {
          const peers = message.peersCount || 0;
          const actionTitle = `P2P Mesh Workspace : ${peers} pair(s) en ligne`;
          await chrome.action.setTitle({ title: actionTitle });
          await chrome.storage.session.set({ actionTitle });
          sendResponse({ success: true });
          break;
        }

        case 'KEEP_AWAKE_ACQUIRE':
          activeKeepAwakeCount++;
          if (chrome.power) chrome.power.requestKeepAwake('system');
          sendResponse({ success: true, count: activeKeepAwakeCount });
          break;

        case 'KEEP_AWAKE_RELEASE':
          activeKeepAwakeCount = Math.max(0, activeKeepAwakeCount - 1);
          if (activeKeepAwakeCount === 0 && chrome.power) chrome.power.releaseKeepAwake();
          sendResponse({ success: true, count: activeKeepAwakeCount });
          break;

        case 'SHOW_NOTIFICATION': {
          const notifId = message.id || `p2p_notif_${Date.now()}`;
          chrome.notifications.create(notifId, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
            title: message.title || 'P2P Mesh Notification',
            message: message.body || '',
            priority: message.priority ?? 1,
            requireInteraction: !!message.requireInteraction,
            buttons: message.buttons || []
          });
          sendResponse({ success: true, notificationId: notifId });
          break;
        }

        default:
          sendResponse({ received: true });
          break;
      }
    } catch (err) {
      console.error('[SW] Erreur traitement message:', err);
      sendResponse({ error: err.message });
    }
  })();

  return true; // Maintient le canal ouvert pour les réponses asynchrones
});
