import { logger } from '../../core/logger.js';
/**
 * Contrôleur de Chat Instantané & Salons P2P
 * Gestion des messages en direct, des canaux thématiques, des indicateurs "est en train d'écrire..." et du rendu riche.
 */

import { CONFIG } from '../../core/config.js';
import { dbManager } from '../../core/local-storage.js';
import { Toast } from '../../ui/toast.js';
import { Modal } from '../../ui/modal.js';
import { FileChunker } from '../drive/file-chunker.js';
import { SanitizerService } from '../../core/sanitizer.js';
import { titleManager } from '../../core/title-manager.js';
import { DragDropHelper } from '../../core/os-interop.js';

export class ChatController {
  constructor(crdtEngine, cryptoVault) {
    this.crdt = crdtEngine;
    this.vault = cryptoVault;
    this.activeChannelId = 'general';
    this.channels = [...CONFIG.DEFAULT_CHANNELS];

    this.isLocalTyping = false;
    this.typingDebounceTimer = null;
    this.typingPeers = new Map(); // peerId -> { name, timer }

    this.unreadCounts = new Map(); // channelId -> nb non lus
    this.isAtBottom = true;
    this.pendingNewInActive = 0;
    this.lastRenderedDate = null;

    this.EMOJIS = ['😀','😂','😍','👍','🙏','🎉','🔥','💯','✅','❌','🤔','😎','😢','😡','❤️','⚡','🚀','👀','🙌','💡','📌','🔒'];

    // --- Partage de médias dans le chat (photos, vidéos, documents) ---
    this.transferManager = null;              // gestionnaire de transfert P2P (partagé avec le Drive)
    this.mesh = null;
    this.pendingAttachments = [];             // fichiers en attente d'envoi (objets File)
    this.attachmentUrls = new Map();          // attId -> objectURL (cache d'affichage)
    this.MAX_ATTACH_BYTES = 2 * 1024 * 1024 * 1024; // 2 Go max par média
    this.AUTO_IMAGE_BYTES = 8 * 1024 * 1024;  // images < 8 Mo : chargées automatiquement

    this.initUI();
    this.initListeners();
  }

  /** Reçoit le gestionnaire de transfert P2P (une seule instance, partagée avec le Drive). */
  attachTransfer(transferManager, mesh) {
    this.transferManager = transferManager;
    this.mesh = mesh;
  }

