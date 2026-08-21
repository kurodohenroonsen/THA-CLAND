/**
 * Document Offscreen - P2P Mesh Extension
 * Fournit un environnement DOM sans interface utilisateur pour maintenir
 * les WebSockets de signalement, WebRTC DataChannels et l'Audio en arrière-plan.
 */

console.log('[Offscreen] Document Offscreen initialisé.');

// Répertoire des éléments audio distants
const audioElements = new Map();

// Écouteur des messages provenant du Sidepanel ou du Service Worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'PING':
      sendResponse({ status: 'PONG', timestamp: Date.now() });
      break;

    case 'PLAY_AUDIO_STREAM':
      // Si un stream audio ID doit être joué
      console.log('[Offscreen] Ordre de lecture audio reçu pour le pair:', message.peerId);
      sendResponse({ success: true });
      break;

    case 'STOP_ALL_AUDIO':
      audioElements.forEach((audio) => {
        audio.pause();
        audio.srcObject = null;
        audio.remove();
      });
      audioElements.clear();
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ received: true });
      break;
  }
});
