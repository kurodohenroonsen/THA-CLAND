/**
 * Application Principale - P2P Mesh Workspace (Pass 4 Hardened Edition)
 * Orchestration globale : WebCrypto, WebRTC Mesh, CRDT, Storage Persistant,
 * PowerManager (Screen Wake Lock), OS Interop (Clipboard, Web Share, Drag & Drop),
 * WCO (Window Controls Overlay), i18n sans framework, Command Palette, A11y Announcer,
 * Thèmes dynamiques WCAG 2.2 AAA & Échelle de densité DTCG.
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
import { i18n } from './core/i18n.js';
import { a11yAnnouncer } from './core/a11y-announcer.js';
import { AuthController } from './modules/auth/auth-controller.js';
import { ChatController } from './modules/chat/chat-controller.js';
import { ForumController } from './modules/chat/forum-controller.js';
import { DriveController } from './modules/drive/drive-controller.js';
import { CallController } from './modules/media/call-controller.js';
import { Modal } from './ui/modal.js';
import { Toast } from './ui/toast.js';
import { CommandPalette } from './ui/command-palette.js';
import { EmptyStateService } from './ui/empty-state-service.js';
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
    this.commandPalette = null;

    this.currentTab = 'chat';
    this.keepalivePort = null;
    this.deferredInstallPrompt = null;
  }

  async init() {
    // 0. Initialisation des services d'accessibilité et d'internationalisation
    a11yAnnouncer.init();

    // Vérification du contexte sécurisé
    if (typeof window !== 'undefined' && (!window.isSecureContext || !window.crypto?.subtle)) {
      console.error('[App] Arrêt critique : Contexte non sécurisé (HTTP). WebCrypto et WebRTC indisponibles.');
      await Modal.alert(
        'Contexte non sécurisé : P2P Mesh requiert HTTPS ou localhost pour exécuter les opérations cryptographiques.',
        'Erreur Critique'
      );
      return;
    }

    // Initialisation i18n
    try {
      const savedLang = localStorage.getItem('pmesh.lang');
      await i18n.init(savedLang);
    } catch (e) {
      logger.warn('App', 'Initialisation i18n dégradée:', e);
    }

    // 1. Installation du garde-fou global Drag & Drop
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
    logger.info('App', '🌟 Démarrage de P2P Mesh Workspace (Pass 4 Hardened)...');
    this.initServiceWorkerKeepalive();
    this.initWindowControlsAndInstall();

    // 4. Initialisation des systèmes de Thème et Densité
    this.initThemeManager();
    this.initDensityManager();

    // 5. Initialisation du stockage persistant
    logger.debug('App', '📦 Étape 1 : Initialisation IndexedDB & OPFS...');
    await dbManager.init();

    // 6. Configuration des modales
    logger.debug('App', '🪟 Étape 2 : Configuration des déclencheurs de modales...');
    Modal.setupCloseTriggers();

    // 7. Initialisation de l'authentification
    logger.debug('App', '🔑 Étape 3 : Initialisation du contrôleur d\'authentification...');
    this.authController = new AuthController(this.vault, (initializedVault) => {
      this.handleUserAuthenticated(initializedVault);
    });

    // 8. Initialisation de la Palette de Commandes (Ctrl+K / Cmd+K)
    this.commandPalette = new CommandPalette(this);

    // 9. Vérification de session enregistrée
    logger.debug('App', '💾 Étape 4 : Vérification de session persistante...');
    await this.authController.checkSavedSession();

    // 10. Configuration de la navigation par onglets
    logger.debug('App', '🧭 Étape 5 : Configuration de la navigation...');
    this.initNavigation();

    titleManager.setSection('Accueil');
    logger.info('App', '✅ Initialisation terminée avec succès.');
  }

  /**
   * Gestionnaire de Thème (Dark / Light / Auto OS / High Contrast)
   */
  initThemeManager() {
    try {
      const savedTheme = localStorage.getItem('pmesh.theme') || 'auto';
      this.applyTheme(savedTheme);

      if (typeof window !== 'undefined' && window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
          const current = localStorage.getItem('pmesh.theme') || 'auto';
          if (current === 'auto') {
            this.applyTheme('auto');
          }
        });
      }
    } catch (e) {
      logger.debug('App', 'Erreur initThemeManager:', e);
    }
  }

  applyTheme(theme) {
    if (typeof document === 'undefined') return;
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try { localStorage.setItem('pmesh.theme', theme); } catch (_) {}
  }

  /**
   * Gestionnaire de Densité UI (DTCG Standard : compact / standard / comfort)
   */
  initDensityManager() {
    try {
      const savedDensity = localStorage.getItem('pmesh.density') || 'standard';
      this.applyDensity(savedDensity);
    } catch (e) {
      logger.debug('App', 'Erreur initDensityManager:', e);
    }
  }

  applyDensity(density) {
    if (typeof document === 'undefined') return;
    const target = ['compact', 'standard', 'comfort'].includes(density) ? density : 'standard';
    document.documentElement.setAttribute('data-density', target);
    try { localStorage.setItem('pmesh.density', target); } catch (_) {}

    document.querySelectorAll('.density-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-density-val') === target);
    });
  }

  initWindowControlsAndInstall() {
    const isOverlayVisible = typeof navigator !== 'undefined' && 
      navigator.windowControlsOverlay && 
      navigator.windowControlsOverlay.visible;
    if (isOverlayVisible) {
      document.body.classList.add('wco-active');
    }

    if (typeof navigator !== 'undefined' && navigator.windowControlsOverlay) {
      navigator.windowControlsOverlay.addEventListener('geometrychange', (e) => {
        if (e.visible) document.body.classList.add('wco-active');
        else document.body.classList.remove('wco-active');
      });
    }

    const btnInstall = document.getElementById('btn-pwa-install');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstallPrompt = e;
      if (btnInstall) btnInstall.classList.remove('hidden');
    });

    if (btnInstall) {
      btnInstall.addEventListener('click', async () => {
        if (!this.deferredInstallPrompt) return;
        this.deferredInstallPrompt.prompt();
        const choice = await this.deferredInstallPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          Toast.success(i18n.t('app.installed_success'));
        }
        this.deferredInstallPrompt = null;
        btnInstall.classList.add('hidden');
      });
    }

    window.addEventListener('appinstalled', () => {
      if (btnInstall) btnInstall.classList.add('hidden');
      this.deferredInstallPrompt = null;
    });

    const btnPopout = document.getElementById('btn-popout-window');
    if (btnPopout) {
      btnPopout.addEventListener('click', () => {
        const url = window.location.href;
        window.open(url, '_blank', 'width=420,height=720,menubar=no,toolbar=no,location=no,status=no');
      });
    }
  }

  initServiceWorkerKeepalive() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
    try {
      this.keepalivePort = chrome.runtime.connect({ name: 'p2p-mesh-keepalive' });
      this.keepalivePort.onDisconnect.addListener(() => {
        logger.debug('App', 'Port keepalive déconnecté. Reconnexion dans 5s...');
        setTimeout(() => this.initServiceWorkerKeepalive(), 5000);
      });
      logger.debug('App', 'Canal Keepalive MV3 connecté au Service Worker.');
    } catch (err) {
      logger.debug('App', 'Contexte standard (hors extension Chrome). Keepalive non requis.');
    }
  }

  handleUserAuthenticated(vault) {
    logger.info('App', `🚀 Démarrage des sous-systèmes pour "${vault.userName}" (Topic: ${vault.topicHex.substring(0, 8)}...)`);
    
    // Déclencheur Screen Wake Lock dès authentification
    powerManager.requestWakeLock('Espace de travail P2P actif');

    document.getElementById('view-auth').classList.add('hidden');
    document.getElementById('view-main-app').classList.remove('hidden');

    this.mesh = new P2PMeshNetwork(vault);
    this.presence = new PresenceManager(this.mesh, vault);
    this.crdt = new CRDTEngine(this.mesh, vault, this.presence);

    this.chatController = new ChatController(this.crdt, vault);
    this.forumController = new ForumController(this.crdt, vault);
    this.driveController = new DriveController(this.crdt, this.mesh, vault);
    this.callController = new CallController(this.mesh, this.presence, vault);

    this.initAppEvents();
    this.setupSettingsPanel(vault);

    this.mesh.start();
    this.presence.start();

    // Rétablissement du dernier onglet
    dbManager.getSetting('active_tab', 'chat').then(savedTab => {
      this.switchTab(savedTab);
    });

    Toast.success(i18n.t('app.connected_success'));
    a11yAnnouncer.announcePolite(i18n.t('app.connected_success'));
  }

  initAppEvents() {
    const statusText = document.getElementById('network-status-text');
    const statusDot = document.getElementById('network-status-dot');
    const footerPeersCount = document.getElementById('footer-peers-count');
    const footerLatency = document.getElementById('footer-avg-latency');
    const footerQuality = document.getElementById('footer-conn-quality');

    this.presence.on('roster-updated', (roster) => {
      const peerList = Array.from(roster.values());
      const connectedCount = this.mesh.peers.size;

      if (statusText) {
        statusText.textContent = connectedCount > 0
          ? `${connectedCount} pair(s) connecté(s)`
          : i18n.t('app.status_connecting');
      }
      if (statusDot) {
        statusDot.className = `status-dot ${connectedCount > 0 ? 'online' : 'connecting'}`;
      }

      if (footerPeersCount) {
        footerPeersCount.textContent = i18n.t('footer.peers_count', { count: connectedCount });
      }

      this.renderPeersRoster(peerList);

      if (this.callController) {
        this.callController.updateVideoGrid();
      }
    });

    this.mesh.on('peer-connected', ({ peerId }) => {
      Toast.info(`Nouveau pair connecté : ${peerId.substring(0, 8)}`);
      a11yAnnouncer.announcePolite(`Pair ${peerId.substring(0, 8)} connecté.`);
    });

    this.mesh.on('peer-disconnected', ({ peerId }) => {
      Toast.warn(`Pair déconnecté : ${peerId.substring(0, 8)}`);
      a11yAnnouncer.announcePolite(`Pair ${peerId.substring(0, 8)} déconnecté.`);
    });

    this.mesh.on('metrics-updated', (metrics) => {
      if (metrics.connectedCount > 0) {
        if (footerLatency) footerLatency.textContent = i18n.t('footer.latency', { ms: metrics.avgLatencyMs });
        if (footerQuality) {
          footerQuality.className = `conn-quality quality-${metrics.quality}`;
          const qMap = {
            excellent: i18n.t('footer.quality_excellent', { score: metrics.mosScore }),
            good: i18n.t('footer.quality_good', { score: metrics.mosScore }),
            medium: i18n.t('footer.quality_medium', { score: metrics.mosScore }),
            poor: i18n.t('footer.quality_poor', { score: metrics.mosScore })
          };
          footerQuality.textContent = qMap[metrics.quality] || metrics.quality;
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

    const tabLabels = {
      chat: i18n.t('nav.chat_title'),
      forum: i18n.t('nav.forum_title'),
      drive: i18n.t('nav.drive_title'),
      media: i18n.t('nav.media_title'),
      roster: i18n.t('roster.title')
    };
    titleManager.setSection(tabLabels[tabName] || tabName);

    if (tabName === 'chat' && this.chatController) this.chatController.markActiveChannelRead();

    const updateDOM = () => {
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
    };

    const supportsVT = typeof document.startViewTransition === 'function';
    const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (supportsVT && !prefersReducedMotion) {
      document.startViewTransition(() => updateDOM());
    } else {
      updateDOM();
    }

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
          <span class="badge badge-version">${i18n.t('roster.you_badge')}</span>
        </div>
        <div class="peer-meta-row">
          <span>${i18n.t('roster.id_label')} <code>${this.vault.peerId}</code></span>
        </div>
      </div>
    `;
    container.appendChild(selfCard);

    if (peerList.length === 0) {
      const emptyState = EmptyStateService.renderRosterEmptyState(
        this.vault,
        () => { if (this.mesh) this.mesh.handleNetworkOnline(); }
      );
      container.appendChild(emptyState);
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
    const langSelect = document.getElementById('settings-language-select');
    const themeSelect = document.getElementById('settings-theme-select');

    // Initialisation sélecteur de langue
    if (langSelect) {
      langSelect.value = i18n.locale;
      langSelect.addEventListener('change', async () => {
        const targetLang = langSelect.value;
        await i18n.setLocale(targetLang);
        try { localStorage.setItem('pmesh.lang', targetLang); } catch (_) {}
        Toast.success(targetLang === 'fr' ? 'Langue modifiée en Français.' : 'Language set to English.');
      });
    }

    // Initialisation sélecteur de thème
    if (themeSelect) {
      try {
        themeSelect.value = localStorage.getItem('pmesh.theme') || 'auto';
      } catch (_) {}
      themeSelect.addEventListener('change', () => {
        this.applyTheme(themeSelect.value);
        Toast.info('Thème visuel mis à jour.');
      });
    }

    // Initialisation des boutons de densité
    document.querySelectorAll('.density-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-density-val');
        this.applyDensity(val);
        Toast.info(`Densité d'affichage : ${val}`);
      });
    });

    const flashCopy = async (btn, text, isSensitive = false) => {
      const ok = isSensitive
        ? await ZeroTraceClipboard.copySensitive(text, 45000)
        : await ClipboardService.copy(text);

      if (ok) {
        const o = btn.textContent;
        btn.textContent = '✓';
        btn.classList.add('copied-flash');
        setTimeout(() => { btn.textContent = o; btn.classList.remove('copied-flash'); }, 1400);
        if (isSensitive) Toast.info(i18n.t('app.clipboard_copied'));
      } else {
        Toast.warning(i18n.t('app.clipboard_error'));
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
        paperEl.textContent = i18n.t('modals.masked_paper_code');
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
          Toast.success(i18n.t('app.persisted_granted'));
        } else {
          Toast.warning(i18n.t('app.persisted_denied'));
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
      selectMic.addEventListener('change', async () => {
        const newDeviceId = selectMic.value;
        await this.callController.switchAudioInput(newDeviceId);
      });
    }

    const selectCam = document.getElementById('select-video-input');
    if (selectCam && this.callController) {
      selectCam.addEventListener('change', async () => {
        const newDeviceId = selectCam.value;
        await this.callController.switchVideoInput(newDeviceId);
      });
    }

    if (gear) gear.addEventListener('click', openSettings);

    if (btnSaveName && nameInput) {
      btnSaveName.addEventListener('click', async () => {
        const newName = nameInput.value.trim();
        if (!newName) { Toast.warning(i18n.t('app.name_required')); return; }
        vault.userName = newName;
        await dbManager.saveSetting('user_name', newName);
        if (idNameEl) idNameEl.textContent = newName;
        try {
          this.mesh.broadcast({ type: 'PEER_HELLO', name: newName, pubkey: vault.publicKeyHex });
        } catch (err) {
          logger.warn('App', 'Échec diffusion PEER_HELLO:', err);
        }
        Toast.success(i18n.t('app.name_updated'));
      });
    }

    if (btnCopyTopic) btnCopyTopic.addEventListener('click', () => flashCopy(btnCopyTopic, vault.topicHex));
    if (btnCopyPaper && paperEl) btnCopyPaper.addEventListener('click', () => flashCopy(btnCopyPaper, paperEl.dataset.code || '', true));

    if (notifChk) {
      notifChk.addEventListener('change', async () => {
        if (notifChk.checked) {
          if (typeof chrome !== 'undefined' && chrome.permissions?.request) {
            try {
              const granted = await chrome.permissions.request({ permissions: ['notifications'] });
              if (!granted) {
                notifChk.checked = false;
                Toast.warning(i18n.t('app.notif_permission_denied'));
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
          Toast.success(i18n.t('app.diag_exported'));
        } catch (err) {
          logger.error('App', 'Échec export diagnostic:', err);
          Toast.error(i18n.t('app.diag_export_failed'));
        }
      });
    }

    if (btnLogout) {
      btnLogout.addEventListener('click', async () => {
        const confirmed = await Modal.confirm(
          i18n.t('app.logout_confirm_msg'),
          i18n.t('app.logout_confirm_title'),
          { isDanger: true }
        );
        if (!confirmed) return;

        try { await dbManager.delete('settings', 'last_paper_code'); } catch (_) {}
        try { this.callController?.isInCall && this.callController.leaveCall(); } catch {}
        try { this.mesh?.stop(); } catch (_) {}
        try { this.presence?.stop(); } catch (_) {}
        try { this.crdt?.destroy(); } catch {}
        try { this.vault?.destroy(); } catch {}
        logger.clearBuffer();
        Toast.info(i18n.t('app.logout_toast'));
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
