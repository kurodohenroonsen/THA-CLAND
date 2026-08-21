import { logger } from '../core/logger.js';
/**
 * Gestionnaire de Boîtes Modales Accessible (WCAG 2.2 / WAI-ARIA Dialog Pattern)
 * Supporte les ouvertures empilées, la fermeture au clic sur le fond dépoli,
 * la touche Échap, le confinement du focus (Focus Trap) et l'isolation inert.
 */

export class Modal {
  static _openStack = [];
  static _lastFocused = null;
  static _initialized = false;

  /**
   * Ouvre une boîte modale par son ID
   */
  static open(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) {
      logger.warn('Modal', `Modale "${modalId}" introuvable dans le DOM.`);
      return;
    }

    Modal._ensureGlobalHandlers();
    Modal._lastFocused = document.activeElement;

    modal.classList.add('modal-active');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');

    // Isolation de l'arrière-plan avec inert (Accessibilité)
    const mainApp = document.getElementById('view-main-app');
    const authView = document.getElementById('view-auth');
    if (mainApp) mainApp.setAttribute('inert', '');
    if (authView) authView.setAttribute('inert', '');

    if (!Modal._openStack.includes(modalId)) {
      Modal._openStack.push(modalId);
    }

    // Déplacement accessible du focus dans la modale
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
    if (modal) {
      modal.classList.remove('modal-active');
      modal.setAttribute('aria-hidden', 'true');
    }

    Modal._openStack = Modal._openStack.filter(id => id !== modalId);

    if (Modal._openStack.length === 0) {
      document.body.classList.remove('modal-open');
      const mainApp = document.getElementById('view-main-app');
      const authView = document.getElementById('view-auth');
      if (mainApp) mainApp.removeAttribute('inert');
      if (authView) authView.removeAttribute('inert');
    }

    // Restauration du focus sur l'élément d'origine
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
   * Récupère la liste des éléments recevant le focus clavier
   */
  static getFocusableElements(container) {
    return Array.from(container.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null);
  }

  /**
   * Enregistre les gestionnaires d'événements globaux
   */
  static _ensureGlobalHandlers() {
    if (Modal._initialized) return;
    Modal._initialized = true;

    // Fermeture avec Échap et Focus Trap avec Tab / Shift+Tab
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

    // Délégation de fermeture sur les boutons et overlays
    document.addEventListener('click', (e) => {
      if (e.target.matches('[data-close-modal]') || e.target.closest('[data-close-modal]')) {
        const modal = e.target.closest('.modal-overlay');
        if (modal && modal.id) Modal.close(modal.id);
      } else if (e.target.classList.contains('modal-overlay')) {
        Modal.close(e.target.id);
      }
    });
  }
}
