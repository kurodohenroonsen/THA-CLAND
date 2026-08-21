/**
 * Contrôleur de Forum Thématique & Discussions Arborescentes
 * Gestion des sujets, catégories, réponses imbriquées et réplication P2P.
 */

import { CONFIG } from '../../core/config.js';
import { dbManager } from '../../core/local-storage.js';
import { Modal } from '../../ui/modal.js';
import { Toast } from '../../ui/toast.js';

export class ForumController {
  constructor(crdtEngine, cryptoVault) {
    this.crdt = crdtEngine;
    this.vault = cryptoVault;
    this.activeThreadId = null;
    this.selectedCategory = 'Tous';

    this.initUI();
    this.initListeners();
  }

  initUI() {
    this.threadsContainer = document.getElementById('forum-threads-list');
    this.threadDetailView = document.getElementById('forum-thread-detail-view');
    this.threadsListView = document.getElementById('forum-threads-view');
    this.categoryFilter = document.getElementById('forum-category-filter');
    this.btnNewThread = document.getElementById('btn-new-forum-topic');
    this.btnBackToThreads = document.getElementById('btn-back-to-threads');
    this.btnSubmitReply = document.getElementById('btn-submit-forum-reply');
    this.replyInput = document.getElementById('forum-reply-input');

    // Modale de création de sujet
    const btnSubmitTopic = document.getElementById('btn-submit-new-topic');
    if (btnSubmitTopic) {
      btnSubmitTopic.addEventListener('click', () => this.handleCreateTopic());
    }

    if (this.btnNewThread) {
      this.btnNewThread.addEventListener('click', () => {
        Modal.open('modal-new-topic');
      });
    }

    if (this.btnBackToThreads) {
      this.btnBackToThreads.addEventListener('click', () => {
        this.showThreadsList();
      });
    }

    if (this.btnSubmitReply) {
      this.btnSubmitReply.addEventListener('click', () => this.handlePostReply());
    }

    this.renderCategoriesFilter();
  }

  initListeners() {
    this.crdt.on('forum-topic-received', () => {
      this.loadThreads();
    });

    this.crdt.on('forum-reply-received', ({ threadId }) => {
      if (this.activeThreadId === threadId) {
        this.openThread(threadId);
      } else {
        this.loadThreads();
      }
    });

    this.crdt.on('forum-synced', () => {
      this.loadThreads();
    });
  }