  initUI() {
    logger.debug('Chat', '💬 Initialisation du contrôleur de chat...');
    this.messagesContainer = document.getElementById('chat-messages-list');
    this.messageInput = document.getElementById('chat-input-text');
    this.sendButton = document.getElementById('btn-chat-send');
    this.channelsList = document.getElementById('chat-channels-list');
    this.currentChannelTitle = document.getElementById('chat-current-channel-title');
    this.typingIndicator = document.getElementById('chat-typing-indicator');
    this.typingText = document.getElementById('chat-typing-text');

    // Envoi du message au clic ou sur Entrée
    if (this.sendButton) {
      this.sendButton.addEventListener('click', () => this.handleSendMessage());
    }

    if (this.messageInput) {
      this.messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.handleSendMessage();
        }
      });

      // Détection de frappe + auto-agrandissement du textarea
      this.messageInput.addEventListener('input', () => {
        this.handleUserTyping();
        this.autoGrowInput();
      });

      // Support du collage direct de captures d'écran (Cmd+V / Ctrl+V)
      this.messageInput.addEventListener('paste', (e) => {
        const items = Array.from(e.clipboardData?.items || []);
        const imgFiles = items
          .filter(it => it.kind === 'file' && it.type.startsWith('image/'))
          .map(it => it.getAsFile())
          .filter(Boolean);
        if (imgFiles.length > 0) {
          e.preventDefault();
          this.stageFiles(imgFiles);
          Toast.info(`${imgFiles.length} image(s) collée(s) depuis le presse-papier.`);
        }
      });
    }

    // Barre d'emojis
    this.emojiBar = document.getElementById('chat-emoji-bar');
    this.btnEmoji = document.getElementById('btn-emoji-toggle');
    if (this.emojiBar) {
      this.emojiBar.innerHTML = '';
      this.EMOJIS.forEach(e => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = e;
        b.addEventListener('click', () => this.insertAtCursor(e));
        this.emojiBar.appendChild(b);
      });
    }
    if (this.btnEmoji && this.emojiBar) {
      this.btnEmoji.addEventListener('click', () => this.emojiBar.classList.toggle('open'));
    }

    // Pièces jointes média
    this.attachBtn = document.getElementById('btn-attach');
    this.fileInput = document.getElementById('chat-file-input');
    this.stagedContainer = document.getElementById('chat-staged-attachments');
    if (this.attachBtn && this.fileInput) {
      this.attachBtn.addEventListener('click', () => this.fileInput.click());
      this.fileInput.addEventListener('change', (e) => {
        this.stageFiles(Array.from(e.target.files || []));
        this.fileInput.value = ''; // permet de re-sélectionner le même fichier
      });
    }

    // Pastille "nouveaux messages" + suivi du défilement
    this.jumpLatestBtn = document.getElementById('chat-jump-latest');
    this.jumpCountEl = document.getElementById('chat-jump-count');
    if (this.jumpLatestBtn) {
      this.jumpLatestBtn.addEventListener('click', () => { this.scrollToBottom(true); });
    }
    if (this.messagesContainer) {
      this.messagesContainer.addEventListener('scroll', () => {
        const el = this.messagesContainer;
        this.isAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 60;
        if (this.isAtBottom) this.hideJumpLatest();
      });

      // Délégation sécurisée pour l'ouverture des liens externes
      this.messagesContainer.addEventListener('click', (e) => {
        const link = e.target.closest('a.p2p-external-link');
        if (link && link.href) {
          e.preventDefault();
          if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
            chrome.tabs.create({ url: link.href, active: true });
          } else {
            window.open(link.href, '_blank', 'noopener,noreferrer');
          }
        }
      });
    }

    this.renderChannels();
  }

  autoGrowInput() {
    const el = this.messageInput;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(140, el.scrollHeight) + 'px';
  }

  insertAtCursor(text) {
    const el = this.messageInput;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.focus();
    const pos = start + text.length;
    el.setSelectionRange(pos, pos);
    this.autoGrowInput();
    this.handleUserTyping();
  }

  showJumpLatest(count) {
    if (!this.jumpLatestBtn) return;
    this.jumpLatestBtn.classList.remove('hidden');
    if (this.jumpCountEl) {
      this.jumpCountEl.textContent = count > 0 ? `${count} nouveau${count > 1 ? 'x' : ''} message${count > 1 ? 's' : ''}` : 'Nouveaux messages';
    }
  }

  hideJumpLatest() {
    this.pendingNewInActive = 0;
    if (this.jumpLatestBtn) this.jumpLatestBtn.classList.add('hidden');
  }

  initListeners() {
    // 1. Réception d'un message en temps réel via CRDT
    this.crdt.on('chat-message-received', (msg) => {
      logger.info('Chat', `💬 Nouveau message reçu dans #${msg.channelId} de ${msg.authorName}`);
      
      // Si l'auteur écrivait, on retire son indicateur de frappe
      if (this.typingPeers.has(msg.authorId)) {
        const p = this.typingPeers.get(msg.authorId);
        if (p.timer) clearTimeout(p.timer);
        this.typingPeers.delete(msg.authorId);
        this.updateTypingIndicatorUI();
      }

      const isSelf = msg.authorId === this.vault.peerId || msg.authorPubkey === this.vault.publicKeyHex;

      if (msg.channelId === this.activeChannelId) {
        // Supprime l'état vide si présent
        const emptyState = this.messagesContainer?.querySelector('.empty-chat-state');
        if (emptyState) emptyState.remove();

        this.appendMessageElement(msg);
        if (this.isAtBottom || isSelf) {
          this.scrollToBottom();
        } else {
          // L'utilisateur lit plus haut : on l'informe sans le déranger.
          this.pendingNewInActive++;
          this.showJumpLatest(this.pendingNewInActive);
        }
      } else {
        // Canal inactif : incrémente le compteur de non-lus + badge.
        this.incrementUnread(msg.channelId);
        Toast.info(`Nouveau message de ${msg.authorName} dans #${msg.channelId}`);
      }

      // Notification bureau si activée et fenêtre non visible (hors nos propres messages).
      if (!isSelf) this.maybeDesktopNotify(msg);
    });

    // 2. Réception du signal "est en train d'écrire..."
    this.crdt.on('typing-signal', (signal) => {
      if (signal.channelId !== this.activeChannelId) return;
      if (signal.authorId === this.vault.peerId) return; // Ignore nos propres signaux

      if (signal.isTyping) {
        const existing = this.typingPeers.get(signal.authorId);
        if (existing?.timer) clearTimeout(existing.timer);

        this.typingPeers.set(signal.authorId, {
          name: signal.authorName || 'Un membre',
          timer: setTimeout(() => {
            this.typingPeers.delete(signal.authorId);
            this.updateTypingIndicatorUI();
          }, 3500)
        });
      } else {
        const existing = this.typingPeers.get(signal.authorId);
        if (existing?.timer) clearTimeout(existing.timer);
        this.typingPeers.delete(signal.authorId);
      }

      this.updateTypingIndicatorUI();
    });

    // 3. Synchronisation par lot après reconnexion
    this.crdt.on('chat-synced', () => {
      logger.info('Chat', '🔄 Synchronisation du salon actif suite au rattrapage CRDT...');
      this.loadChannelMessages(this.activeChannelId);
    });
  }

  handleUserTyping() {
    const text = this.messageInput?.value || '';
    if (text.length > 0) {
      if (!this.isLocalTyping) {
        this.isLocalTyping = true;
        this.crdt.sendTypingSignal(this.activeChannelId, true);
      }

      if (this.typingDebounceTimer) clearTimeout(this.typingDebounceTimer);
      this.typingDebounceTimer = setTimeout(() => {
        this.isLocalTyping = false;
        this.crdt.sendTypingSignal(this.activeChannelId, false);
      }, 2500);
    } else {
      if (this.isLocalTyping) {
        this.isLocalTyping = false;
        if (this.typingDebounceTimer) clearTimeout(this.typingDebounceTimer);
        this.crdt.sendTypingSignal(this.activeChannelId, false);
      }
    }
  }

  updateTypingIndicatorUI() {
    if (!this.typingIndicator || !this.typingText) return;

    const count = this.typingPeers.size;
    if (count === 0) {
      this.typingIndicator.classList.add('hidden');
    } else if (count === 1) {
      const [peer] = this.typingPeers.values();
      this.typingText.textContent = `${peer.name} est en train d'écrire...`;
      this.typingIndicator.classList.remove('hidden');
    } else if (count === 2) {
      const names = Array.from(this.typingPeers.values()).map(p => p.name);
      this.typingText.textContent = `${names.join(' et ')} sont en train d'écrire...`;
      this.typingIndicator.classList.remove('hidden');
    } else {
      this.typingText.textContent = `Plusieurs membres sont en train d'écrire...`;
      this.typingIndicator.classList.remove('hidden');
    }
  }

  renderChannels() {
    if (!this.channelsList) return;
    this.channelsList.innerHTML = '';

    this.channels.forEach((ch) => {
      const btn = document.createElement('button');
      btn.className = `channel-item ${ch.id === this.activeChannelId ? 'active' : ''}`;
      btn.dataset.channelId = ch.id;
      const unread = this.unreadCounts.get(ch.id) || 0;
      const badge = unread > 0 ? `<span class="channel-unread">${unread > 99 ? '99+' : unread}</span>` : '';
      btn.innerHTML = `<span class="channel-hash">#</span> <span class="channel-name">${this.escapeHTML(ch.name)}</span>${badge}`;
      btn.addEventListener('click', () => {
        this.switchChannel(ch.id, ch.name);
      });
      this.channelsList.appendChild(btn);
    });
  }

  incrementUnread(channelId) {
    this.unreadCounts.set(channelId, (this.unreadCounts.get(channelId) || 0) + 1);
    this.updateChannelBadge(channelId);
  }

  markActiveChannelRead() {
    if (this.unreadCounts.get(this.activeChannelId)) {
      this.unreadCounts.set(this.activeChannelId, 0);
      this.updateChannelBadge(this.activeChannelId);
    }
  }

  updateChannelBadge(channelId) {
    const btn = this.channelsList?.querySelector(`[data-channel-id="${channelId}"]`);
    if (btn) {
      let badge = btn.querySelector('.channel-unread');
      const count = this.unreadCounts.get(channelId) || 0;
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'channel-unread';
          btn.appendChild(badge);
        }
        badge.textContent = count > 99 ? '99+' : String(count);
      } else if (badge) {
        badge.remove();
      }
    }

    // Synchronisation de l'App Badging et de l'indicateur d'onglet
    const totalUnread = Array.from(this.unreadCounts.values()).reduce((sum, n) => sum + (n || 0), 0);
    titleManager.setUnreadCount(totalUnread);
  }

  maybeDesktopNotify(msg) {
    try {
      const isWindowHidden = typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
      const isOtherChannel = msg.channelId !== this.activeChannelId;
      if (!isWindowHidden && !isOtherChannel) return;

      dbManager.getSetting('notifications_enabled', false).then((enabled) => {
        if (!enabled) return;
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({
            type: 'SHOW_NOTIFICATION',
            id: `p2p_channel_${msg.channelId}`,
            title: `💬 ${msg.authorName || 'Nouveau message'} • #${msg.channelId}`,
            body: (msg.text || '').substring(0, 120),
            priority: 1
          }).catch(() => {});
        }
      });
    } catch (err) {
      logger.warn('Chat', 'Échec envoi notification bureau:', err);
    }
  }

  async switchChannel(channelId, channelName) {
    this.activeChannelId = channelId;
    this.typingPeers.clear();
    this.updateTypingIndicatorUI();
    this.hideJumpLatest();
    this.markActiveChannelRead();

    if (this.currentChannelTitle) {
      this.currentChannelTitle.textContent = `# ${channelName}`;
    }

    const buttons = this.channelsList?.querySelectorAll('.channel-item');
    if (buttons) {
      buttons.forEach(b => b.classList.remove('active'));
      const targetBtn = Array.from(buttons).find(b => b.textContent.includes(channelName));
      if (targetBtn) targetBtn.classList.add('active');
    }

    await this.loadChannelMessages(channelId);
  }

  async loadChannelMessages(channelId) {
    if (!this.messagesContainer) return;
    this.messagesContainer.innerHTML = '<div class="loading-state">Chargement des messages...</div>';

    // Libère les URLs média de la vue précédente (les blocs restent en cache local,
    // le ré-affichage est donc immédiat sans re-télécharger le réseau).
    for (const url of this.attachmentUrls.values()) { try { URL.revokeObjectURL(url); } catch (e) { logger.debug('Chat', 'Erreur revokeObjectURL:', e); } }
    this.attachmentUrls.clear();

    const messages = await dbManager.getMessagesByChannel(channelId);
    this.messagesContainer.innerHTML = '';
    this.lastRenderedDate = null;

    if (messages.length === 0) {
      this.messagesContainer.innerHTML = `
        <div class="empty-chat-state">
          <div class="empty-chat-icon">💬</div>
          <p>Aucun message dans ce salon.</p>
          <small>Soyez le premier à engager la conversation !</small>
        </div>
      `;
      return;
    }

    messages.forEach(msg => this.appendMessageElement(msg));
    this.scrollToBottom();
    this.isAtBottom = true;
    this.hideJumpLatest();
  }

  /** Insère un séparateur de jour si la date du message diffère du précédent. */
  maybeInsertDaySeparator(timestamp) {
    if (!this.messagesContainer) return;
    const d = new Date(timestamp || Date.now());
    const key = d.toDateString();
    if (key === this.lastRenderedDate) return;
    this.lastRenderedDate = key;

    const today = new Date().toDateString();
    const yst = new Date(Date.now() - 86400000).toDateString();
    let label;
    if (key === today) label = "Aujourd'hui";
    else if (key === yst) label = 'Hier';
    else label = d.toLocaleDateString([], { weekday: 'long', day: '2-digit', month: 'long' });

    const sep = document.createElement('div');
    sep.className = 'chat-day-sep';
    sep.textContent = label;
    this.messagesContainer.appendChild(sep);
  }

  // ================= MÉDIAS DANS LE CHAT =================

  static formatBytes(b) {
    if (!b) return '0 o';
    const k = 1024, u = ['o', 'Ko', 'Mo', 'Go', 'To'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${u[i]}`;
  }

  static kindOf(mime = '') {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'file';
  }

  static iconFor(mime = '', name = '') {
    const k = ChatController.kindOf(mime);
    if (k === 'image') return '🖼️';
    if (k === 'video') return '🎬';
    if (k === 'audio') return '🎵';
    if (/pdf$/i.test(mime) || /\.pdf$/i.test(name)) return '📕';
    if (/word|\.docx?$/i.test(mime + name)) return '📘';
    if (/sheet|excel|\.xlsx?$/i.test(mime + name)) return '📗';
    if (/zip|compress/i.test(mime)) return '🗜️';
    return '📄';
  }

  /** Ajoute des fichiers à la file d'attente d'envoi et affiche les vignettes. */
  stageFiles(files) {
    for (const f of files) {
      if (f.size > this.MAX_ATTACH_BYTES) {
        Toast.warning(`« ${f.name} » dépasse ${ChatController.formatBytes(this.MAX_ATTACH_BYTES)} et a été ignoré.`);
        continue;
      }
      this.pendingAttachments.push(f);
    }
    this.renderStaged();
  }

  renderStaged() {
    if (!this.stagedContainer) return;
    this.stagedContainer.innerHTML = '';
    if (this.pendingAttachments.length === 0) {
      this.stagedContainer.classList.add('hidden');
      return;
    }
    this.stagedContainer.classList.remove('hidden');
    this.pendingAttachments.forEach((f, idx) => {
      const chip = document.createElement('div');
      chip.className = 'staged-chip';
      const isImg = f.type.startsWith('image/');
      const thumb = isImg
        ? `<img class="staged-thumb" src="${URL.createObjectURL(f)}" alt=""/>`
        : `<span class="staged-icon">${ChatController.iconFor(f.type, f.name)}</span>`;
      chip.innerHTML = `${thumb}
        <div class="staged-meta">
          <div class="staged-name truncate">${this.escapeHTML(f.name)}</div>
          <div class="staged-size">${ChatController.formatBytes(f.size)}</div>
        </div>
        <button class="staged-remove" title="Retirer" data-idx="${idx}">×</button>`;
      chip.querySelector('.staged-remove').addEventListener('click', () => {
        this.pendingAttachments.splice(idx, 1);
        this.renderStaged();
      });
      this.stagedContainer.appendChild(chip);
    });
  }

  /** Découpe les fichiers joints en blocs P2P et renvoie leurs descripteurs (manifestes). */
  async buildAttachmentDescriptors() {
    const descriptors = [];
    for (const f of this.pendingAttachments) {
      const manifest = await FileChunker.processFile(f); // stocke + ensemence les blocs localement
      const rand = Math.random().toString(36).slice(2, 8);
      descriptors.push({
        fileId: `att_${(manifest.rootMerkleHash || '').substr(0, 12)}_${rand}`,
        fileName: manifest.fileName,
        mimeType: manifest.mimeType,
        fileSize: manifest.fileSize,
        totalChunks: manifest.totalChunks,
        rootMerkleHash: manifest.rootMerkleHash,
        chunks: manifest.chunks
      });
    }
    return descriptors;
  }

  async handleSendMessage() {
    if (!this.messageInput) return;
    const text = this.messageInput.value.trim();
    const hasAttachments = this.pendingAttachments.length > 0;
    if (!text && !hasAttachments) return;

    // Arrête le statut de frappe
    if (this.isLocalTyping) {
      this.isLocalTyping = false;
      if (this.typingDebounceTimer) clearTimeout(this.typingDebounceTimer);
      this.crdt.sendTypingSignal(this.activeChannelId, false);
    }

    let attachments = [];
    if (hasAttachments) {
      if (this.attachBtn) this.attachBtn.disabled = true;
      Toast.info(`Préparation de ${this.pendingAttachments.length} média(s)…`);
      try {
        attachments = await this.buildAttachmentDescriptors();
      } catch (err) {
        logger.error('Chat', 'Découpage média échoué:', err);
        Toast.error("Impossible de préparer le média.");
        if (this.attachBtn) this.attachBtn.disabled = false;
        return;
      }
      if (this.attachBtn) this.attachBtn.disabled = false;
    }

    // Vide l'UI de saisie
    this.messageInput.value = '';
    this.autoGrowInput();
    if (this.emojiBar) this.emojiBar.classList.remove('open');
    this.pendingAttachments = [];
    this.renderStaged();

    try {
      logger.info('Chat', `📤 Envoi message dans #${this.activeChannelId} (${attachments.length} pièce(s) jointe(s))`);
      const msg = await this.crdt.createChatMessage(this.activeChannelId, text, attachments);

      const emptyState = this.messagesContainer?.querySelector('.empty-chat-state');
      if (emptyState) emptyState.remove();

      this.appendMessageElement(msg);
      this.scrollToBottom();
    } catch (err) {
      logger.error('Chat', 'Erreur envoi message:', err);
      Toast.error("Impossible d'envoyer le message.");
    }
  }

  appendMessageElement(msg) {
    if (!this.messagesContainer) return;

    this.maybeInsertDaySeparator(msg.timestamp);

    const isSelf = msg.authorPubkey === this.vault.publicKeyHex || msg.authorId === this.vault.peerId;
    const msgEl = document.createElement('div');
    msgEl.className = `chat-bubble-row ${isSelf ? 'is-self' : 'is-remote'}`;

    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const contentText = msg.text || msg.content || '';

    const hasText = !!contentText;
    msgEl.innerHTML = `
      <div class="chat-bubble">
        <div class="chat-bubble-header">
          <span class="chat-author-name">${this.escapeHTML(msg.authorName || 'Membre')}</span>
          <span class="chat-timestamp">${timeStr}</span>
        </div>
        ${hasText ? `<div class="chat-bubble-content">${this.formatMessageText(contentText)}</div>` : ''}
        <div class="chat-attachments"></div>
      </div>
    `;

    const holder = msgEl.querySelector('.chat-attachments');
    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    if (atts.length === 0) holder.remove();
    else atts.forEach(att => this.renderAttachment(att, holder));

    this.messagesContainer.appendChild(msgEl);
  }

  /** Construit l'élément d'une pièce jointe et déclenche son chargement P2P. */
  renderAttachment(att, holder) {
    if (!att || !Array.isArray(att.chunks)) return;
    const kind = ChatController.kindOf(att.mimeType);
    const box = document.createElement('div');
    box.className = `chat-att chat-att-${kind}`;

    // Média déjà chargé (cache) : on l'affiche directement.
    const cachedUrl = this.attachmentUrls.get(att.fileId);

    if (kind === 'image') {
      box.innerHTML = `<div class="att-media-wrap"><div class="att-loading"><span class="spinner-sm"></span> Chargement…</div></div>
        <div class="att-caption">${this.escapeHTML(att.fileName)} · ${ChatController.formatBytes(att.fileSize)}</div>`;
      const auto = (att.fileSize || 0) <= this.AUTO_IMAGE_BYTES;
      if (cachedUrl) this._fillImage(box, cachedUrl, att);
      else if (auto) this.loadAttachment(att, box, 'image');
      else this._makeLoadButton(box, att, 'image', '🖼️ Afficher l\'image');
    } else if (kind === 'video') {
      box.innerHTML = `<div class="att-media-wrap"></div>
        <div class="att-caption">🎬 ${this.escapeHTML(att.fileName)} · ${ChatController.formatBytes(att.fileSize)}</div>`;
      if (cachedUrl) this._fillVideo(box, cachedUrl);
      else this._makeLoadButton(box, att, 'video', '▶️ Charger la vidéo');
    } else if (kind === 'audio') {
      box.innerHTML = `<div class="att-media-wrap"></div>
        <div class="att-caption">🎵 ${this.escapeHTML(att.fileName)} · ${ChatController.formatBytes(att.fileSize)}</div>`;
      if (cachedUrl) this._fillAudio(box, cachedUrl);
      else this._makeLoadButton(box, att, 'audio', '🎵 Écouter');
    } else {
      box.innerHTML = `
        <div class="att-file">
          <span class="att-file-icon">${ChatController.iconFor(att.mimeType, att.fileName)}</span>
          <div class="att-file-meta">
            <div class="att-file-name truncate">${this.escapeHTML(att.fileName)}</div>
            <div class="att-file-size">${ChatController.formatBytes(att.fileSize)}</div>
          </div>
        </div>`;
      this._makeLoadButton(box, att, 'file', '⬇️ Télécharger', true);
    }

    holder.appendChild(box);
  }

  _makeLoadButton(box, att, kind, label, isFileRow = false) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-xs att-load-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => this.loadAttachment(att, box, kind, btn));
    if (isFileRow) box.querySelector('.att-file').appendChild(btn);
    else box.appendChild(btn);
  }

  async loadAttachment(att, box, kind, btn = null) {
    if (!this.transferManager) { Toast.error('Transfert P2P indisponible.'); return; }
    const wrap = box.querySelector('.att-media-wrap');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-sm"></span> Réception…'; }
    else if (wrap) wrap.innerHTML = '<div class="att-loading"><span class="spinner-sm"></span> Réception P2P…</div>';

    try {
      let url = this.attachmentUrls.get(att.fileId);
      if (!url) {
        const blob = await this.transferManager.downloadFile(att, () => {});
        url = URL.createObjectURL(blob);
        this.attachmentUrls.set(att.fileId, url);
      }
      if (kind === 'image') this._fillImage(box, url, att);
      else if (kind === 'video') this._fillVideo(box, url);
      else if (kind === 'audio') this._fillAudio(box, url);
      else this._triggerDownload(url, att.fileName, btn);
    } catch (err) {
      logger.error('Chat', 'Réception média échouée:', err);
      Toast.error(`Média « ${att.fileName} » indisponible (aucune source ?).`);
      if (btn) { btn.disabled = false; btn.textContent = '↻ Réessayer'; }
      else if (wrap) wrap.innerHTML = '<div class="att-loading att-error">⚠️ Échec — appuyez pour réessayer</div>';
      if (wrap) wrap.querySelector('.att-error')?.addEventListener('click', () => this.loadAttachment(att, box, kind));
    }
  }

  _fillImage(box, url, att) {
    const wrap = box.querySelector('.att-media-wrap');
    if (wrap) wrap.innerHTML = `<img class="att-image" src="${url}" alt="${this.escapeHTML(att.fileName)}" loading="lazy"/>`;
    const img = wrap && wrap.querySelector('img');
    if (img) {
      img.addEventListener('load', () => this.scrollToBottomIfNear());
      img.addEventListener('click', () => this._openImagePreview(url, att.fileName));
    }
  }

  _fillVideo(box, url) {
    const wrap = box.querySelector('.att-media-wrap');
    if (wrap) wrap.innerHTML = `<video class="att-video" src="${url}" controls playsinline preload="metadata"></video>`;
  }

  _fillAudio(box, url) {
    const wrap = box.querySelector('.att-media-wrap');
    if (wrap) wrap.innerHTML = `<audio class="att-audio" src="${url}" controls preload="metadata"></audio>`;
  }

  _triggerDownload(url, fileName, btn) {
    const a = document.createElement('a');
    a.href = url; a.download = fileName || 'fichier';
    document.body.appendChild(a); a.click(); a.remove();
    if (btn) { btn.disabled = false; btn.textContent = '✓ Enregistré'; }
  }

  _openImagePreview(url, name) {
    const img = document.getElementById('preview-image');
    const title = document.getElementById('preview-title');
    if (img) img.src = url;
    if (title) title.textContent = name || 'Aperçu';
    Modal.open('modal-preview');
  }

  scrollToBottomIfNear() {
    if (this.isAtBottom) this.scrollToBottom();
  }

  formatMessageText(text) {
    return SanitizerService.formatSafeChatMessage(text);
  }

  escapeHTML(str) {
    return SanitizerService.escape(str);
  }

  scrollToBottom(force = false) {
    if (this.messagesContainer) {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
      this.isAtBottom = true;
      if (force) this.hideJumpLatest();
    }
  }
}
