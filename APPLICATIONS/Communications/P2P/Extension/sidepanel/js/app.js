/**
 * Application Principale - P2P Mesh Workspace (2025/2026 Hardened Edition)
 * Orchestration globale : WebCrypto, WebRTC Mesh, CRDT, Storage Persistant,
 * PowerManager (Screen Wake Lock), OS Interop (Clipboard, Web Share, Drag & Drop),
 * WCO (Window Controls Overlay) et Keepalive MV3.
 */

import { logger } from './core/logger.js';
import { CryptoVault } from './core/crypto-vault.js';
import { dbManager } from './core/local-storage.js';
import { P2PMeshNetwork } from './core/p2p-mesh.js';
import { PresenceManager } from './core/presence.js';
import { CRDTEngine } from './core/crdt-engine.js';
import { powerManager } from './core/power-manager.js';
import { installGlobalDropGuard, ClipboardService, ZeroTraceClipboard } from './core/os-interop.js';
import { titleManager } from './core/title-manager.js';
import { AuthController } from './modules/auth/auth-controller.js';
import { ChatController } from './modules/chat/chat-controller.js';
import { ForumController } from './modules/chat/forum-controller.js';
import { DriveController } from './modules/drive/drive-controller.js';
import { CallController } from './modules/media/call-controller.js';
import { Modal } from './ui/modal.js';
import { Toast } from './ui/toast.js';
import { SanitizerService } from './core/sanitizer.js';

class P2PApp {
  constructor() {
    this.vault = new CryptoVault();
    this.mesh = null;
    this.presence = null;
    this.crdt = null;

    this.authController = null;
    this.chatController = null;
    this.forumController = null;
    this.driveController = null;
    this.callController = null;

    this.currentTab = 'chat';
    this.keepalivePort = null;
    this.deferredInstallPrompt = null;
  }

  async init() {
    // 0. Vérification du contexte sécurisé
    if (typeof window !== 'undefined' && (!window.isSecureContext || !window.crypto?.subtle)) {
      console.error('[App] Arrêt critique : Contexte non sécurisé (HTTP). WebCrypto et WebRTC indisponibles.');
      alert('Contexte non sécurisé : P2P Mesh requiert HTTPS ou localhost pour exécuter les opérations cryptographiques.');
      return;
    }

    // 1. Installation du garde-fou global Drag & Drop (Anti-Crash sur drop accidentel de fichier)
    installGlobalDropGuard();

    // 2. Initialisation des gestionnaires d'évacuation matérielle & anti-leak
    window.addEventListener('pagehide', () => {
      if (this.callController && this.callController.isInCall) {
        try { this.callController.leaveCall(); } catch {}
      }
      if (this.mesh) {
        try { this.mesh.stop(); } catch {}
      }
    });

    window.addEventListener('beforeunload', () => {
      if (this.callController && this.callController.isInCall) {
        try { this.callController.leaveCall(); } catch {}
      }
    });

    // 3. Initialisation du logger et keepalive MV3
    logger.installGlobalHandlers();
    logger.info('App', '🌟 Démarrage de P2P Mesh Workspace...');
    this.initServiceWorkerKeepalive();
    this.initWindowControlsAndInstall();

    // 4. Initialisation du stockage persistant
    logger.debug('App', '📦 Étape 1 : Initialisation IndexedDB & OPFS...');
    await dbManager.init();

    // 5. Configuration des modales
    logger.debug('App', '🪟 Étape 2 : Configuration des déclencheurs de modales...');
    Modal.setupCloseTriggers();

    // 6. Initialisation de l'authentification
    logger.debug('App', '🔑 Étape 3 : Initialisation du contrôleur d\'authentification...');
    this.authController = new AuthController(this.vault, (initializedVault) => {
      this.handleUserAuthenticated(initializedVault);
    });

    // 7. Vérification de session enregistrée
    logger.debug('App', '💾 Étape 4 : Vérification de session persistante...');
    await this.authController.checkSavedSession();

    // 8. Configuration de la navigation par onglets
    logger.debug('App', '🧭 Étape 5 : Configuration de la navigation...');
    this.initNavigation();

    titleManager.setSection('Accueil');
    logger.info('App', '✅ Initialisation terminée avec succès.');
  }