  renderCategoriesFilter() {
    if (!this.categoryFilter) return;
    this.categoryFilter.innerHTML = '<option value="Tous">Toutes les catégories</option>';
    CONFIG.DEFAULT_FORUM_CATEGORIES.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      this.categoryFilter.appendChild(opt);
    });

    this.categoryFilter.addEventListener('change', (e) => {
      this.selectedCategory = e.target.value;
      this.loadThreads();
    });
  }

  async loadThreads() {
    if (!this.threadsContainer) return;
    const allThreads = await dbManager.getAllForumThreads();

    const filtered = this.selectedCategory === 'Tous'
      ? allThreads
      : allThreads.filter(t => t.category === this.selectedCategory);

    this.threadsContainer.innerHTML = '';

    if (filtered.length === 0) {
      this.threadsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📑</div>
          <p>Aucun sujet dans cette catégorie.</p>
          <button class="btn btn-primary" id="btn-empty-create-topic">Créer un Sujet</button>
        </div>
      `;
      const btn = this.threadsContainer.querySelector('#btn-empty-create-topic');
      if (btn) btn.addEventListener('click', () => Modal.open('modal-new-topic'));
      return;
    }

    filtered.forEach(thread => {
      const card = document.createElement('div');
      card.className = `forum-thread-card ${thread.isPinned ? 'pinned' : ''}`;
      
      const dateStr = new Date(thread.createdAt).toLocaleDateString([], { day: '2-digit', month: 'short' });
      const replyCount = thread.replies ? thread.replies.length : 0;

      card.innerHTML = `
        <div class="thread-card-header">
          <span class="badge badge-category">${this.escape(thread.category || 'Général')}</span>
          ${thread.isPinned ? '<span class="badge badge-pinned">📌 Épinglé</span>' : ''}
          <span class="thread-date">${dateStr}</span>
        </div>
        <h4 class="thread-title">${this.escape(thread.title)}</h4>
        <p class="thread-preview">${this.escape(thread.content.substring(0, 120))}${thread.content.length > 120 ? '...' : ''}</p>
        <div class="thread-card-footer">
          <span class="thread-author">Par ${this.escape(thread.authorName || 'Membre')}</span>
          <span class="thread-replies-count">💬 ${replyCount} réponse(s)</span>
        </div>
      `;

      card.addEventListener('click', () => this.openThread(thread.id));
      this.threadsContainer.appendChild(card);
    });
  }

  async openThread(threadId) {
    this.activeThreadId = threadId;
    const thread = await dbManager.get('forum_threads', threadId);
    if (!thread) return;

    if (this.threadsListView) this.threadsListView.classList.add('hidden');
    if (this.threadDetailView) this.threadDetailView.classList.remove('hidden');

    const titleEl = document.getElementById('thread-detail-title');
    const metaEl = document.getElementById('thread-detail-meta');
    const contentEl = document.getElementById('thread-detail-content');
    const repliesContainer = document.getElementById('thread-detail-replies');

    if (titleEl) titleEl.textContent = thread.title;
    if (metaEl) {
      const dateStr = new Date(thread.createdAt).toLocaleString();
      metaEl.innerHTML = `Posté par <strong>${this.escape(thread.authorName)}</strong> dans <em>${this.escape(thread.category)}</em> le ${dateStr}`;
    }
    if (contentEl) contentEl.textContent = thread.content;

    if (repliesContainer) {
      repliesContainer.innerHTML = '';
      const replies = thread.replies || [];
      if (replies.length === 0) {
        repliesContainer.innerHTML = '<div class="empty-replies">Aucune réponse pour l\'instant.</div>';
      } else {
        replies.forEach(r => {
          const row = document.createElement('div');
          row.className = 'thread-reply-item';
          const rDate = new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          row.innerHTML = `
            <div class="reply-header">
              <span class="reply-author">${this.escape(r.authorName)}</span>
              <span class="reply-time">${rDate}</span>
            </div>
            <div class="reply-content">${this.escape(r.content)}</div>
          `;
          repliesContainer.appendChild(row);
        });
      }
    }
  }

  showThreadsList() {
    this.activeThreadId = null;
    if (this.threadDetailView) this.threadDetailView.classList.add('hidden');
    if (this.threadsListView) this.threadsListView.classList.remove('hidden');
    this.loadThreads();
  }

  async handleCreateTopic() {
    const inputTitle = document.getElementById('new-topic-title');
    const selectCat = document.getElementById('new-topic-category');
    const inputContent = document.getElementById('new-topic-content');

    const title = inputTitle?.value.trim();
    const category = selectCat?.value || 'Général';
    const content = inputContent?.value.trim();

    if (!title || !content) {
      Toast.error('Veuillez remplir le titre et le contenu.');
      return;
    }

    try {
      await this.crdt.createAndBroadcastForumThread(title, category, content);
      Modal.close('modal-new-topic');
      if (inputTitle) inputTitle.value = '';
      if (inputContent) inputContent.value = '';
      Toast.success('Sujet publié sur le réseau !');
      this.loadThreads();
    } catch (e) {
      Toast.error('Erreur de publication du sujet.');
    }
  }

  async handlePostReply() {
    if (!this.replyInput || !this.activeThreadId) return;
    const text = this.replyInput.value.trim();
    if (!text) return;

    this.replyInput.value = '';

    try {
      await this.crdt.addAndBroadcastForumReply(this.activeThreadId, text);
      this.openThread(this.activeThreadId);
      Toast.success('Réponse publiée !');
    } catch (e) {
      Toast.error('Erreur lors de l\'envoi de la réponse.');
    }
  }

  escape(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  }
}
