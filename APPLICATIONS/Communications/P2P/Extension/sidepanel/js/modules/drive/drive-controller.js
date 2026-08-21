import { logger } from '../../core/logger.js';
/**
 * Contrôleur du Drive Partagé P2P, Hiérarchie de Dossiers & Versioning
 * Gestion de l'explorateur arborescent (dossiers/sous-dossiers), fil d'Ariane, téléversement par découpage, historique des commits et téléchargement en essaim.
 */

import { FileChunker } from './file-chunker.js';
import { VersioningDAG } from './versioning-dag.js';
import { DriveTransferManager } from './drive-transfer.js';
import { Modal } from '../../ui/modal.js';
import { Toast } from '../../ui/toast.js';
import { CONFIG } from '../../core/config.js';
import { dbManager } from '../../core/local-storage.js';

export class DriveController {
  constructor(crdtEngine, meshNetwork, cryptoVault) {
    this.crdt = crdtEngine;
    this.mesh = meshNetwork;
    this.vault = cryptoVault;
    this.transferManager = new DriveTransferManager(meshNetwork);
    this.activeHistoryFileId = null;
    this.currentPath = '/';

    this.initUI();
    this.initListeners();
  }

  initUI() {
    logger.debug('Drive', '📁 Initialisation de l\'interface du Drive partagé avec arborescence...');
    this.breadcrumbsContainer = document.getElementById('drive-breadcrumbs');
    this.foldersListContainer = document.getElementById('drive-folders-list');
    this.filesListContainer = document.getElementById('drive-files-list');
    this.dropZone = document.getElementById('drive-drop-zone');
    this.fileInput = document.getElementById('drive-file-input');
    this.uploadProgressBar = document.getElementById('drive-upload-progress');
    this.uploadProgressContainer = document.getElementById('drive-upload-progress-container');
    this.btnCreateFolder = document.getElementById('btn-create-folder');

    // Clic sur la zone de dépôt pour ouvrir l'explorateur de fichiers
    if (this.dropZone && this.fileInput) {
      this.dropZone.addEventListener('click', () => {
        logger.info('Drive', `🖱️ Clic sur zone de dépôt -> Sélection de fichier pour le dossier "${this.currentPath}"...`);
        this.fileInput.click();
      });
      
      this.fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          logger.debug('Drive', '📄 Fichier sélectionné via explorateur:', e.target.files[0].name);
          this.handleFileUpload(e.target.files[0]);
        }
      });

      // Gestion du Glisser-Déposer (Drag & Drop)
      this.dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        this.dropZone.classList.add('drag-active');
      });

      this.dropZone.addEventListener('dragleave', () => {
        this.dropZone.classList.remove('drag-active');
      });

      this.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        this.dropZone.classList.remove('drag-active');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          logger.debug('Drive', '📥 Fichier déposé par Drag & Drop:', e.dataTransfer.files[0].name);
          this.handleFileUpload(e.dataTransfer.files[0]);
        }
      });
    }

    // Bouton de Création de Nouveau Dossier
    if (this.btnCreateFolder) {
      this.btnCreateFolder.addEventListener('click', () => {
        this.openCreateFolderModal();
      });
    }

    const btnSubmitFolder = document.getElementById('btn-submit-create-folder');
    if (btnSubmitFolder) {
      btnSubmitFolder.addEventListener('click', () => this.confirmCreateFolder());
    }

    // Modale de Commit / Nouvelle Version
    const btnSubmitUpload = document.getElementById('btn-submit-file-commit');
    if (btnSubmitUpload) {
      btnSubmitUpload.addEventListener('click', () => this.confirmFileUpload());
    }
  }

  initListeners() {
    this.crdt.on('drive-commit-received', async (commit) => {
      logger.info('Drive', `🔄 Événement drive-commit-received [${commit?.fileName || 'fichier'}] -> Rechargement et auto-réplication`);
      this.loadFiles();
      Toast.info(`Nouveau fichier "${commit?.fileName || 'document'}" partagé sur le Drive !`);
      // Auto-réplication swarm en arrière-plan (Co-seeding)
      if (commit) {
        this.transferManager.autoReplicateFile(commit);
      }
    });

    this.crdt.on('drive-synced', async (commits) => {
      logger.info('Drive', '🔄 Événement drive-synced -> Rechargement complet du Drive et auto-réplication');
      this.loadFiles();
      if (Array.isArray(commits)) {
        for (const commit of commits) {
          this.transferManager.autoReplicateFile(commit);
        }
      }
    });

    this.crdt.on('drive-folder-updated', () => {
      logger.info('Drive', '🔄 Événement drive-folder-updated -> Rechargement des dossiers');
      this.loadFiles();
    });

    this.crdt.on('drive-file-deleted', ({ fileId }) => {
      logger.info('Drive', '🗑️ Fichier supprimé sur le réseau:', fileId);
      Toast.info('Un fichier a été supprimé du Drive.');
      this.loadFiles();
    });
  }

  async navigateTo(folderPath) {
    this.currentPath = VersioningDAG.normalizePath(folderPath);
    logger.info('Drive', `🧭 Navigation vers le dossier: "${this.currentPath}"`);
    await this.loadFiles();
  }

  renderBreadcrumbs() {
    if (!this.breadcrumbsContainer) return;
    this.breadcrumbsContainer.innerHTML = '';

    const rootCrumb = document.createElement('span');
    rootCrumb.className = `crumb-item ${this.currentPath === '/' ? 'active' : ''}`;
    rootCrumb.innerHTML = '🏠 Racine';
    rootCrumb.addEventListener('click', () => this.navigateTo('/'));
    this.breadcrumbsContainer.appendChild(rootCrumb);

    if (this.currentPath !== '/') {
      const parts = this.currentPath.split('/').filter(p => p.length > 0);
      let accumulated = '/';

      parts.forEach((part, idx) => {
        accumulated += `${part}/`;
        const isLast = idx === parts.length - 1;

        const sep = document.createElement('span');
        sep.className = 'crumb-separator';
        sep.textContent = '›';
        this.breadcrumbsContainer.appendChild(sep);

        const crumb = document.createElement('span');
        crumb.className = `crumb-item ${isLast ? 'active' : ''}`;
        crumb.textContent = `📁 ${part}`;

        if (!isLast) {
          const target = accumulated;
          crumb.addEventListener('click', () => this.navigateTo(target));
        }

        this.breadcrumbsContainer.appendChild(crumb);
      });
    }

    const dropTitle = document.getElementById('drive-drop-title');
    if (dropTitle) {
      dropTitle.textContent = this.currentPath === '/' 
        ? 'Partager un fichier à la racine' 
        : `Partager un fichier dans ${this.currentPath}`;
    }
  }

  async loadFiles() {
    // Coalescence : une seule séquence de rendu à la fois. Si d'autres événements
    // (drive-synced, drive-folder-updated…) arrivent pendant le rendu, on n'empile
    // pas — on relance exactement une fois de plus à la fin, avec l'état le plus récent.
    if (this._loading) { this._loadPending = true; return; }
    this._loading = true;
    try {
      do {
        this._loadPending = false;
        this.renderBreadcrumbs();
        await this.renderFolders();
        await this.renderFileList();
        this.updateDriveStorageBar();
      } while (this._loadPending);
    } finally {
      this._loading = false;
    }
  }

  async updateDriveStorageBar() {
    try {
      const est = await dbManager.estimateStorage();
      const fmt = (b) => {
        if (!b) return '0 o';
        const k = 1024, u = ['o', 'Ko', 'Mo', 'Go', 'To'];
        const i = Math.floor(Math.log(b) / Math.log(k));
        return `${(b / Math.pow(k, i)).toFixed(1)} ${u[i]}`;
      };
      const bar = document.getElementById('drive-storage-bar');
      const txt = document.getElementById('drive-storage-text');
      const pct = est.quota ? est.percent : 0;
      if (bar) { bar.style.width = `${Math.min(100, pct)}%`; bar.style.background = pct > 85 ? 'var(--accent-rose)' : ''; }
      if (txt) txt.textContent = est.quota ? `${fmt(est.usage)} / ${fmt(est.quota)} (${est.percent}%)` : fmt(est.usage);
    } catch {}
  }

  async renderFolders() {
    if (!this.foldersListContainer) return;

    // On récupère les données AVANT de vider le conteneur : le vidage et la
    // reconstruction se font ensuite de façon synchrone (aucun await entre les
    // deux), sinon des appels concurrents (déclenchés par la rafale d'événements
    // drive-synced) s'entrelacent et dupliquent les cartes (cf. bug doublons).
    const subFolders = await VersioningDAG.getSubFolders(this.currentPath);
    this.foldersListContainer.innerHTML = '';

    // Bouton Dossier Parent si nous sommes dans un sous-dossier
    if (this.currentPath !== '/') {
      const parentCard = document.createElement('div');
      parentCard.className = 'drive-folder-card is-parent-dir';
      parentCard.innerHTML = `
        <div class="folder-icon">⬆️</div>
        <div class="folder-info">
          <div class="folder-name">.. Dossier Parent</div>
          <div class="folder-meta">Remonter d'un niveau</div>
        </div>
      `;
      parentCard.addEventListener('click', () => {
        const parts = this.currentPath.split('/').filter(p => p.length > 0);
        parts.pop();
        const parentPath = parts.length === 0 ? '/' : `/${parts.join('/')}/`;
        this.navigateTo(parentPath);
      });
      this.foldersListContainer.appendChild(parentCard);
    }

    const folderSection = document.getElementById('drive-folders-section');
    if (subFolders.length === 0 && this.currentPath === '/') {
      if (folderSection) folderSection.style.display = 'none';
      return;
    } else {
      if (folderSection) folderSection.style.display = 'block';
    }

    subFolders.forEach(f => {
      const card = document.createElement('div');
      card.className = 'drive-folder-card';
      card.innerHTML = `
        <div class="folder-icon">📁</div>
        <div class="folder-info">
          <div class="folder-name" title="${this.escape(f.name)}">${this.escape(f.name)}</div>
          <div class="folder-meta">Par ${this.escape(f.authorName || 'Membre')}</div>
        </div>
        <button class="btn-folder-delete" title="Supprimer le dossier">&times;</button>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('btn-folder-delete')) return;
        this.navigateTo(f.path);
      });

      card.querySelector('.btn-folder-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Voulez-vous supprimer le dossier "${f.name}" ?`)) {
          await VersioningDAG.deleteFolder(f.path);
          await this.crdt.broadcastDeleteFolder(f.path);
          Toast.info(`Dossier "${f.name}" supprimé.`);
          this.loadFiles();
        }
      });

      this.foldersListContainer.appendChild(card);
    });
  }

  async renderFileList() {
    if (!this.filesListContainer) return;

    // Données d'abord, puis vidage + reconstruction synchrones (anti-doublons,
    // cf. renderFolders).
    const currentFiles = await VersioningDAG.getLatestFiles(this.currentPath);
    this.filesListContainer.innerHTML = '';

    if (currentFiles.length === 0) {
      this.filesListContainer.innerHTML = `
        <div class="empty-state" style="padding: 20px 10px;">
          <div class="empty-icon">📄</div>
          <p>Aucun document dans ce dossier.</p>
          <small>Glissez un document ci-dessus pour le diffuser.</small>
        </div>
      `;
      return;
    }

    currentFiles.forEach(file => {
      const card = document.createElement('div');
      card.className = 'drive-file-card';

      const sizeStr = this.formatFileSize(file.fileSize);
      const dateStr = new Date(file.timestamp).toLocaleDateString([], { day: '2-digit', month: 'short' });
      const fileExt = file.fileName.split('.').pop().toUpperCase();

      const isImage = (file.mimeType || '').startsWith('image/');
      card.innerHTML = `
        <div class="file-icon-box">
          <span class="file-ext-tag">${fileExt}</span>
        </div>
        <div class="file-info-box">
          <h4 class="file-name" title="${this.escape(file.fileName)}">${this.escape(file.fileName)}</h4>
          <div class="file-meta">
            <span class="badge badge-version">v${file.versionNumber}</span>
            <span>${sizeStr}</span>
            <span>• Par ${this.escape(file.authorName || 'Membre')}</span>
            <span>• ${dateStr}</span>
            <span class="file-seeders" data-seeders>⏳ sources…</span>
          </div>
          <div class="file-commit-msg">"${this.escape(file.commitMessage || 'Mise à jour')}"</div>
        </div>
        <div class="file-actions-box">
          ${isImage ? '<button class="btn btn-secondary btn-xs btn-preview" title="Aperçu">👁️</button>' : ''}
          <button class="btn btn-secondary btn-xs btn-history" title="Historique des versions">📜</button>
          <button class="btn btn-primary btn-xs btn-download" title="Télécharger via P2P">⬇️</button>
          <button class="btn-file-delete" title="Supprimer du Drive">🗑️</button>
        </div>
      `;

      card.querySelector('.btn-history').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openFileHistoryModal(file.fileId);
      });

      card.querySelector('.btn-download').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.handleDownloadFile(file, card.querySelector('.btn-download'));
      });

      const previewBtn = card.querySelector('.btn-preview');
      if (previewBtn) {
        previewBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.handlePreviewImage(file, previewBtn);
        });
      }

      card.querySelector('.btn-file-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.handleDeleteFile(file);
      });

      // Sonde asynchrone du nombre de sources (seeders) sur le réseau.
      this.updateSeedersBadge(file, card.querySelector('[data-seeders]'));

      this.filesListContainer.appendChild(card);
    });
  }

  async updateSeedersBadge(file, el) {
    if (!el) return;
    try {
      const { seeders, localComplete, localPercent } = await this.transferManager.probeSeeders(file);
      let txt, cls = 'file-seeders';
      if (localComplete) txt = `✓ répliqué • ${seeders} source(s)`;
      else if (localPercent > 0) txt = `${localPercent}% local • ${seeders} source(s)`;
      else txt = seeders > 0 ? `${seeders} source(s)` : 'aucune source';
      if (seeders === 0 && !localComplete) cls += ' none';
      el.className = cls;
      el.textContent = `🌐 ${txt}`;
    } catch {
      el.textContent = '';
    }
  }

  async handlePreviewImage(file, btn) {
    const original = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner-sm"></span>';
    try {
      const blob = await this.transferManager.downloadFile(file);
      const url = URL.createObjectURL(blob);
      const img = document.getElementById('preview-image');
      const title = document.getElementById('preview-title');
      if (img) img.src = url;
      if (title) title.textContent = file.fileName;
      Modal.open('modal-preview');
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (err) {
      Toast.error(`Aperçu impossible : ${err.message}`);
    } finally {
      btn.disabled = false; btn.innerHTML = original;
    }
  }

  async handleDeleteFile(file) {
    if (!confirm(`Supprimer « ${file.fileName} » du Drive partagé pour tout le groupe ?`)) return;
    try {
      await this.crdt.broadcastDeleteFile(file.fileId, this.vault.userName);
      Toast.success(`« ${file.fileName} » supprimé.`);
      await this.loadFiles();
    } catch (err) {
      logger.error('Drive', 'Erreur suppression:', err);
      Toast.error('Échec de la suppression du fichier.');
    }
  }

  openCreateFolderModal() {
    const parentDisplay = document.getElementById('folder-parent-display');
    const inputName = document.getElementById('input-folder-name');
    if (parentDisplay) parentDisplay.textContent = this.currentPath;
    if (inputName) inputName.value = '';
    Modal.open('modal-create-folder');
  }

  async confirmCreateFolder() {
    const inputName = document.getElementById('input-folder-name');
    const folderName = inputName ? inputName.value.trim() : '';

    if (!folderName) {
      Toast.warning('Veuillez spécifier un nom de dossier.');
      return;
    }

    Modal.close('modal-create-folder');

    try {
      logger.info('Drive', `📁 Création du dossier "${folderName}" dans "${this.currentPath}"...`);
      const folder = await VersioningDAG.createFolder(this.currentPath, folderName, this.vault.userName);
      await this.crdt.broadcastCreateFolder(folder);
      Toast.success(`Dossier "${folder.name}" créé avec succès !`);
      await this.loadFiles();
    } catch (err) {
      logger.error('Drive', 'Erreur création dossier:', err);
      Toast.error('Impossible de créer le dossier.');
    }
  }

  async handleFileUpload(file) {
    // Pré-contrôles : taille max et quota de stockage disponible (audit §quotas OPFS).
    if (file.size > CONFIG.DRIVE.MAX_FILE_SIZE) {
      Toast.error(`Fichier trop volumineux (${this.formatFileSize(file.size)}). Maximum : ${this.formatFileSize(CONFIG.DRIVE.MAX_FILE_SIZE)}.`);
      return;
    }
    try {
      // Il faut de la place pour les blocs source + une copie assemblée au download.
      await dbManager.ensureSpaceFor(file.size);
    } catch (err) {
      Toast.error(err.message);
      return;
    }

    this.pendingFile = file;
    // Déduit le fileId à partir du dossier et du nom normalisé
    const cleanName = file.name.toLowerCase().replace(/[^a-z0-9.]/g, '_');
    const cleanFolder = this.currentPath.replace(/[^a-z0-9]/g, '_');
    this.pendingFileId = `file_${cleanFolder}_${cleanName}`;

    logger.info('Drive', `📋 Préparation du commit pour: "${file.name}" dans "${this.currentPath}" (ID: ${this.pendingFileId})`);

    const existingHistory = await VersioningDAG.getFileHistory(this.pendingFileId);
    const isUpdate = existingHistory.length > 0;

    const modalTitle = document.getElementById('modal-upload-title');
    const inputMsg = document.getElementById('upload-commit-message');
    const previewName = document.getElementById('upload-file-preview-name');

    if (modalTitle) modalTitle.textContent = isUpdate ? `Nouvelle Version (v${existingHistory[0].versionNumber + 1})` : 'Ajouter un Document au Drive';
    if (previewName) previewName.textContent = `${file.name} (${this.formatFileSize(file.size)}) -> ${this.currentPath}`;
    if (inputMsg) inputMsg.value = isUpdate ? 'Mise à jour du contenu' : 'Version initiale';

    Modal.open('modal-file-upload');
  }

  async confirmFileUpload() {
    if (!this.pendingFile) return;

    const inputMsg = document.getElementById('upload-commit-message');
    const commitMessage = inputMsg ? inputMsg.value.trim() : 'Mise à jour du document';

    logger.info('Drive', `🚀 Confirmation du téléversement pour "${this.pendingFile.name}" dans "${this.currentPath}"`);
    Modal.close('modal-file-upload');

    try {
      if (this.uploadProgressContainer) this.uploadProgressContainer.classList.remove('hidden');
      if (this.uploadProgressBar) this.uploadProgressBar.style.width = '0%';

      Toast.info('Découpage et hachage SHA-256 en cours...');

      // 1. Découpage en blocs de 512 Ko et stockage local
      const processed = await FileChunker.processFile(this.pendingFile, (percent) => {
        if (this.uploadProgressBar) this.uploadProgressBar.style.width = `${percent}%`;
      });

      // 2. Création du commit dans le DAG avec folderPath
      const commit = await VersioningDAG.createCommit({
        fileId: this.pendingFileId,
        fileName: processed.fileName,
        folderPath: this.currentPath,
        fileSize: processed.fileSize,
        mimeType: processed.mimeType,
        authorName: this.vault.userName,
        commitMessage,
        rootMerkleHash: processed.rootMerkleHash,
        chunks: processed.chunks
      });

      logger.info('Drive', `💾 Commit créé dans le DAG [ID: ${commit.commitId}, Version: v${commit.versionNumber}]`);

      // 3. Diffusion du commit au réseau P2P
      await this.crdt.broadcastDriveCommit(commit);

      Toast.success(`Fichier ${processed.fileName} (v${commit.versionNumber}) partagé dans ${this.currentPath} !`);
      this.pendingFile = null;
      await this.loadFiles();
    } catch (err) {
      logger.error('Drive', 'Erreur téléversement:', err);
      Toast.error(`Échec du téléversement : ${err.message}`);
    } finally {
      setTimeout(() => {
        if (this.uploadProgressContainer) this.uploadProgressContainer.classList.add('hidden');
      }, 1000);
    }
  }

  async handleDownloadFile(commit, buttonEl) {
    try {
      const originalText = buttonEl.innerHTML;
      buttonEl.disabled = true;
      buttonEl.innerHTML = '<span class="spinner-sm"></span> 0%';

      logger.info('Drive', `⬇️ Démarrage téléchargement P2P Swarm pour "${commit.fileName}" (v${commit.versionNumber})...`);
      Toast.info(`Recherche des blocs pour "${commit.fileName}" sur le réseau...`);

      const blob = await this.transferManager.downloadFile(commit, (percent) => {
        buttonEl.innerHTML = `<span class="spinner-sm"></span> ${percent}%`;
      });

      // Déclenchement du téléchargement local du navigateur
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = commit.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Laisse le temps au navigateur de démarrer le transfert avant de révoquer
      // l'URL et de nettoyer l'éventuel fichier temporaire OPFS (assemblage en flux).
      setTimeout(async () => {
        URL.revokeObjectURL(url);
        if (typeof blob._opfsCleanup === 'function') await blob._opfsCleanup();
      }, 60000);

      logger.info('Drive', `✅ Fichier assemblé et téléchargé avec succès !`);
      Toast.success(`Téléchargement de ${commit.fileName} terminé avec succès !`);
      buttonEl.disabled = false;
      buttonEl.innerHTML = originalText;
    } catch (err) {
      logger.error('Drive', 'Erreur téléchargement:', err);
      Toast.error(`Erreur de téléchargement : ${err.message}`);
      buttonEl.disabled = false;
      buttonEl.innerHTML = '⬇️ Télécharger';
    }
  }

  async openFileHistoryModal(fileId) {
    this.activeHistoryFileId = fileId;
    logger.info('Drive', `📜 Ouverture de l'historique des versions pour fileId: ${fileId}`);
    const history = await VersioningDAG.getFileHistory(fileId);
    const container = document.getElementById('history-timeline-list');
    const modalTitle = document.getElementById('modal-history-title');

    if (modalTitle && history.length > 0) {
      modalTitle.textContent = `Historique : ${history[0].fileName}`;
    }

    if (container) {
      container.innerHTML = '';
      history.forEach((commit, idx) => {
        const isLatest = idx === 0;
        const item = document.createElement('div');
        item.className = `timeline-item ${isLatest ? 'timeline-latest' : ''}`;
        
        const dateStr = new Date(commit.timestamp).toLocaleString();

        item.innerHTML = `
          <div class="timeline-dot"></div>
          <div class="timeline-content">
            <div class="timeline-header">
              <span class="badge badge-version">Version ${commit.versionNumber}</span>
              ${isLatest ? '<span class="badge badge-active">Active</span>' : ''}
              <span class="timeline-date">${dateStr}</span>
            </div>
            <div class="timeline-message">"${this.escape(commit.commitMessage || 'Mise à jour')}"</div>
            <div class="timeline-meta">
              <span>Auteur : <strong>${this.escape(commit.authorName)}</strong></span>
              <span>• Dossier : <code>${this.escape(commit.folderPath || '/')}</code></span>
              <span>• Taille : ${this.formatFileSize(commit.fileSize)}</span>
            </div>
            ${!isLatest ? '<button class="btn btn-secondary btn-xs btn-revert">Restaurer cette version</button>' : ''}
          </div>
        `;

        const revertBtn = item.querySelector('.btn-revert');
        if (revertBtn) {
          revertBtn.addEventListener('click', async () => {
            await this.revertFileToCommit(commit);
          });
        }

        container.appendChild(item);
      });
    }

    Modal.open('modal-file-history');
  }

  async revertFileToCommit(commit) {
    try {
      logger.info('Drive', `⏪ Restauration vers la version ${commit.versionNumber}...`);
      const newCommit = await VersioningDAG.revertToVersion(commit, this.vault.userName);
      await this.crdt.broadcastDriveCommit(newCommit);
      Modal.close('modal-file-history');
      Toast.success(`Fichier restauré vers la version ${commit.versionNumber} (Nouveau commit v${newCommit.versionNumber}) !`);
      await this.loadFiles();
    } catch (e) {
      logger.error('Drive', 'Erreur restauration:', e);
      Toast.error('Échec de la restauration de version.');
    }
  }

  formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 o';
    const k = 1024;
    const sizes = ['o', 'Ko', 'Mo', 'Go'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  escape(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  }
}
