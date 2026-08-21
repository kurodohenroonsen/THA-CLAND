import { logger } from '../core/logger.js';
import { i18n } from '../core/i18n.js';

/**
 * Gestionnaire de Boîtes Modales Accessible (WCAG 2.2 / WAI-ARIA Dialog Pattern)
 * - Remplacement asynchrone Promise-based de confirm() et alert()
 * - Support des ouvertures empilées, fermeture au clic extérieur et touche Échap
 * - Confinement strict du focus (Focus Trap) et isolation inert
 * - Support View Transitions API et prefers-reduced-motion
 */
export class Modal {
  static _openStack = [];
  static _lastFocused = null;
  static _initialized = false;

  /**
   * Ouvre une boîte modale statique du DOM par son ID
   */
  static open(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) {
      logger.warn('Modal', `Modale "${modalId}" introuvable dans le DOM.`);
      return;
    }

    Modal._ensureGlobalHandlers();
    Modal._lastFocused = document.activeElement;

    const performOpen = () => {
      modal.classList.add('modal-active');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');

      const mainApp = document.getElementById('view-main-app');
      const authView = document.getElementById('view-auth');
      const appHeader = document.querySelector('.app-header');
      const appFooter = document.querySelector('.app-footer-statusbar');
      if (mainApp) mainApp.setAttribute('inert', '');
      if (authView) authView.setAttribute('inert', '');
      if (appHeader) appHeader.setAttribute('inert', '');
      if (appFooter) appFooter.setAttribute('inert', '');

      if (!Modal._openStack.includes(modalId)) {
        Modal._openStack.push(modalId);
      }
    };

    const supportsViewTransition = typeof document.startViewTransition === 'function';
    const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (supportsViewTransition && !prefersReducedMotion) {
      document.startViewTransition(() => performOpen());
    } else {
      performOpen();
    }

