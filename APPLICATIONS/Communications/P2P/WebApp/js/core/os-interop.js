/**
 * Interopérabilité Système d'Exploitation (OS) — Standards 2025/2026
 * - Guard global drag-and-drop sur window (prévention du crash par déchargement)
 * - ClipboardService : Double étage asynchrone sécurisé + fallback DOM textarea
 * - ZeroTraceClipboard : Purge temporisée des secrets cryptographiques
 * - WebShareService : Partage natif de fichiers et invitations via Web Share API
 */

import { logger } from './logger.js';
import { Toast } from '../ui/toast.js';

/**
 * 1. Neutralise l'événement de drop global pour éviter que Chrome ne navigue vers l'URI du fichier
 */
export function installGlobalDropGuard() {
  if (typeof window === 'undefined') return;

  ['dragover', 'drop'].forEach((evtName) => {
    window.addEventListener(evtName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, false);
  });
  logger.debug('OSInterop', '🛡️ Garde-fou global Drag & Drop installé sur window.');
}

/**
 * 2. Service universel de presse-papier avec double étage
 */
export class ClipboardService {
  static async copy(text) {
    if (!text && text !== '') return false;

    // Étage 1 : API Asynchrone moderne
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        logger.debug('OSInterop', 'Presse-papier asynchrone refusé, bascule fallback DOM:', err);
      }
    }

    // Étage 2 : Fallback DOM invisible avec document.execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      logger.error('OSInterop', 'Échec total de la copie:', e);
      return false;
    }
  }

  static async read() {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      try {
        return await navigator.clipboard.readText();
      } catch (err) {
        logger.debug('OSInterop', 'Lecture presse-papier asynchrone refusée:', err);
      }
    }
    return '';
  }
}

/**
 * 3. Presse-papier sécurisé avec purge temporisée zéro-trace
 */
export class ZeroTraceClipboard {
  static purgeTimer = null;

  static async copySensitive(secret, ttlMs = 45000) {
    const ok = await ClipboardService.copy(secret);
    if (!ok) return false;

    if (this.purgeTimer) clearTimeout(this.purgeTimer);

    this.purgeTimer = setTimeout(async () => {
      try {
        const current = await ClipboardService.read();
        if (current === secret) {
          await ClipboardService.copy('');
          logger.debug('OSInterop', '🧹 Secret expiré et purgé du presse-papier système.');
        }
      } catch (_) {}
    }, ttlMs);

    return true;
  }
}

/**
 * 4. Web Share API 2026 pour le partage natif OS
 */
export class WebShareService {
  static canShareFiles() {
    return typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';
  }

  static async shareFileOrText({ fileBlob, fileName, title, text, url }) {
    const payload = {};
    if (title) payload.title = title;
    if (text) payload.text = text;
    if (url) payload.url = url;

    if (fileBlob && fileName) {
      try {
        const fileObj = new File([fileBlob], fileName, { type: fileBlob.type || 'application/octet-stream' });
        payload.files = [fileObj];
      } catch (_) {}
    }

    if (typeof navigator !== 'undefined' && navigator.share) {
      if (!payload.files || (this.canShareFiles() && navigator.canShare(payload))) {
        try {
          await navigator.share(payload);
          return { success: true, method: 'native-share' };
        } catch (err) {
          if (err.name === 'AbortError') return { success: false, aborted: true };
          logger.debug('OSInterop', 'Partage natif refusé ou échoué:', err);
        }
      }
    }

    // Fallback automatique
    if (payload.files && fileBlob) {
      return { success: false, method: 'download-fallback' };
    }

    const copied = await ClipboardService.copy(url || text || '');
    if (copied) {
      Toast.success('Lien d\'invitation copié dans le presse-papier !');
    }
    return { success: copied, method: 'clipboard-fallback' };
  }
}

/**
 * 5. Helper anti-scintillement dragCounter pour les zones de glisser-déposer
 */
export class DragDropHelper {
  static attach(dropElement, { onFilesDropped, onHoverChange }) {
    let dragCounter = 0;

    dropElement.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
      dragCounter++;
      if (onHoverChange) onHoverChange(true);
    });

    dropElement.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    dropElement.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        if (onHoverChange) onHoverChange(false);
      }
    });

    dropElement.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      if (onHoverChange) onHoverChange(false);

      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length > 0 && onFilesDropped) {
        await onFilesDropped(files);
      }
    });
  }
}
