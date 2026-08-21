/**
 * Gestionnaire de Fenêtres Modales Accessibles
 * - Fermeture par bouton [data-close-modal]
 * - Fermeture par touche Échap
 * - Fermeture par clic sur l'arrière-plan (overlay)
 * - Focus automatique sur le premier champ, restauration du focus à la fermeture
 */

export class Modal {
  static _openStack = [];
  static _globalBound = false;
  static _lastFocused = null;

  static open(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.add('modal-active');
    document.body.classList.add('modal-open');
    Modal._lastFocused = document.activeElement;
    if (!Modal._openStack.includes(modalId)) Modal._openStack.push(modalId);

    // Focus sur le premier champ interactif (confort clavier).
    const focusable = modal.querySelector('input, textarea, select, button:not(.modal-close-btn)');
    if (focusable) setTimeout(() => { try { focusable.focus(); } catch {} }, 60);

    Modal._ensureGlobalHandlers();
  }

  static close(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('modal-active');
    Modal._openStack = Modal._openStack.filter(id => id !== modalId);
    if (Modal._openStack.length === 0) document.body.classList.remove('modal-open');
    if (Modal._lastFocused && typeof Modal._lastFocused.focus === 'function') {
      try { Modal._lastFocused.focus(); } catch {}
    }
  }

  static closeTop() {
    const top = Modal._openStack[Modal._openStack.length - 1];
    if (top) Modal.close(top);
  }

  static _ensureGlobalHandlers() {
    if (Modal._globalBound) return;
    Modal._globalBound = true;

    // Échap ferme la modale du dessus.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && Modal._openStack.length > 0) {
        e.preventDefault();
        Modal.closeTop();
      }
    });

    // Clic sur l'arrière-plan (hors contenu) ferme la modale.
    document.addEventListener('mousedown', (e) => {
      const overlay = e.target.closest ? e.target.closest('.modal-overlay.modal-active') : null;
      if (overlay && e.target === overlay) {
        Modal.close(overlay.id);
      }
    });
  }

  static setupCloseTriggers() {
    document.querySelectorAll('[data-close-modal]').forEach(el => {
      el.addEventListener('click', () => {
        const modal = el.closest('.modal-overlay');
        if (modal) Modal.close(modal.id);
      });
    });
    Modal._ensureGlobalHandlers();
  }
}