  /**
   * Canal Keepalive Port pour éviter l'extinction du Service Worker en cours d'utilisation active
   */
  initServiceWorkerKeepalive() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
      try {
        this.keepalivePort = chrome.runtime.connect({ name: 'sidepanel-lifecycle' });
        // Heartbeat toutes les 20s (inférieur au timeout SW de 30s)
        setInterval(() => {
          try {
            this.keepalivePort?.postMessage({ type: 'PING' });
          } catch (_) {
            // Reconnexion automatique si déconnecté
            try { this.keepalivePort = chrome.runtime.connect({ name: 'sidepanel-lifecycle' }); } catch (_) {}
          }
        }, 20000);
      } catch (err) {
        logger.debug('App', 'Port keepalive SW non disponible:', err);
      }
    }
  }

  /**
   * Gestion de l'installation PWA et du bouton Pop-Out détachable
   */
  initWindowControlsAndInstall() {
    // Bouton Pop-Out (Détacher vers fenêtre autonome)
    const btnPopout = document.getElementById('btn-popout-window');
    if (btnPopout) {
      btnPopout.addEventListener('click', () => {
        if (typeof chrome !== 'undefined' && chrome.windows?.create) {
          chrome.windows.create({
            url: chrome.runtime.getURL('sidepanel/index.html'),
            type: 'popup',
            width: 980,
            height: 740
          });
        } else {
          window.open(window.location.href, '_blank', 'width=980,height=740,menubar=no,toolbar=no');
        }
      });
    }

    // Gestion de l'installation PWA (beforeinstallprompt)
    const btnInstall = document.getElementById('btn-install-app');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstallPrompt = e;
      if (btnInstall) {
        btnInstall.classList.remove('hidden');
        btnInstall.onclick = async () => {
          if (!this.deferredInstallPrompt) return;
          this.deferredInstallPrompt.prompt();
          const choice = await this.deferredInstallPrompt.userChoice;
          if (choice.outcome === 'accepted') {
            Toast.success('Application P2P Mesh installée avec succès !');
          }
          this.deferredInstallPrompt = null;
          btnInstall.classList.add('hidden');
        };
      }
    });

    window.addEventListener('appinstalled', () => {
      logger.info('App', '🎉 PWA P2P Mesh installée sur le système.');
      if (btnInstall) btnInstall.classList.add('hidden');
      document.body.classList.add('is-standalone');
    });

    if (window.matchMedia('(display-mode: standalone)').matches) {
      document.body.classList.add('is-standalone');
    }
  }

  async handleUserAuthenticated(vault) {
    logger.info('App', '🚀 Utilisateur authentifié ! Démarrage des sous-systèmes P2P...');

    const authView = document.getElementById('view-auth');
    const mainView = document.getElementById('view-main-app');
    if (authView) authView.classList.add('hidden');
    if (mainView) mainView.classList.remove('hidden');

    const topicIndicator = document.getElementById('header-topic-id');
    if (topicIndicator) {
      topicIndicator.textContent = `Salon : ${vault.topicHex.substring(0, 8)}...`;
    }

    // 1. Démarrage du réseau P2P Mesh
    logger.debug('App', '🌐 Instanciation du P2PMeshNetwork...');
    this.mesh = new P2PMeshNetwork(vault);

    // 2. Démarrage de la présence et de la télémétrie
    logger.debug('App', '👥 Instanciation de PresenceManager...');
    this.presence = new PresenceManager(this.mesh);
    this.presence.start();

    // 3. Démarrage du moteur CRDT
    logger.debug('App', '⚙️ Instanciation de CRDTEngine...');
    this.crdt = new CRDTEngine(this.mesh, vault);

    // 4. Initialisation des contrôleurs fonctionnels
    logger.debug('App', '💬 Initialisation des contrôleurs...');
    this.chatController = new ChatController(this.crdt, vault);
    this.forumController = new ForumController(this.crdt, vault);
    this.driveController = new DriveController(this.crdt, this.mesh, vault);
    this.callController = new CallController(this.mesh, this.presence, vault);

    this.chatController.attachTransfer(this.driveController.transferManager, this.mesh);

    // 5. Écouteurs de statut réseau et présence
    this.initStatusListeners();

    // 6. Lancement du réseau et signalement
    logger.info('App', '📡 Lancement de la connexion P2P Mesh...');
    await this.mesh.start();

    // 7. Panneau de réglages & diagnostic
    this.setupSettingsPanel(vault);
    const gear = document.getElementById('btn-open-settings');
    if (gear) gear.classList.remove('hidden');

    // 8. Chargement initial des données
    logger.debug('App', '📂 Chargement initial des données locales...');
    await this.chatController.loadChannelMessages('general');
    await this.forumController.loadThreads();
    await this.driveController.loadFiles();

    // 9. Restauration du dernier onglet actif
    try {
      const lastTab = await dbManager.getSetting('active_tab', 'chat');
      if (lastTab && lastTab !== 'chat') this.switchTab(lastTab);
    } catch (e) {
      logger.debug('App', 'Erreur restauration active_tab:', e);
    }

    // 10. Initialisation de l'Offscreen Document pour le maintien WebRTC
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'INIT_OFFSCREEN' }).catch(() => {});
      }
    } catch (err) {
      logger.debug('App', 'Offscreen document non requis:', err);
    }

    Toast.success('Connecté au réseau P2P Décentralisé !');
  }

  initStatusListeners() {
    const statusDot = document.getElementById('network-status-dot');
    const statusText = document.getElementById('network-status-text');
    const peersBadge = document.getElementById('header-peers-count');
    const footerPeers = document.getElementById('footer-connected-peers');
    const footerLatency = document.getElementById('footer-latency');

    this.mesh.on('status-change', ({ status, peersCount, message }) => {
      logger.info('App', `📶 Statut réseau changé: "${status}" (${peersCount || 0} pairs) - ${message}`);
      if (statusDot) {
        statusDot.className = `status-dot ${status === 'connected' ? 'online' : 'connecting'}`;
      }
      if (statusText) {
        statusText.textContent = status === 'connected' ? 'En Ligne (P2P)' : 'Recherche de pairs...';
      }
      if (peersBadge) {
        peersBadge.textContent = `👥 ${peersCount || 0}`;
      }
      if (footerPeers) {
        footerPeers.textContent = `${peersCount || 0} pair(s) connecté(s)`;
      }

      // Mise à jour du titre de l'action / infobulle (sans polluer le badge de messages)
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: 'UPDATE_PEERS_COUNT', peersCount: peersCount || 0 }).catch(() => {});
        }
      } catch (e) {
        logger.debug('App', 'Erreur mise à jour peers count:', e);
      }
    });

    this.presence.onPresenceUpdate((peerList) => {
      this.renderPeersRoster(peerList);

      const footerQuality = document.getElementById('footer-quality');
      if (peerList.length > 0) {
        const avgLat = Math.round(peerList.reduce((acc, p) => acc + (p.latencyMs || 0), 0) / peerList.length);
        const minMos = peerList.reduce((min, p) => Math.min(min, p.qos?.mos || 4.5), 4.5);
        if (footerLatency) footerLatency.textContent = `⚡ Latence : ${avgLat} ms`;
        if (footerQuality) {
          let cls, label;
          if (minMos >= 4.1) { cls = 'q-excellent'; label = `Excellente (${minMos.toFixed(1)})`; }
          else if (minMos >= 3.6) { cls = 'q-good'; label = `Bonne (${minMos.toFixed(1)})`; }
          else if (minMos >= 2.8) { cls = 'q-medium'; label = `Dégradée (${minMos.toFixed(1)})`; }
          else { cls = 'q-poor'; label = `Critique (${minMos.toFixed(1)})`; }
          footerQuality.className = `conn-quality ${cls}`;
          footerQuality.textContent = label;
        }
      } else {
        if (footerLatency) footerLatency.textContent = '⚡ Latence : -- ms';
        if (footerQuality) { footerQuality.className = 'conn-quality'; footerQuality.textContent = ''; }
      }
    });

    window.addEventListener('online', () => this.mesh?.handleNetworkOnline());
    window.addEventListener('offline', () => this.mesh?.handleNetworkOffline());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.mesh) {
        this.mesh.handleNetworkOnline();
      }
    });
  }

  initNavigation() {
    const navButtons = document.querySelectorAll('.nav-tab-btn');
    navButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        this.switchTab(targetTab);
      });
    });
  }

  switchTab(tabName) {
    logger.debug('App', `🧭 Navigation vers l'onglet: "${tabName}"`);
    this.currentTab = tabName;
    try {
      dbManager.saveSetting('active_tab', tabName);
    } catch (e) {
      logger.debug('App', 'Erreur sauvegarde active_tab:', e);
    }

    const tabLabels = { chat: 'Messagerie', forum: 'Forums & Sujets', drive: 'Drive & Documents', media: 'Salons Vocaux/Vidéo' };
    titleManager.setSection(tabLabels[tabName] || tabName);

    if (tabName === 'chat' && this.chatController) this.chatController.markActiveChannelRead();

    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
      const isTarget = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('active', isTarget);
      btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
      btn.setAttribute('tabindex', isTarget ? '0' : '-1');
    });

    document.querySelectorAll('.view-section').forEach(view => {
      if (view.id === `tab-view-${tabName}`) {
        view.classList.remove('hidden');
      } else {
        view.classList.add('hidden');
      }
    });

    if (tabName === 'forum' && this.forumController) {
      this.forumController.loadThreads();
    } else if (tabName === 'drive' && this.driveController) {
      this.driveController.loadFiles();
      this.refreshStorageUI();
    } else if (tabName === 'media' && this.callController) {
      this.callController.updateVideoGrid();
    }
  }

  renderPeersRoster(peerList) {
    const container = document.getElementById('peers-roster-list');
    if (!container) return;

    container.innerHTML = '';

    const selfCard = document.createElement('div');
    selfCard.className = 'peer-card is-self';
    selfCard.innerHTML = `
      <img src="${this.presence.generateAvatar(this.vault.peerId)}" class="peer-avatar" alt="Avatar"/>
      <div class="peer-details">
        <div class="peer-name-row">
          <strong>${this.escape(this.vault.userName)}</strong>
          <span class="badge badge-version">Vous</span>
        </div>
        <div class="peer-meta-row">
          <span>Identifiant : <code>${this.vault.peerId}</code></span>
        </div>
      </div>
    `;
    container.appendChild(selfCard);

    if (peerList.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `
        <div class="empty-icon">📡</div>
        <p>En attente d'autres membres sur ce groupe...</p>
        <small>Partagez votre Code Papier pour qu'ils vous rejoignent.</small>
      `;
      container.appendChild(empty);
      return;
    }

    peerList.forEach(peer => {
      const card = document.createElement('div');
      card.className = 'peer-card';
      card.innerHTML = `
        <img src="${peer.avatar}" class="peer-avatar" alt="Avatar"/>
        <div class="peer-details">
          <div class="peer-name-row">
            <strong>${this.escape(peer.name)}</strong>
            <span class="peer-latency-tag">⚡ ${peer.latencyMs} ms</span>
          </div>
          <div class="peer-meta-row">
            <span>ID : <code>${peer.id}</code></span>
            ${peer.isAudioActive ? '<span class="badge badge-active">🎙️ Audio</span>' : ''}
            ${peer.isVideoActive ? '<span class="badge badge-version">📷 Vidéo</span>' : ''}
          </div>
        </div>
      `;
      container.appendChild(card);
    });
  }

  setupSettingsPanel(vault) {
    const gear = document.getElementById('btn-open-settings');
    const nameInput = document.getElementById('settings-name-input');
    const btnSaveName = document.getElementById('btn-save-name');
    const topicEl = document.getElementById('settings-topic');
    const paperEl = document.getElementById('settings-paper-code');
    const fpEl = document.getElementById('settings-fingerprint');
    const idNameEl = document.getElementById('settings-identity-name');
    const avatarEl = document.getElementById('settings-avatar');
    const notifChk = document.getElementById('settings-notifications');
    const btnCopyTopic = document.getElementById('btn-copy-topic');
    const btnCopyPaper = document.getElementById('btn-copy-paper');
    const btnLogout = document.getElementById('btn-logout');
    const btnExportDiag = document.getElementById('btn-export-diagnostic');
    const logSelect = document.getElementById('settings-loglevel');
    const debugInput = document.getElementById('settings-debug-filter');
    const btnReqPersist = document.getElementById('btn-request-persistence');

    const flashCopy = async (btn, text, isSensitive = false) => {
      const ok = isSensitive
        ? await ZeroTraceClipboard.copySensitive(text, 45000)
        : await ClipboardService.copy(text);

      if (ok) {
        const o = btn.textContent;
        btn.textContent = '✓';
        btn.classList.add('copied-flash');
        setTimeout(() => { btn.textContent = o; btn.classList.remove('copied-flash'); }, 1400);
        if (isSensitive) Toast.info('Code copié ! Auto-purge du presse-papier dans 45s.');
      } else {
        Toast.warning('Impossible d\'accéder au presse-papier.');
      }
    };

    const openSettings = async () => {
      if (nameInput) nameInput.value = vault.userName || '';
      if (idNameEl) idNameEl.textContent = vault.userName || 'Membre P2P';
      if (topicEl) topicEl.textContent = `${vault.topicHex.substring(0, 16)}…`;
      if (fpEl) fpEl.textContent = vault.peerIdHex ? vault.peerIdHex.substring(0, 16) : '—';
      if (avatarEl && this.presence) avatarEl.src = this.presence.generateAvatar(vault.peerId);

      if (paperEl) {
        paperEl.dataset.code = '';
        paperEl.textContent = '🔒 Masqué (Zéro-Trace RAM)';
      }
      if (notifChk) notifChk.checked = await dbManager.getSetting('notifications_enabled', false);

      if (logSelect) {
        try {
          const lvl = localStorage.getItem('pmesh.loglevel') || 'INFO';
          logSelect.value = lvl.toUpperCase();
        } catch (_) {}
      }
      if (debugInput) {
        try {
          debugInput.value = localStorage.getItem('pmesh.debug') || '';
        } catch (_) {}
      }

      if (this.callController && this.callController.mediaManager) {
        const devices = await this.callController.mediaManager.getAvailableDevices();
        this.callController.updateDeviceSelectors(devices);
      }

      await this.refreshStorageUI();
      Modal.open('modal-settings');
    };

    if (btnReqPersist) {
      btnReqPersist.addEventListener('click', async () => {
        const res = await dbManager.requestPersistenceInteractive();
        if (res.granted) {
          Toast.success('Stockage persistant garanti par le navigateur !');
        } else {
          Toast.warning('Persistance refusée ou restreinte par le navigateur.');
        }
        await this.refreshStorageUI();
      });
    }

    const btnTestSpeaker = document.getElementById('btn-test-audio-output');
    const selectSpeaker = document.getElementById('select-audio-output');
    if (btnTestSpeaker && selectSpeaker && this.callController) {
      btnTestSpeaker.addEventListener('click', () => {
        this.callController.playSpeakerTestTone(selectSpeaker.value);
      });
      selectSpeaker.addEventListener('change', () => {
        this.callController.setAudioOutputSink(selectSpeaker.value);
      });
    }

    const selectMic = document.getElementById('select-audio-input');
    if (selectMic && this.callController) {
      selectMic.addEventListener('change', () => {
        this.callController.mediaManager.selectedAudioInputId = selectMic.value;
      });
    }

    const selectCam = document.getElementById('select-video-input');
    if (selectCam && this.callController) {
      selectCam.addEventListener('change', () => {
        this.callController.mediaManager.selectedVideoInputId = selectCam.value;
      });
    }

    if (gear) gear.addEventListener('click', openSettings);

    if (btnSaveName && nameInput) {
      btnSaveName.addEventListener('click', async () => {
        const newName = nameInput.value.trim();
        if (!newName) { Toast.warning('Le pseudonyme ne peut pas être vide.'); return; }
        vault.userName = newName;
        await dbManager.saveSetting('user_name', newName);
        if (idNameEl) idNameEl.textContent = newName;
        try {
          this.mesh.broadcast({ type: 'PEER_HELLO', name: newName, pubkey: vault.publicKeyHex });
        } catch (err) {
          logger.warn('App', 'Échec diffusion PEER_HELLO:', err);
        }
        Toast.success('Pseudonyme mis à jour.');
      });
    }

    if (btnCopyTopic) btnCopyTopic.addEventListener('click', () => flashCopy(btnCopyTopic, vault.topicHex));
    if (btnCopyPaper && paperEl) btnCopyPaper.addEventListener('click', () => flashCopy(btnCopyPaper, paperEl.dataset.code || '', true));

    if (notifChk) {
      notifChk.addEventListener('change', async () => {
        if (notifChk.checked) {
          // Gestion des permissions optionnelles en contexte MV3
          if (typeof chrome !== 'undefined' && chrome.permissions?.request) {
            try {
              const granted = await chrome.permissions.request({ permissions: ['notifications'] });
              if (!granted) {
                notifChk.checked = false;
                Toast.warning('Permission notification refusée par Chrome.');
                return;
              }
            } catch (_) {}
          } else if ('Notification' in window && Notification.permission === 'default') {
            try {
              const res = await Notification.requestPermission();
              if (res !== 'granted') notifChk.checked = false;
            } catch (_) {}
          }
        }
        await dbManager.saveSetting('notifications_enabled', notifChk.checked);
      });
    }

    if (logSelect) {
      logSelect.addEventListener('change', () => {
        try {
          localStorage.setItem('pmesh.loglevel', logSelect.value);
          logger.info('App', `Niveau de log: ${logSelect.value}`);
          Toast.info(`Niveau de journalisation : ${logSelect.value}`);
        } catch (_) {}
      });
    }

    if (debugInput) {
      debugInput.addEventListener('change', () => {
        try {
          const val = debugInput.value.trim();
          if (val) localStorage.setItem('pmesh.debug', val);
          else localStorage.removeItem('pmesh.debug');
          logger.info('App', `Filtre debug: ${val || 'aucun'}`);
          Toast.info('Filtres de débogage mis à jour.');
        } catch (_) {}
      });
    }

    if (btnExportDiag) {
      btnExportDiag.addEventListener('click', async () => {
        try {
          const diag = await logger.exportDiagnostic({
            topicHex: vault.topicHex,
            peerId: vault.peerId,
            connectedPeersCount: this.mesh ? this.mesh.peers.size : 0,
            rosterCount: this.presence ? this.presence.roster.size : 0,
            activeChannel: this.currentTab
          });
          const jsonStr = JSON.stringify(diag, null, 2);
          const blob = new Blob([jsonStr], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `p2p-mesh-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          Toast.success('Rapport de diagnostic exporté !');
        } catch (err) {
          logger.error('App', 'Échec export diagnostic:', err);
          Toast.error('Impossible d\'exporter le rapport.');
        }
      });
    }

    if (btnLogout) {
      btnLogout.addEventListener('click', async () => {
        if (!confirm('Se déconnecter et effacer la session locale ?')) return;
        try { await dbManager.delete('settings', 'last_paper_code'); } catch (_) {}
        try { this.callController?.isInCall && this.callController.leaveCall(); } catch {}
        try { this.mesh?.stop(); } catch (_) {}
        try { this.presence?.stop(); } catch (_) {}
        try { this.crdt?.destroy(); } catch {}
        try { this.vault?.destroy(); } catch {}
        logger.clearBuffer();
        Toast.info('Déconnexion…');
        setTimeout(() => location.reload(), 500);
      });
    }
  }

  async refreshStorageUI() {
    const est = await dbManager.estimateStorage();
    const isPersisted = await dbManager.isPersisted();
    const btnReqPersist = document.getElementById('btn-request-persistence');
    const badgePersist = document.getElementById('settings-persistence-badge');

    const fmt = (b) => {
      if (!b) return '0 o';
      const k = 1024, u = ['o', 'Ko', 'Mo', 'Go', 'To'];
      const i = Math.floor(Math.log(b) / Math.log(k));
      return `${(b / Math.pow(k, i)).toFixed(1)} ${u[i]}`;
    };

    if (badgePersist) {
      badgePersist.textContent = isPersisted ? '🔒 Persistant (Garanti)' : '⚠️ Évictable (Best-effort)';
      badgePersist.className = `badge ${isPersisted ? 'badge-active' : 'badge-version'}`;
    }

    if (btnReqPersist) {
      btnReqPersist.style.display = isPersisted ? 'none' : 'inline-block';
    }

    const pct = est.quota ? est.percent : 0;
    const label = est.quota ? `${fmt(est.usage)} / ${fmt(est.quota)} (${pct}%)` : fmt(est.usage);

    const setBar = (barId, txtId) => {
      const bar = document.getElementById(barId), txt = document.getElementById(txtId);
      if (bar) {
        bar.style.width = `${Math.min(100, pct)}%`;
        // Palette 4 paliers (Cyan, Jaune 75%, Orange 85%, Rose 95%)
        if (pct >= 95) bar.style.background = 'var(--accent-rose)';
        else if (pct >= 85) bar.style.background = '#f97316';
        else if (pct >= 75) bar.style.background = 'var(--accent-amber)';
        else bar.style.background = 'var(--grad-primary)';
      }
      if (txt) txt.textContent = label;
    };

    setBar('settings-storage-bar', 'settings-storage-text');
    setBar('drive-storage-bar', 'drive-storage-text');
  }

  escape(str) {
    return SanitizerService.escape(str);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new P2PApp();
  app.init().catch(err => logger.error('App', '❌ Erreur fatale démarrage:', err));
});
