import { logger } from '../core/logger.js';
/**
 * Système de Notifications Toasts Interactives
 */

export class Toast {
  static show(message, type = 'info', duration = 4000) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type} animate-slide-in`;

    const iconMap = {
      info: '💡',
      success: '✅',
      warning: '⚠️',
      error: '❌'
    };

    toast.innerHTML = `
      <span class="toast-icon">${iconMap[type] || 'ℹ️'}</span>
      <span class="toast-message">${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('animate-fade-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  static success(msg, dur) { Toast.show(msg, 'success', dur); }
  static error(msg, dur) { Toast.show(msg, 'error', dur); }
  static warning(msg, dur) { Toast.show(msg, 'warning', dur); }
  static info(msg, dur) { Toast.show(msg, 'info', dur); }
}
