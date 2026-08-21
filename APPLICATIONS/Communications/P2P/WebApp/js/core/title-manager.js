/**
 * Gestionnaire Centralisé du Titre OS & App Badging API (2025/2026)
 * - Synchronisation dynamique de document.title (Appels, Unread counts, section active)
 * - Mise à jour de navigator.setAppBadge / clearAppBadge (PWA Desktop/Mobile)
 * - Découplage strict entre pairs connectés et alertes non lues
 */

import { logger } from './logger.js';

export class TitleManager {
  constructor() {
    this.baseTitle = 'P2P Mesh Workspace';
    this.sectionName = '';
    this.sectionDetail = '';
    this.unreadCount = 0;
    this.callState = { active: false, muted: false, roomName: '' };
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
    this.render();
  }

  async syncBadge() {
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

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          type: 'UPDATE_UNREAD_BADGE',
          unreadCount: this.unreadCount
        }).catch(() => {});
      } catch (_) {}
    }
  }

  render() {
    if (typeof document === 'undefined') return;

    const parts = [];

    // 1. Indicateur d'appel prioritaire
    if (this.callState.active) {
      const mic = this.callState.muted ? '🎙️ (Muet)' : '🔴 (En appel)';
      parts.push(`${mic} ${this.callState.roomName || 'Salon'}`);
    }

    // 2. Compteur de non-lus
    if (this.unreadCount > 0) {
      parts.push(`(${this.unreadCount > 99 ? '99+' : this.unreadCount})`);
    }

    // 3. Contexte de section
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