    const focusables = Modal.getFocusableElements(modal);
    if (focusables.length > 0) {
      setTimeout(() => {
        try { focusables[0].focus(); } catch (e) { logger.debug('Modal', 'Erreur focus modal:', e); }
      }, 50);
    }
  }

  /**
   * Ferme une modale par son ID
   */
  static close(modalId) {
    const modal = document.getElementById(modalId);

    const performClose = () => {
      if (modal) {
        modal.classList.remove('modal-active');
        modal.setAttribute('aria-hidden', 'true');
      }

      Modal._openStack = Modal._openStack.filter(id => id !== modalId);

      if (Modal._openStack.length === 0) {
        document.body.classList.remove('modal-open');
        const mainApp = document.getElementById('view-main-app');
        const authView = document.getElementById('view-auth');
        const appHeader = document.querySelector('.app-header');
        const appFooter = document.querySelector('.app-footer-statusbar');
        if (mainApp) mainApp.removeAttribute('inert');
        if (authView) authView.removeAttribute('inert');
        if (appHeader) appHeader.removeAttribute('inert');
        if (appFooter) appFooter.removeAttribute('inert');
      }
    };

    const supportsViewTransition = typeof document.startViewTransition === 'function';
    const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (supportsViewTransition && !prefersReducedMotion) {
      document.startViewTransition(() => performClose());
    } else {
      performClose();
    }

    if (Modal._lastFocused && typeof Modal._lastFocused.focus === 'function') {
      try {
        Modal._lastFocused.focus();
      } catch (e) {
        logger.debug('Modal', 'Erreur restore focus modal:', e);
      }
    }
  }

  /**
   * Ferme la dernière modale ouverte
   */
  static closeTop() {
    if (Modal._openStack.length > 0) {
      const topId = Modal._openStack[Modal._openStack.length - 1];
      Modal.close(topId);
    }
  }

  /**
   * Remplacement moderne, asynchrone et accessible de window.confirm()
   * @param {string} message - Message explicatif
   * @param {string} [title] - Titre de la boîte de dialogue
   * @param {object} [options] - Options { confirmText, cancelText, isDanger }
   * @returns {Promise<boolean>}
   */
  static confirm(message, title = null, options = {}) {
    return new Promise((resolve) => {
      Modal._ensureGlobalHandlers();
      Modal._lastFocused = document.activeElement;

      const dynamicId = `modal-confirm-${Date.now()}`;
      const dialog = document.createElement('div');
      dialog.id = dynamicId;
      dialog.className = 'modal-overlay modal-active';
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', `${dynamicId}-title`);
      dialog.setAttribute('aria-describedby', `${dynamicId}-desc`);

      const defaultTitle = title || i18n.t('modals.confirm_title');
      const confirmLabel = options.confirmText || i18n.t('modals.btn_confirm');
      const cancelLabel = options.cancelText || i18n.t('modals.btn_cancel');
      const isDanger = options.isDanger !== false;

      dialog.innerHTML = `
        <div class="modal-content" style="max-width: 400px;">
          <div class="modal-header">
            <h3 id="${dynamicId}-title" class="modal-title">${defaultTitle}</h3>
            <button class="modal-close-btn" data-modal-action="cancel" aria-label="${i18n.t('modals.btn_close')}">&times;</button>
          </div>
          <div class="modal-body">
            <p id="${dynamicId}-desc" style="font-size: 13.5px; color: var(--text-secondary); line-height: 1.5; margin: 0;">${message}</p>
          </div>
          <div class="modal-footer" style="justify-content: flex-end; gap: 8px;">
            <button class="btn btn-secondary btn-sm" data-modal-action="cancel">${cancelLabel}</button>
            <button class="btn ${isDanger ? 'btn-danger' : 'btn-primary'} btn-sm" data-modal-action="confirm">${confirmLabel}</button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);
      document.body.classList.add('modal-open');
      Modal._openStack.push(dynamicId);

      const cleanup = (result) => {
        Modal._openStack = Modal._openStack.filter(id => id !== dynamicId);
        dialog.remove();
        if (Modal._openStack.length === 0) {
          document.body.classList.remove('modal-open');
          const mainApp = document.getElementById('view-main-app');
          const authView = document.getElementById('view-auth');
          const appHeader = document.querySelector('.app-header');
          const appFooter = document.querySelector('.app-footer-statusbar');
          if (mainApp) mainApp.removeAttribute('inert');
          if (authView) authView.removeAttribute('inert');
          if (appHeader) appHeader.removeAttribute('inert');
          if (appFooter) appFooter.removeAttribute('inert');
        }
        if (Modal._lastFocused && typeof Modal._lastFocused.focus === 'function') {
          try { Modal._lastFocused.focus(); } catch (_) {}
        }
        resolve(result);
      };

      dialog.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('[data-modal-action]');
        if (actionBtn) {
          const action = actionBtn.getAttribute('data-modal-action');
          cleanup(action === 'confirm');
        } else if (e.target === dialog) {
          cleanup(false);
        }
      });

      const confirmBtn = dialog.querySelector('[data-modal-action="confirm"]');
      if (confirmBtn) setTimeout(() => confirmBtn.focus(), 40);
    });
  }

  /**
   * Remplacement moderne, asynchrone et accessible de window.alert()
   * @param {string} message - Message d'information
   * @param {string} [title] - Titre de l'alerte
   * @param {string} [okText] - Libellé du bouton OK
   * @returns {Promise<void>}
   */
  static alert(message, title = null, okText = null) {
    return new Promise((resolve) => {
      Modal._ensureGlobalHandlers();
      Modal._lastFocused = document.activeElement;

      const dynamicId = `modal-alert-${Date.now()}`;
      const dialog = document.createElement('div');
      dialog.id = dynamicId;
      dialog.className = 'modal-overlay modal-active';
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', `${dynamicId}-title`);
      dialog.setAttribute('aria-describedby', `${dynamicId}-desc`);

      const defaultTitle = title || i18n.t('modals.alert_title');
      const btnLabel = okText || i18n.t('modals.btn_ok');

      dialog.innerHTML = `
        <div class="modal-content" style="max-width: 380px;">
          <div class="modal-header">
            <h3 id="${dynamicId}-title" class="modal-title">${defaultTitle}</h3>
            <button class="modal-close-btn" data-modal-action="ok" aria-label="${i18n.t('modals.btn_close')}">&times;</button>
          </div>
          <div class="modal-body">
            <p id="${dynamicId}-desc" style="font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin: 0;">${message}</p>
          </div>
          <div class="modal-footer" style="justify-content: flex-end;">
            <button class="btn btn-primary btn-sm" data-modal-action="ok">${btnLabel}</button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);
      document.body.classList.add('modal-open');
      Modal._openStack.push(dynamicId);

      const cleanup = () => {
        Modal._openStack = Modal._openStack.filter(id => id !== dynamicId);
        dialog.remove();
        if (Modal._openStack.length === 0) {
          document.body.classList.remove('modal-open');
          const mainApp = document.getElementById('view-main-app');
          const authView = document.getElementById('view-auth');
          const appHeader = document.querySelector('.app-header');
          const appFooter = document.querySelector('.app-footer-statusbar');
          if (mainApp) mainApp.removeAttribute('inert');
          if (authView) authView.removeAttribute('inert');
          if (appHeader) appHeader.removeAttribute('inert');
          if (appFooter) appFooter.removeAttribute('inert');
        }
        if (Modal._lastFocused && typeof Modal._lastFocused.focus === 'function') {
          try { Modal._lastFocused.focus(); } catch (_) {}
        }
        resolve();
      };

      dialog.addEventListener('click', (e) => {
        if (e.target.closest('[data-modal-action="ok"]') || e.target === dialog) {
          cleanup();
        }
      });

      const okBtn = dialog.querySelector('[data-modal-action="ok"]');
      if (okBtn) setTimeout(() => okBtn.focus(), 40);
    });
  }

  static getFocusableElements(container) {
    return Array.from(
      container.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null);
  }

  static _ensureGlobalHandlers() {
    if (Modal._initialized || typeof document === 'undefined') return;
    Modal._initialized = true;

    document.addEventListener('keydown', (e) => {
      if (Modal._openStack.length === 0) return;
      const topModalId = Modal._openStack[Modal._openStack.length - 1];
      const modal = document.getElementById(topModalId);
      if (!modal) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        Modal.close(topModalId);
      } else if (e.key === 'Tab') {
        const focusables = Modal.getFocusableElements(modal);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    document.addEventListener('click', (e) => {
      if (e.target.matches('[data-close-modal]') || e.target.closest('[data-close-modal]')) {
        const modal = e.target.closest('.modal-overlay');
        if (modal && modal.id) Modal.close(modal.id);
      } else if (e.target.classList.contains('modal-overlay')) {
        Modal.close(e.target.id);
      }
    });
  }

  static setupCloseTriggers() {
    Modal._ensureGlobalHandlers();
  }
}
