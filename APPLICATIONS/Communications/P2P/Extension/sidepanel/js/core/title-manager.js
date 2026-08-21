/**
 * Gestionnaire Centralisé du Titre OS & App Badging API (2025/2026 - Pass 4 Hardened)
 * - Synchronisation dynamique de document.title (Appels, Unread counts, section active)
 * - App Badging API W3C (PWA Desktop/Mobile)
 * - Fallback de badge dynamique sur le favicon (Firefox / Safari Desktop)
 * - Alerte visuelle de titre clignotant lors d'appels entrants ou mentions urgentes
 */

import { logger } from './logger.js';

export class TitleManager {
  constructor() {
    this.baseTitle = 'P2P Mesh Workspace';
    this.sectionName = '';
    this.sectionDetail = '';
    this.unreadCount = 0;
    this.callState = { active: false, muted: false, roomName: '' };
    this.alertFlashInterval = null;
    this.isAlerting = false;
  }

  setSection(name, detail = '') {
    this.sectionName = name || '';
    this.sectionDetail = detail || '';
    this.render();
  }

  setUnreadCount(count) {
    this.unreadCount = Math.max(0, count || 0);
    this.syncBadge();
    this.render();
  }

  setCallState({ active, muted, roomName }) {
    this.callState = {
      active: !!active,
      muted: !!muted,
      roomName: roomName || ''
    };
    if (active) {
      this.startUrgentAlert(`📞 Appel en cours (${this.callState.roomName || 'Salon'})`);
    } else {
      this.stopUrgentAlert();
    }
    this.render();
  }

  startUrgentAlert(alertMessage) {
    if (this.alertFlashInterval) clearInterval(this.alertFlashInterval);
    let toggle = false;
    this.isAlerting = true;

    this.alertFlashInterval = setInterval(() => {
      if (document.hidden && this.isAlerting) {
        document.title = toggle ? `🔴 ${alertMessage}` : `⚡ ${this.baseTitle}`;
        toggle = !toggle;
      } else {
        this.render();
      }
    }, 1200);
  }

  stopUrgentAlert() {
    this.isAlerting = false;
    if (this.alertFlashInterval) {
      clearInterval(this.alertFlashInterval);
      this.alertFlashInterval = null;
    }
    this.render();
  }

  async syncBadge() {
    // 1. W3C App Badging API standard
    if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
      try {
        if (this.unreadCount > 0) {
          await navigator.setAppBadge(this.unreadCount);
        } else {
          await navigator.clearAppBadge();
        }
      } catch (e) {
        logger.debug('TitleManager', 'Échec App Badging API:', e);
      }
    }

    // 2. Pontage Extension MV3 Action Badge
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          type: 'UPDATE_UNREAD_BADGE',
          unreadCount: this.unreadCount
        }).catch(() => {});
      } catch (_) {}
    }

    // 3. Fallback Favicon Badge pour Firefox et Safari Desktop
    this.renderFaviconBadge();
  }

  renderFaviconBadge() {
    if (typeof document === 'undefined') return;
    const favicon = document.querySelector("link[rel*='icon']");
    if (!favicon) return;

    // Si support natif setAppBadge actif, pas besoin de surcharger le canvas
    if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) return;

    try {
      const img = new Image();
      img.src = favicon.href;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 32, 32);

        if (this.unreadCount > 0) {
          ctx.beginPath();
          ctx.arc(24, 8, 7, 0, 2 * Math.PI);
          ctx.fillStyle = '#ef4444';
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const txt = this.unreadCount > 9 ? '9+' : String(this.unreadCount);
          ctx.fillText(txt, 24, 8.5);
        }

        favicon.href = canvas.toDataURL('image/png');
      };
    } catch (_) {}
  }

  render() {
    if (typeof document === 'undefined' || this.isAlerting) return;

    const parts = [];

    if (this.callState.active) {
      const mic = this.callState.muted ? '🎙️ (Muet)' : '🔴 (En appel)';
      parts.push(`${mic} ${this.callState.roomName || 'Salon'}`);
    }

    if (this.unreadCount > 0) {
      parts.push(`(${this.unreadCount > 99 ? '99+' : this.unreadCount})`);
    }

    if (this.sectionDetail) {
      parts.push(`${this.sectionDetail} • ${this.sectionName}`);
    } else if (this.sectionName) {
      parts.push(this.sectionName);
    }

    parts.push(this.baseTitle);
    document.title = parts.join(' | ');
  }
}

export const titleManager = new TitleManager();
