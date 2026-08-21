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
    const session = await chrome.storage.session.get(['badgeText', 'badgeColor', 'actionTitle', 'keepAwakeCount']);
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
    if (session.keepAwakeCount && session.keepAwakeCount > 0 && chrome.power) {
      chrome.power.requestKeepAwake('system');
    }
  } catch (err) {
    console.debug('[SW] Échec hydratation état de session:', err);
  }
}
hydrateServiceWorkerState();

// 3. Gestionnaire d'installation & démarrage
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[SW] Extension installée/mise à jour:', details.reason);
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
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

// 5. Gestion atomique du document Offscreen (Conformité MV3 Single-Reason)
let creatingOffscreenPromise = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');

  // Vérification de l'existence via getContexts (Chrome 116+)
  if (chrome.runtime.getContexts) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existingContexts.length > 0) return;
  }

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  try {
    // CRITIQUE : Une seule raison valide par appel selon la spécification Chromium 2026
    creatingOffscreenPromise = chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Maintien des flux audio de groupe et connexion WebRTC en tâche de fond'
    });
    await creatingOffscreenPromise;
    console.log('[SW] Document Offscreen initialisé avec succès.');
  } catch (err) {
    if (!err.message?.includes('Only a single offscreen document may be created')) {
      console.error('[SW] Erreur initialisation Offscreen:', err);
      throw err;
    }
  } finally {
    creatingOffscreenPromise = null;
  }
}

async function closeOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');
  if (chrome.runtime.getContexts) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existingContexts.length === 0) return;
  }

  try {
    await chrome.offscreen.closeDocument();
    console.log('[SW] Document Offscreen fermé.');
  } catch (err) {
    console.debug('[SW] Document Offscreen déjà fermé ou inexistant:', err);
  }
}

// 6. Gestionnaire de ports de cycle de vie et keepalive
const activePanels = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (
    port.name === 'p2p-mesh-keepalive' ||
    port.name === 'sidepanel-lifecycle' ||
    port.name === 'sidepanel-keepalive'
  ) {
    const windowId = port.sender?.tab?.windowId || port.sender?.windowId || 'default';
    activePanels.set(windowId, port);
    console.debug(`[SW Lifecycle] Panel connecté (Window: ${windowId}). Total actifs: ${activePanels.size}`);

    port.onMessage.addListener((msg) => {
      if (msg.type === 'PING') {
        try {
          port.postMessage({ type: 'PONG', timestamp: Date.now() });
        } catch (_) {}
      }
    });

    port.onDisconnect.addListener(async () => {
      activePanels.delete(windowId);
      console.debug(`[SW Lifecycle] Panel déconnecté (Window: ${windowId}). Restants: ${activePanels.size}`);
      if (activePanels.size === 0) {
        await closeOffscreenDocument();
      }
    });
  }
});

// Helper pour retrouver ou cibler une fenêtre de manière robuste
async function getSafeTargetWindow() {
  try {
    const lastWindow = await chrome.windows.getLastFocused({ populate: false });
    if (lastWindow && lastWindow.id) return lastWindow.id;
  } catch (_) {}
  try {
    const allWindows = await chrome.windows.getAll();
    if (allWindows && allWindows.length > 0) return allWindows[0].id;
  } catch (_) {}
  return null;
}

// 7. Écouteurs de clics et d'actions sur notifications OS
chrome.notifications?.onClicked.addListener(async (notificationId) => {
  try {
    const windowId = await getSafeTargetWindow();
    if (windowId) {
      await chrome.windows.update(windowId, { focused: true }).catch(() => {});
      await chrome.sidePanel.open({ windowId }).catch(() => {});
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
      const windowId = await getSafeTargetWindow();
      if (windowId) {
        await chrome.windows.update(windowId, { focused: true }).catch(() => {});
        await chrome.sidePanel.open({ windowId }).catch(() => {});
      }
      if (buttonIndex === 0) {
        chrome.runtime.sendMessage({ type: 'ACCEPT_CALL' }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[SW] Erreur clic bouton notification:', err);
  }
});

// 8. Écouteur des messages inter-contextes (Sidepanel <-> SW <-> Offscreen)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Sécurisation stricte de l'expéditeur interne à l'extension
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

        case 'KEEP_AWAKE_ACQUIRE': {
          const { keepAwakeCount = 0 } = await chrome.storage.session.get('keepAwakeCount');
          const newCount = keepAwakeCount + 1;
          await chrome.storage.session.set({ keepAwakeCount: newCount });
          if (chrome.power) chrome.power.requestKeepAwake('system');
          sendResponse({ success: true, count: newCount });
          break;
        }

        case 'KEEP_AWAKE_RELEASE': {
          const { keepAwakeCount = 0 } = await chrome.storage.session.get('keepAwakeCount');
          const newCount = Math.max(0, keepAwakeCount - 1);
          await chrome.storage.session.set({ keepAwakeCount: newCount });
          if (newCount === 0 && chrome.power) {
            chrome.power.releaseKeepAwake();
          }
          sendResponse({ success: true, count: newCount });
          break;
        }

        case 'SHOW_NOTIFICATION': {
          if (!chrome.notifications) {
            sendResponse({ error: 'NOTIFICATIONS_PERMISSION_REQUIRED' });
            break;
          }
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
