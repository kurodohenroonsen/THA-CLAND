/**
 * Interopérabilité Système d'Exploitation (OS) — Standards 2025/2026 (Pass 4 Hardened)
 * - PlatformService : Détection haute précision Client Hints + Fallback universel
 * - KeyboardShortcutService : Registre universel de raccourcis, modificateurs & garde IME
 * - installGlobalDropGuard : Protection intégrale contre le déchargement de fenêtre
 * - ClipboardService : Double étage asynchrone sécurisé + fallback DOM textarea
 * - ZeroTraceClipboard : Purge temporisée volatile, lifecycle hooks (pagehide) & memory zeroing
 * - WebShareService : Partage natif W3C, gestion d'annulation et Web Share Target helper
 * - DragDropHelper : Support récursif Chromium getAsFileSystemHandle & WebKit webkitGetAsEntry
 */

import { logger } from './logger.js';
import { Toast } from '../ui/toast.js';
import { a11yAnnouncer } from './a11y-announcer.js';

/**
 * 1. SERVICE DE DÉTECTION DE PLATEFORME ET CAPACITÉS OS
 */
export class PlatformService {
  static #cachedInfo = null;

  static getInfo() {
    if (this.#cachedInfo) return this.#cachedInfo;

    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const ua = nav.userAgent || '';
    const platform = nav.platform || '';
    const uaData = nav.userAgentData;

    let os = 'unknown';
    let isMac = false;
    let isWindows = false;
    let isLinux = false;
    let isAndroid = false;
    let isIOS = false;
    let isChromeOS = false;

    if (uaData?.platform) {
      const p = uaData.platform.toLowerCase();
      if (p.includes('mac')) { os = 'macos'; isMac = true; }
      else if (p.includes('win')) { os = 'windows'; isWindows = true; }
      else if (p.includes('android')) { os = 'android'; isAndroid = true; }
      else if (p.includes('cros') || p.includes('chrome os')) { os = 'chromeos'; isChromeOS = true; }
      else if (p.includes('linux')) { os = 'linux'; isLinux = true; }
    }

    if (os === 'unknown') {
      if (/iPhone|iPad|iPod/i.test(ua) || (platform === 'MacIntel' && nav.maxTouchPoints > 1)) {
        os = 'ios';
        isIOS = true;
        isMac = true; // iPadOS partage les conventions de modificateurs Apple
      } else if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
        os = 'macos';
        isMac = true;
      } else if (/Win/i.test(platform) || /Windows/i.test(ua)) {
        os = 'windows';
        isWindows = true;
      } else if (/Android/i.test(ua)) {
        os = 'android';
        isAndroid = true;
      } else if (/CrOS/i.test(ua)) {
        os = 'chromeos';
        isChromeOS = true;
      } else if (/Linux/i.test(platform) || /Linux/i.test(ua)) {
        os = 'linux';
        isLinux = true;
      }
    }

    const isTouch = typeof window !== 'undefined' && (
      'ontouchstart' in window ||
      nav.maxTouchPoints > 0 ||
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
    );

    const isStandalone = typeof window !== 'undefined' && window.matchMedia && (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches ||
      nav.standalone === true
    );

    const isExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
    const isSecureContext = typeof window !== 'undefined' && window.isSecureContext === true;

    this.#cachedInfo = Object.freeze({
      os,
      isMac,
      isWindows,
      isLinux,
      isAndroid,
      isIOS,
      isChromeOS,
      isTouch,
      isStandalone,
      isExtension,
      isSecureContext,
      modKeySymbol: isMac ? '⌘' : 'Ctrl',
      modKeyName: isMac ? 'Meta' : 'Control',
      altKeySymbol: isMac ? '⌥' : 'Alt'
    });

    return this.#cachedInfo;
  }

  static get isMac() { return this.getInfo().isMac; }
  static get isWindows() { return this.getInfo().isWindows; }
  static get isMobile() { return this.getInfo().isAndroid || this.getInfo().isIOS; }
  static get modKey() { return this.getInfo().modKeySymbol; }
  static get altKey() { return this.getInfo().altKeySymbol; }
}

/**
 * 2. REGISTRE CENTRALISÉ DES RACCOURCIS CLAVIER UNIVERSELS
 */
export class KeyboardShortcutService {
  static #shortcuts = new Map();
  static #isInitialized = false;

