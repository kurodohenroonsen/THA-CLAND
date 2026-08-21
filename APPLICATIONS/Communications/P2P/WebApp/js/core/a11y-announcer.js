/**
 * Gestionnaire Centralisé des Annonces d'Accessibilité (WAI-ARIA 1.3 / WCAG 2.2 AA)
 * - File d'attente FIFO (Speech Queue Management)
 * - Support des priorités 'polite' et 'assertive'
 * - Contournement de l'Identical String Bug (Toggling de caractère invisible \u200B)
 * - Résistance au masquage d'onglets (Conteneurs persistants racine)
 */

import { logger } from './logger.js';

class A11yAnnouncerService {
  constructor() {
    this.politeContainer = null;
    this.assertiveContainer = null;
    this.queue = [];
    this.isProcessing = false;
    this.toggleBit = false;
  }

  /**
   * Initialise les conteneurs dans le DOM racine si non présents
   */
  init() {
    if (typeof document === 'undefined') return;

    this.politeContainer = document.getElementById('global-a11y-polite');
    if (!this.politeContainer) {
      this.politeContainer = document.createElement('div');
      this.politeContainer.id = 'global-a11y-polite';
      this.politeContainer.className = 'sr-only';
      this.politeContainer.setAttribute('role', 'status');
      this.politeContainer.setAttribute('aria-live', 'polite');
      this.politeContainer.setAttribute('aria-atomic', 'true');
      document.body.appendChild(this.politeContainer);
    }

    this.assertiveContainer = document.getElementById('global-a11y-assertive');
    if (!this.assertiveContainer) {
      this.assertiveContainer = document.createElement('div');
      this.assertiveContainer.id = 'global-a11y-assertive';
      this.assertiveContainer.className = 'sr-only';
      this.assertiveContainer.setAttribute('role', 'alert');
      this.assertiveContainer.setAttribute('aria-live', 'assertive');
      this.assertiveContainer.setAttribute('aria-atomic', 'true');
      document.body.appendChild(this.assertiveContainer);
    }

    logger.debug('A11y', '🔊 A11yAnnouncer initialisé avec conteneurs polite et assertive.');
  }

  /**
   * Diffuse une annonce vocale
   * @param {string} message - Message à vocaliser
   * @param {'polite'|'assertive'} politeness - Niveau d'urgence (défaut: 'polite')
   * @param {number} debounceMs - Délai anti-rebond optionnel
   */
  announce(message, politeness = 'polite', debounceMs = 50) {
    if (!message || typeof message !== 'string') return;
    const cleanMsg = message.trim();
    if (!cleanMsg) return;

    this.queue.push({ message: cleanMsg, politeness, debounceMs });
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  announcePolite(message) {
    this.announce(message, 'polite');
  }

  announceAssertive(message) {
    this.announce(message, 'assertive');
  }

  async processQueue() {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }

    this.isProcessing = true;
    const { message, politeness, debounceMs } = this.queue.shift();
    const targetEl = politeness === 'assertive' ? this.assertiveContainer : this.politeContainer;

    if (targetEl) {
      this.toggleBit = !this.toggleBit;
      const formattedMessage = this.toggleBit ? `${message} ` : `${message}\u200B`;

      targetEl.textContent = '';
      
      await new Promise(r => setTimeout(r, debounceMs));
      targetEl.textContent = formattedMessage;
      logger.debug('A11y', `[Vocalisé][${politeness.toUpperCase()}] ${message}`);
    }

    setTimeout(() => this.processQueue(), 120);
  }
}

export const a11yAnnouncer = new A11yAnnouncerService();
