/**
 * Gestionnaire de Notifications Toast Flottantes Accessible (WCAG 2.2 AA / ARIA 1.3)
 */

import { a11yAnnouncer } from '../core/a11y-announcer.js';

export class Toast {
  static iconMap = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌'
  };

  /**
   * Affiche un toast temporaire avec retour vocal accessible
   */
  static show(message, type = 'info', duration = 3500) {
    let container = document.getElementById('toast-container');
    if (!container && typeof document !== 'undefined') {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      container.setAttribute('role', 'region');
      container.setAttribute('aria-label', 'Notifications éphémères');
      document.body.appendChild(container);
    }

    if (container) {
      const toast = document.createElement('div');
      toast.className = `toast toast-${type} animate-slide-in`;
      toast.setAttribute('role', 'status');

      toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">${Toast.iconMap[type] || 'ℹ️'}</span>
        <span class="toast-message">${message}</span>
      `;

      container.appendChild(toast);

      setTimeout(() => {
        toast.classList.add('animate-fade-out');
        setTimeout(() => {
          if (toast.parentNode) toast.remove();
        }, 300);
      }, duration);
    }

    // Annonce vocale synchronisée via la file universelle
    if (type === 'error') {
      a11yAnnouncer.announceAssertive(`Erreur : ${message}`);
    } else if (type === 'warning') {
      a11yAnnouncer.announcePolite(`Avertissement : ${message}`);
    } else {
      a11yAnnouncer.announcePolite(message);
    }
  }

  static success(msg, dur) { Toast.show(msg, 'success', dur); }
  static error(msg, dur) { Toast.show(msg, 'error', dur); }
  static warn(msg, dur) { Toast.show(msg, 'warning', dur); }
  static info(msg, dur) { Toast.show(msg, 'info', dur); }
}