  static init() {
    if (this.#isInitialized || typeof window === 'undefined') return;
    this.#isInitialized = true;

    window.addEventListener('keydown', (e) => {
      // Garde IME : Ignorer la saisie en cours de composition asiatique ou accents morts
      if (e.isComposing || e.keyCode === 229) return;

      const isMac = PlatformService.isMac;
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();
      const code = e.code;

      for (const shortcut of this.#shortcuts.values()) {
        const matchMod = shortcut.cmdOrCtrl ? cmdOrCtrl : (!e.metaKey && !e.ctrlKey);
        const matchAlt = shortcut.alt ? e.altKey : !e.altKey;
        const matchShift = shortcut.shift ? e.shiftKey : !e.shiftKey;
        const matchKey = (shortcut.key && shortcut.key.toLowerCase() === key) || (shortcut.code && shortcut.code === code);

        if (matchMod && matchAlt && matchShift && matchKey) {
          const isTargetEditable = this.isEditableElement(e.target);
          if (isTargetEditable && !shortcut.allowInInputs) {
            continue;
          }

          if (shortcut.preventDefault !== false) e.preventDefault();
          if (shortcut.stopPropagation !== false) e.stopPropagation();

          try {
            shortcut.handler(e);
          } catch (err) {
            logger.error('KeyboardService', `Erreur exécution raccourci [${shortcut.id}]:`, err);
          }
          break;
        }
      }
    }, { capture: true });

    logger.debug('KeyboardService', '⌨️ Moteur universel de raccourcis clavier initialisé.');
  }

  static register({ id, key, code, cmdOrCtrl = false, alt = false, shift = false, allowInInputs = false, preventDefault = true, stopPropagation = true, handler }) {
    if (!id || !handler) return;
    this.init();
    this.#shortcuts.set(id, { id, key, code, cmdOrCtrl, alt, shift, allowInInputs, preventDefault, stopPropagation, handler });
  }

  static unregister(id) {
    this.#shortcuts.delete(id);
  }

  static isEditableElement(el) {
    if (!el) return false;
    const tagName = el.tagName?.toLowerCase();
    return tagName === 'input' || tagName === 'textarea' || el.isContentEditable || el.getAttribute('role') === 'textbox';
  }

  static formatShortcut({ cmdOrCtrl, alt, shift, key }) {
    const parts = [];
    const p = PlatformService.getInfo();
    if (cmdOrCtrl) parts.push(p.modKeySymbol);
    if (alt) parts.push(p.altKeySymbol);
    if (shift) parts.push('Shift');
    if (key) parts.push(key.toUpperCase());
    return parts.join('+');
  }
}

/**
 * 3. GARDE-FOU GLOBAL DRAG & DROP
 * Neutralise les événements globaux pour éviter que le navigateur n'ouvre le fichier et ne tue la session WebRTC.
 */
export function installGlobalDropGuard() {
  if (typeof window === 'undefined') return;

  const cancel = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none';
    }
  };

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evtName) => {
    window.addEventListener(evtName, cancel, false);
    document.addEventListener(evtName, cancel, false);
  });
  logger.debug('OSInterop', '🛡️ Garde-fou global Drag & Drop installé sur window et document.');
}

/**
 * 4. SERVICE UNIVERSEL DE PRESSE-PAPIER DOUBLE ÉTAGE
 */
export class ClipboardService {
  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.clipboard;
  }

  static async copy(text) {
    if (text === undefined || text === null) return false;
    const str = String(text);

    // Étage 1 : Async Clipboard API moderne (Baseline 2025/2026)
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(str);
        return true;
      } catch (err) {
        logger.debug('OSInterop', 'Presse-papier asynchrone writeText refusé, bascule fallback DOM:', err);
      }
    }

    // Étage 2 : Fallback DOM invisible compatible tous navigateurs
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      ta.setAttribute('readonly', '');
      ta.setAttribute('aria-hidden', 'true');
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      logger.error('OSInterop', 'Échec total de la copie presse-papier:', e);
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
 * 5. PRESSE-PAPIER SÉCURISÉ ZÉRO-TRACE AVEC PURGE TEMPORISÉE ET LIFECYCLE HOOKS
 */
export class ZeroTraceClipboard {
  static #purgeTimer = null;
  static #currentSecretHash = null;
  static #listenersInstalled = false;

