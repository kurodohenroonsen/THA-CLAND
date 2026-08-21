/**
 * SanitizerService.js
 * Module Centralisé de Sécurité DOM, Trusted Types & Assainissement P2P (2025/2026)
 * Protection contextuelle contre les failles XSS, Path Traversal, Injection d'Attributs et Spoofing RTLO.
 */

// Création de la politique Trusted Types (si supportée par l'environnement)
let trustedPolicy = null;
if (typeof window !== 'undefined' && window.trustedTypes && window.trustedTypes.createPolicy) {
  try {
    trustedPolicy = window.trustedTypes.createPolicy('p2p-mesh-dom', {
      createHTML: (string) => SanitizerService._pureSanitizeHTML(string),
      createScriptURL: (string) => {
        if (/^(https:\/\/|blob:)/i.test(string)) return string;
        throw new Error(`[Security] Script URL non autorisée: ${string}`);
      }
    });
  } catch (err) {
    // Politique déjà existante ou environnement restreint
  }
}

export class SanitizerService {
  /**
   * Échappe tous les caractères dangereux pour une insertion sécurisée dans le corps HTML ET dans les attributs.
   * Remplace &, <, >, ", ', ` et / par leurs entités HTML respectives.
   */
  static escape(str) {
    if (str === null || str === undefined) return '';
    const s = String(str);
    return s.replace(/[&<>"'`\/]/g, (char) => {
      switch (char) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#x27;';
        case '`': return '&#x60;';
        case '/': return '&#x2F;';
        default: return char;
      }
    });
  }

  /**
   * Assainit une chaîne HTML et retourne un objet TrustedHTML ou une chaîne assainie.
   */
  static sanitizeHTML(dirtyHtml) {
    if (trustedPolicy) {
      return trustedPolicy.createHTML(dirtyHtml);
    }
    return SanitizerService._pureSanitizeHTML(dirtyHtml);
  }

  /**
   * Moteur d'assainissement avec liste blanche stricte de balises et attributs.
   */
  static _pureSanitizeHTML(dirty) {
    if (!dirty || typeof dirty !== 'string') return '';
    
    if (typeof DOMParser === 'undefined') {
      return SanitizerService.escape(dirty);
    }

    const doc = new DOMParser().parseFromString(dirty, 'text/html');
    const allowedTags = new Set([
      'STRONG', 'EM', 'B', 'I', 'CODE', 'PRE', 'A', 'P', 'BR',
      'SPAN', 'DIV', 'BLOCKQUOTE', 'UL', 'OL', 'LI'
    ]);
    const allowedAttrs = {
      'A': new Set(['href', 'target', 'rel', 'class', 'title']),
      'SPAN': new Set(['class', 'data-channel-id', 'data-seeders', 'title']),
      'DIV': new Set(['class', 'title']),
      'CODE': new Set(['class'])
    };

    function cleanNode(node) {
      const children = Array.from(node.childNodes);
      for (const child of children) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName.toUpperCase();
          if (!allowedTags.has(tag)) {
            const text = document.createTextNode(child.textContent);
            node.replaceChild(text, child);
          } else {
            const allowed = allowedAttrs[tag] || new Set();
            for (const attr of Array.from(child.attributes)) {
              const name = attr.name.toLowerCase();
              if (!allowed.has(name) || name.startsWith('on') || name.startsWith('data-js')) {
                child.removeAttribute(attr.name);
                continue;
              }
              if (name === 'href' || name === 'src') {
                const val = attr.value.trim().toLowerCase();
                if (val.startsWith('javascript:') || val.startsWith('data:') || val.startsWith('vbscript:')) {
                  child.removeAttribute(attr.name);
                } else if (tag === 'A') {
                  child.setAttribute('target', '_blank');
                  child.setAttribute('rel', 'noopener noreferrer');
                }
              }
            }
            cleanNode(child);
          }
        }
      }
    }

    cleanNode(doc.body);
    return doc.body.innerHTML;
  }

  /**
   * Assainit le texte d'un message chat (Markdown basique + URLs).
   */
  static formatSafeChatMessage(rawText) {
    if (!rawText) return '';
    let escaped = SanitizerService.escape(rawText);

    // Markdown simplifié sur contenu DÉJÀ échappé
    escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/\*(.*?)\*/g, '<em>$1</em>');
    escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

    // URLs http/https strictement validées sans possibilité de sortir de l'attribut href
    escaped = escaped.replace(/(https?:\/\/[^\s&"<>]+)/g, (url) => {
      return `<a href="${url}" class="p2p-external-link" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

    return SanitizerService.sanitizeHTML(escaped);
  }

  /**
   * Valide et nettoie les noms de fichiers pour les téléchargements et le Drive.
   * Neutralise Path Traversal, RTLO (U+202E), caractères de contrôle et noms réservés.
   */
  static sanitizeFileName(fileName, fallback = 'fichier.bin') {
    if (!fileName || typeof fileName !== 'string') return fallback;
    
    // 1. Ne conserve que le nom de base (supprime les séparateurs de dossiers)
    let clean = fileName.replace(/^.*[\\\\\\/]/, '');
    
    // 2. Supprime les caractères de contrôle et les caractères Unicode d'inversion d'écriture (RTLO / LTRO)
    clean = clean.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E]/g, '');
    
    // 3. Remplacement des caractères interdits dans les systèmes de fichiers
    clean = clean.replace(/[\\\\/:*?\"<>|]/g, '_').trim();
    
    // 4. Protection contre les noms réservés Windows (CON, PRN, AUX, NUL, COM1..9, LPT1..9)
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(clean)) {
      clean = `safe_${clean}`;
    }

    // 5. Troncation de sécurité (250 octets max)
    if (clean.length > 250) {
      const extMatch = clean.match(/\.[a-zA-Z0-9]{1,8}$/);
      const ext = extMatch ? extMatch[0] : '';
      clean = clean.substring(0, 245 - ext.length) + ext;
    }

    return clean || fallback;
  }

  /**
   * Valide les URIs d'images (avatars) pour bloquer javascript: et données arbitraires.
   */
  static isSafeImageURI(uri) {
    if (!uri || typeof uri !== 'string') return false;
    const clean = uri.trim();
    if (clean.startsWith('data:image/svg+xml;utf8,<svg') ||
        clean.startsWith('data:image/png;base64,') ||
        clean.startsWith('data:image/jpeg;base64,') ||
        clean.startsWith('data:image/webp;base64,') ||
        clean.startsWith('blob:') ||
        clean.startsWith('https://')) {
      return true;
    }
    return false;
  }
}
