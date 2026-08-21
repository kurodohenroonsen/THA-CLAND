/**
 * Application Principale - P2P Mesh Workspace (Chrome Side Panel & Web App PWA)
 * Orchestration globale des modules, navigation par onglets, diagnostic et gestion des statuts.
 */

import { logger } from './core/logger.js';
import { CryptoVault } from './core/crypto-vault.js';
import { dbManager } from './core/local-storage.js';
import { P2PMeshNetwork } from './core/p2p-mesh.js';
import { PresenceManager } from './core/presence.js';
import { CRDTEngine } from './core/crdt-engine.js';
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
  }

  async init() {
    // 0. Vérification du contexte sécurisé (HTTPS / localhost requis pour WebCrypto & WebRTC)
    if (typeof window !== 'undefined' && (!window.isSecureContext || !window.crypto?.subtle)) {
      console.error('[App] Arrêt critique : Contexte non sécurisé (HTTP). WebCrypto et WebRTC indisponibles.');
      alert('Contexte non sécurisé : P2P Mesh requiert HTTPS ou localhost pour exécuter les opérations cryptographiques.');
      return;
    }

    // Installation des gestionnaires d'évacuation matérielle (Anti-Leak micro/caméra)
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

    // Installation des gestionnaires d'erreurs globaux
    logger.installGlobalHandlers();
    logger.info('App', '🌟 Démarrage de P2P Mesh Workspace...');

    // 1. Initialisation du stockage persistant IndexedDB & OPFS
    logger.debug('App', '📦 Étape 1 : Initialisation de la base locale IndexedDB & OPFS...');
    await dbManager.init();

    // 2. Configuration des modales
    logger.debug('App', '🪟 Étape 2 : Configuration des déclencheurs de modales...');
    Modal.setupCloseTriggers();

    // 3. Initialisation de l'authentification
    logger.debug('App', '🔑 Étape 3 : Initialisation du contrôleur d\'authentification...');
    this.authController = new AuthController(this.vault, (initializedVault) => {
      this.handleUserAuthenticated(initializedVault);
    });

    // 4. Vérification de session enregistrée
    logger.debug('App', '💾 Étape 4 : Vérification de session persistante...');
    await this.authController.checkSavedSession();

    // 5. Configuration des onglets de navigation
    logger.debug('App', '🧭 Étape 5 : Configuration de la navigation par onglets...');
    this.initNavigation();

    logger.info('App', '✅ Initialisation terminée avec succès. Prêt pour l\'authentification.');
  }

  async handleUserAuthenticated(vault) {
    logger.info('App', '🚀 Utilisateur authentifié ! Démarrage des sous-systèmes P2P...');

    // Masquage de l'écran d'onboarding et affichage de l'interface principale
    const authView = document.getElementById('view-auth');
    const mainView = document.getElementById('view-main-app');
    if (authView) authView.classList.add('hidden');
    if (mainView) mainView.classList.remove('hidden');

    // Mise à jour de l'en-tête
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
    logger.debug('App', '💬 Initialisation ChatController, ForumController, DriveController, CallController...');
    this.chatController = new ChatController(this.crdt, vault);
    this.forumController = new ForumController(this.crdt, vault);
    this.driveController = new DriveController(this.crdt, this.mesh, vault);
    this.callController = new CallController(this.mesh, this.presence, vault);

    // Le chat réutilise le MÊME gestionnaire de transfert P2P que le Drive (une
    // seule instance sert/écoute les blocs) pour envoyer/recevoir les médias joints.
    this.chatController.attachTransfer(this.driveController.transferManager, this.mesh);

    // 5. Écouteurs de statut réseau et présence
    this.initStatusListeners();

    // 6. Lancement du réseau et signalement
    logger.info('App', '📡 Lancement de la connexion P2P Mesh...');
    await this.mesh.start();

    // 5b. Panneau de réglages / profil & diagnostic
    this.setupSettingsPanel(vault);
    const gear = document.getElementById('btn-open-settings');
    if (gear) gear.classList.remove('hidden');

    // 7. Chargement initial des données
    logger.debug('App', '📂 Chargement initial des données locales...');
    await this.chatController.loadChannelMessages('general');
    await this.forumController.loadThreads();
    await this.driveController.loadFiles();

    // 7b. Restauration du dernier onglet actif
    try {
      const lastTab = await dbManager.getSetting('active_tab', 'chat');
      if (lastTab && lastTab !== 'chat') this.switchTab(lastTab);
    } catch (e) {
      logger.debug('App', 'Erreur restauration active_tab:', e);
    }

    // 8. Initialisation de l'Offscreen Document pour le maintien WebRTC (Extension Chrome)
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        logger.debug('App', '📴 Demande d\'initialisation du document Offscreen au Service Worker...');
        chrome.runtime.sendMessage({ type: 'INIT_OFFSCREEN' });
      }
    } catch (err) {
      logger.debug('App', 'Offscreen document non requis ou non supporté sur cette plateforme:', err);
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

      // Mise à jour du badge de l'icône de l'extension
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', peersCount: peersCount || 0 });
        }
      } catch (e) {
        logger.debug('App', 'Erreur mise à jour badge icône:', e);
      }
    });

    this.presence.onPresenceUpdate((peerList) => {
      this.renderPeersRoster(peerList);

      // Calcul eMOS ITU-T G.107 multi-critères (RTT + Jitter + Perte)
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

    // Écouteurs de résilience réseau et cycle de vie
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
    // Persiste l'onglet actif (restauré au prochain démarrage).
    try {
      dbManager.saveSetting('active_tab', tabName);
    } catch (e) {
      logger.debug('App', 'Erreur sauvegarde active_tab:', e);
    }
    // Réinitialise le compteur de non-lus du chat en revenant dessus.
    if (tabName === 'chat' && this.chatController) this.chatController.markActiveChannelRead();

    // Mise à jour des boutons de navigation
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
      const isTarget = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('active', isTarget);
      btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
      btn.setAttribute('tabindex', isTarget ? '0' : '-1'); // Roving tabindex
    });

    // Affichage de la vue correspondante
    document.querySelectorAll('.view-section').forEach(view => {
      if (view.id === `tab-view-${tabName}`) {
        view.classList.remove('hidden');
      } else {
        view.classList.add('hidden');
      }
    });

    // Rafraîchissement spécifique lors du changement d'onglet
    if (tabName === 'forum' && this.forumController) {
      this.forumController.loadThreads();
    } else if (tabName === 'drive' && this.driveController) {
      this.driveController.loadFiles();
      this.refreshStorageUI();
    } else if (tabName === 'media' && this.callController) {
      // Affiche le lobby (liste des membres) dès l'ouverture de l'onglet Salons.
      this.callController.updateVideoGrid();
    }
  }

  renderPeersRoster(peerList) {
    const container = document.getElementById('peers-roster-list');
    if (!container) return;

    container.innerHTML = '';

    // Ajout de notre profil local
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

  /**
   * Configure le panneau de réglages / profil & diagnostic (en-tête ⚙️).
   */
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

    const flashCopy = async (btn, text) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        logger.warn('App', 'Presse-papier non accessible:', err);
      }
      const o = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('copied-flash');
      setTimeout(() => { btn.textContent = o; btn.classList.remove('copied-flash'); }, 1400);
    };

    const openSettings = async () => {
      if (nameInput) nameInput.value = vault.userName || '';
      if (idNameEl) idNameEl.textContent = vault.userName || 'Membre P2P';
      if (topicEl) topicEl.textContent = `${vault.topicHex.substring(0, 16)}…`;
      if (fpEl) fpEl.textContent = vault.peerIdHex ? vault.peerIdHex.substring(0, 16) : '—';
      if (avatarEl && this.presence) avatarEl.src = this.presence.generateAvatar(vault.peerId);
      // Code papier sécurisé Zero-Trace
      if (paperEl) {
        paperEl.dataset.code = '';
        paperEl.textContent = '🔒 Masqué (Zéro-Trace RAM)';
      }
      if (notifChk) notifChk.checked = await dbManager.getSetting('notifications_enabled', false);

      // Diagnostic & logging config
      if (logSelect) {
        try {
          const lvl = localStorage.getItem('pmesh.loglevel') || 'INFO';
          logSelect.value = lvl.toUpperCase();
        } catch (e) {
          logger.debug('App', 'Erreur lecture pmesh.loglevel:', e);
        }
      }
      if (debugInput) {
        try {
          debugInput.value = localStorage.getItem('pmesh.debug') || '';
        } catch (e) {
          logger.debug('App', 'Erreur lecture pmesh.debug:', e);
        }
      }

      await this.refreshStorageUI();
      Modal.open('modal-settings');
    };

    if (gear) gear.addEventListener('click', openSettings);

    if (btnSaveName && nameInput) {
      btnSaveName.addEventListener('click', async () => {
        const newName = nameInput.value.trim();
        if (!newName) { Toast.warning('Le pseudonyme ne peut pas être vide.'); return; }
        vault.userName = newName;
        await dbManager.saveSetting('user_name', newName);
        if (idNameEl) idNameEl.textContent = newName;
        // Informe les pairs du nouveau nom (mise à jour du roster).
        try {
          this.mesh.broadcast({ type: 'PEER_HELLO', name: newName, pubkey: vault.publicKeyHex });
        } catch (err) {
          logger.warn('App', 'Échec diffusion PEER_HELLO lors du changement de nom:', err);
        }
        Toast.success('Pseudonyme mis à jour.');
      });
    }

    if (btnCopyTopic) btnCopyTopic.addEventListener('click', () => flashCopy(btnCopyTopic, vault.topicHex));
    if (btnCopyPaper && paperEl) btnCopyPaper.addEventListener('click', () => flashCopy(btnCopyPaper, paperEl.dataset.code || ''));

    if (notifChk) {
      notifChk.addEventListener('change', async () => {
        if (notifChk.checked && 'Notification' in window && Notification.permission === 'default') {
          try {
            await Notification.requestPermission();
          } catch (err) {
            logger.warn('App', 'Demande de permission notification refusée:', err);
          }
        }
        await dbManager.saveSetting('notifications_enabled', notifChk.checked);
      });
    }

    if (logSelect) {
      logSelect.addEventListener('change', () => {
        try {
          localStorage.setItem('pmesh.loglevel', logSelect.value);
          logger.info('App', `Niveau de log défini sur: ${logSelect.value}`);
          Toast.info(`Niveau de journalisation : ${logSelect.value}`);
        } catch (e) {
          logger.warn('App', 'Impossible de sauvegarder pmesh.loglevel:', e);
        }
      });
    }

    if (debugInput) {
      debugInput.addEventListener('change', () => {
        try {
          const val = debugInput.value.trim();
          if (val) localStorage.setItem('pmesh.debug', val);
          else localStorage.removeItem('pmesh.debug');
          logger.info('App', `Filtre debug mis à jour: ${val || 'aucun'}`);
          Toast.info('Filtres de débogage mis à jour.');
        } catch (e) {
          logger.warn('App', 'Impossible de sauvegarder pmesh.debug:', e);
        }
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
          Toast.success('Rapport de diagnostic exporté avec succès !');
        } catch (err) {
          logger.error('App', 'Échec de l\'export du diagnostic:', err);
          Toast.error('Impossible d\'exporter le rapport de diagnostic.');
        }
      });
    }

    if (btnLogout) {
      btnLogout.addEventListener('click', async () => {
        if (!confirm('Se déconnecter et effacer la session locale (le code papier restera nécessaire pour revenir) ?')) return;
        try { await dbManager.delete('settings', 'last_paper_code'); } catch (e) { logger.warn('App', 'Erreur suppression session locale:', e); }
        try { this.callController && this.callController.isInCall && this.callController.leaveCall(); } catch {}
        try { this.mesh && this.mesh.stop(); } catch (e) { logger.warn('App', 'Erreur arrêt mesh:', e); }
        try { this.presence && this.presence.stop(); } catch (e) { logger.warn('App', 'Erreur arrêt presence:', e); }
        try { this.crdt && this.crdt.destroy(); } catch {}
        try { this.vault && this.vault.destroy(); } catch {}
        logger.clearBuffer();
        Toast.info('Déconnexion…');
        setTimeout(() => location.reload(), 500);
      });
    }
  }

  /**
   * Rafraîchit les jauges de stockage (réglages + drive).
   */
  async refreshStorageUI() {
    const est = await dbManager.estimateStorage();
    const fmt = (b) => {
      if (!b) return '0 o';
      const k = 1024, u = ['o', 'Ko', 'Mo', 'Go', 'To'];
      const i = Math.floor(Math.log(b) / Math.log(k));
      return `${(b / Math.pow(k, i)).toFixed(1)} ${u[i]}`;
    };
    const isPersisted = await dbManager.isPersisted();
    const persBadge = isPersisted ? ' 🔒 (Persistant)' : ' ⚠️ (Évictable)';
    const label = est.quota ? `${fmt(est.usage)} / ${fmt(est.quota)} (${est.percent}%)${persBadge}` : `${fmt(est.usage)}${persBadge}`;
    const pct = est.quota ? est.percent : 0;
    const setBar = (barId, txtId) => {
      const bar = document.getElementById(barId), txt = document.getElementById(txtId);
      if (bar) { bar.style.width = `${Math.min(100, pct)}%`; bar.style.background = pct > 85 ? 'var(--accent-rose)' : ''; }
      if (txt) txt.textContent = label;
    };
    setBar('settings-storage-bar', 'settings-storage-text');
    setBar('drive-storage-bar', 'drive-storage-text');
  }

  escape(str) {
    return SanitizerService.escape(str);
  }
}

// Initialisation globale
document.addEventListener('DOMContentLoaded', () => {
  const app = new P2PApp();
  app.init().catch(err => logger.error('App', '❌ Erreur fatale au démarrage:', err));
});