  static #initLifecycleHooks() {
    if (this.#listenersInstalled || typeof window === 'undefined') return;
    this.#listenersInstalled = true;

    // Purge immédiate si l'utilisateur quitte ou ferme l'application
    const purgeOnExit = () => {
      if (this.#currentSecretHash) {
        this.purgeNow();
      }
    };

    window.addEventListener('pagehide', purgeOnExit, { capture: true });
    window.addEventListener('beforeunload', purgeOnExit, { capture: true });
  }

  static async copySensitive(secret, ttlMs = 45000) {
    this.#initLifecycleHooks();
    if (!secret) return false;

    const ok = await ClipboardService.copy(secret);
    if (!ok) return false;

    this.#currentSecretHash = this.#quickHash(secret);
    if (this.#purgeTimer) clearTimeout(this.#purgeTimer);

    this.#purgeTimer = setTimeout(async () => {
      await this.purgeNow(secret);
    }, Math.max(1000, ttlMs));

    logger.debug('OSInterop', `🔒 Secret sensible copié dans le presse-papier (Auto-purge dans ${Math.round(ttlMs / 1000)}s).`);
    return true;
  }

  static async purgeNow(expectedSecret = null) {
    if (this.#purgeTimer) {
      clearTimeout(this.#purgeTimer);
      this.#purgeTimer = null;
    }

    try {
      let shouldClear = true;
      if (expectedSecret) {
        try {
          const current = await ClipboardService.read();
          if (current && current !== expectedSecret) {
            shouldClear = false; // L'utilisateur a copié autre chose entre-temps
          }
        } catch (_) {
          // Si read() est refusé par la politique de sécurité, on force l'écrasement
          shouldClear = true;
        }
      }

      if (shouldClear) {
        await ClipboardService.copy('');
        logger.debug('OSInterop', '🧹 Presse-papier purgé avec succès (Zéro-Trace).');
      }
    } catch (e) {
      logger.debug('OSInterop', 'Erreur lors de la purge Zéro-Trace:', e);
    } finally {
      this.#currentSecretHash = null;
    }
  }

  static cancelPurge() {
    if (this.#purgeTimer) {
      clearTimeout(this.#purgeTimer);
      this.#purgeTimer = null;
      this.#currentSecretHash = null;
      logger.debug('OSInterop', '🛑 Minuteur de purge Zéro-Trace annulé manuellement.');
    }
  }

  static #quickHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }
}

/**
 * 6. WEB SHARE SERVICE (W3C RECOMMENDATION 2026)
 */
export class WebShareService {
  static isSupported() {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  }

  static canShareFiles() {
    return typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';
  }

  static async shareFileOrText({ fileBlob, fileName, title, text, url }) {
    const payload = {};
    if (title) payload.title = String(title);
    if (text) payload.text = String(text);
    if (url) payload.url = String(url);

    if (fileBlob && fileName) {
      try {
        const mimeType = fileBlob.type || 'application/octet-stream';
        const fileObj = new File([fileBlob], fileName, { type: mimeType });
        payload.files = [fileObj];
      } catch (err) {
        logger.warn('WebShare', 'Impossible de construire l\'objet File pour le partage:', err);
      }
    }

    if (this.isSupported()) {
      let isShareable = true;
      if (payload.files && this.canShareFiles()) {
        try {
          isShareable = navigator.canShare({ files: payload.files });
        } catch (_) {
          isShareable = false;
        }
      }

      if (isShareable) {
        try {
          await navigator.share(payload);
          return { success: true, method: 'native-share' };
        } catch (err) {
          if (err.name === 'AbortError') {
            logger.debug('WebShare', 'Partage annulé par l\'utilisateur.');
            return { success: false, aborted: true };
          }
          logger.debug('WebShare', 'Échec du partage natif:', err);
        }
      }
    }

    // Fallback 1 : Fichier binaire -> Téléchargement local
    if (payload.files && fileBlob) {
      try {
        const blobUrl = URL.createObjectURL(fileBlob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName || 'telechargement';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        Toast.info('Fichier téléchargé sur votre appareil.');
        return { success: true, method: 'download-fallback' };
      } catch (e) {
        logger.error('WebShare', 'Échec fallback téléchargement:', e);
      }
    }

    // Fallback 2 : Texte ou URL -> Presse-papier
    const toCopy = url || text || '';
    const copied = await ClipboardService.copy(toCopy);
    if (copied) {
      Toast.success('Lien copié dans le presse-papier !');
    }
    return { success: copied, method: 'clipboard-fallback' };
  }
}

/**
 * 7. GESTIONNAIRE AVANCÉ DE GLISSER-DÉPOSER (FICHIERS ET DOSSIERS RÉCURSIFS)
 */
export class DragDropHelper {
  static attach(dropElement, { onFilesDropped, onHoverChange, acceptTypes = [] }) {
    if (!dropElement) return;
    let dragCounter = 0;

    dropElement.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.#hasFiles(e.dataTransfer)) return;
      dragCounter++;
      if (dragCounter === 1 && onHoverChange) {
        onHoverChange(true);
      }
    });

    dropElement.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.#hasFiles(e.dataTransfer)) {
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    dropElement.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        if (onHoverChange) onHoverChange(false);
      }
    });

    dropElement.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      if (onHoverChange) onHoverChange(false);

      const files = await this.extractFiles(e.dataTransfer);
      if (files.length > 0 && onFilesDropped) {
        a11yAnnouncer?.announce(`${files.length} fichier(s) prêt(s) au traitement.`);
        await onFilesDropped(files);
      }
    });
  }

  static #hasFiles(dt) {
    if (!dt || !dt.types) return false;
    return dt.types.includes('Files') || dt.types.includes('application/x-moz-file');
  }

  /**
   * Extraction multi-niveaux :
   * 1. Chromium moderne (File System Access API getAsFileSystemHandle)
   * 2. WebKit / Safari / Gecko (webkitGetAsEntry récursif)
   * 3. Fallback standard (dataTransfer.files)
   */
  static async extractFiles(dataTransfer) {
    if (!dataTransfer) return [];

    const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const results = [];

    // Stratégie 1 : File System Access API synchrone
    const handlePromises = items
      .filter(item => item.kind === 'file' && typeof item.getAsFileSystemHandle === 'function')
      .map(item => item.getAsFileSystemHandle().catch(() => null));

    if (handlePromises.length > 0) {
      try {
        const handles = await Promise.all(handlePromises);
        for (const handle of handles) {
          if (handle) {
            await this.#traverseHandle(handle, '', results);
          }
        }
        if (results.length > 0) return results;
      } catch (err) {
        logger.debug('DragDrop', 'Bascule vers webkitGetAsEntry:', err);
      }
    }

    // Stratégie 2 : webkitGetAsEntry (Safari & Firefox)
    const entryPromises = items
      .filter(item => item.kind === 'file' && typeof item.webkitGetAsEntry === 'function')
      .map(item => item.webkitGetAsEntry())
      .filter(Boolean);

    if (entryPromises.length > 0) {
      for (const entry of entryPromises) {
        await this.#traverseEntry(entry, '', results);
      }
      if (results.length > 0) return results;
    }

    // Stratégie 3 : Fallback standard files
    return Array.from(dataTransfer.files || []);
  }

  static async #traverseHandle(handle, path, outList) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      const relativePath = path ? `${path}/${file.name}` : file.name;
      Object.defineProperty(file, 'relativePath', { value: relativePath, writable: false });
      outList.push(file);
    } else if (handle.kind === 'directory') {
      const newPath = path ? `${path}/${handle.name}` : handle.name;
      for await (const entry of handle.values()) {
        await this.#traverseHandle(entry, newPath, outList);
      }
    }
  }

  static async #traverseEntry(entry, path, outList) {
    if (entry.isFile) {
      return new Promise((resolve) => {
        entry.file((file) => {
          const relativePath = path ? `${path}/${file.name}` : file.name;
          Object.defineProperty(file, 'relativePath', { value: relativePath, writable: false });
          outList.push(file);
          resolve();
        }, () => resolve());
      });
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const newPath = path ? `${path}/${entry.name}` : entry.name;
      return new Promise((resolve) => {
        const readBatch = () => {
          dirReader.readEntries(async (entries) => {
            if (entries.length === 0) {
              resolve();
            } else {
              for (const child of entries) {
                await this.#traverseEntry(child, newPath, outList);
              }
              readBatch();
            }
          }, () => resolve());
        };
        readBatch();
      });
    }
  }
}
