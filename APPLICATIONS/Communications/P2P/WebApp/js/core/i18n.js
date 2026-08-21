/**
 * Moteur d'Internationalisation Ultra-Léger (< 3 Ko) - Standard 2025/2026
 * - Support PWA & MV3 Chrome Extension
 * - Détection dynamique LTR / RTL via Intl.Locale
 * - Pluralisation native via Intl.PluralRules (Zéro dépendance)
 * - Interpolation de variables et hydratation réactive du DOM
 */

export class I18nEngine {
  constructor() {
    this.locale = 'fr';
    this.fallbackLocale = 'fr';
    this.translations = new Map(); // locale -> object
    this.pluralRules = new Map(); // locale -> Intl.PluralRules
    this.listeners = new Set();
    this.isLoaded = false;
  }

  /**
   * Initialise le moteur i18n et charge la langue persistée ou détectée
   */
  async init(savedLocale = null) {
    let initialLang = savedLocale;
    
    if (!initialLang) {
      if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
        initialLang = chrome.i18n.getUILanguage().split('-')[0].toLowerCase();
      } else if (typeof navigator !== 'undefined') {
        initialLang = (navigator.language || navigator.userLanguage || 'fr').split('-')[0].toLowerCase();
      }
    }

    if (!['fr', 'en'].includes(initialLang)) {
      initialLang = this.fallbackLocale;
    }

    await this.setLocale(initialLang);
  }

  /**
   * Charge un dictionnaire de traduction pour une locale donnée
   */
  async loadLocale(locale) {
    if (this.translations.has(locale)) return;

    try {
      const basePath = typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL(`sidepanel/locales/${locale}.json`)
        : `locales/${locale}.json`;

      const res = await fetch(basePath);
      if (!res.ok) throw new Error(`HTTP ${res.status} chargement locale ${locale}`);
      const data = await res.json();
      this.translations.set(locale, data);
      this.pluralRules.set(locale, new Intl.PluralRules(locale));
    } catch (err) {
      console.warn(`[i18n] Échec chargement du dictionnaire "${locale}":`, err);
      if (locale !== this.fallbackLocale && !this.translations.has(this.fallbackLocale)) {
        await this.loadLocale(this.fallbackLocale);
      }
    }
  }

  /**
   * Change la langue active, met à jour le DOM et la direction LTR/RTL
   */
  async setLocale(locale) {
    const target = ['fr', 'en'].includes(locale) ? locale : this.fallbackLocale;
    
    if (!this.translations.has(target)) {
      await this.loadLocale(target);
    }

    this.locale = target;
    this.isLoaded = true;

    // Mise à jour de la direction LTR / RTL et de la balise HTML
    this.updateDocumentDirection(this.locale);

    // Hydratation globale du DOM
    this.translateDOM();

    // Notification des écouteurs
    this.listeners.forEach(fn => {
      try { fn(this.locale, this.getDirection()); } catch (e) { console.error('[i18n] Erreur listener:', e); }
    });
  }

  /**
   * Retourne la direction du texte pour la locale active ('ltr' | 'rtl')
   */
  getDirection(locale = this.locale) {
    try {
      const loc = new Intl.Locale(locale);
      if (typeof loc.getTextInfo === 'function') {
        return loc.getTextInfo().direction;
      }
    } catch (_) {}
    const rtlLocales = ['ar', 'he', 'fa', 'ur'];
    return rtlLocales.includes(locale) ? 'rtl' : 'ltr';
  }

  /**
   * Met à jour les attributs lang et dir de l'élément racine <html>
   */
  updateDocumentDirection(locale) {
    if (typeof document === 'undefined') return;
    const dir = this.getDirection(locale);
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    document.documentElement.setAttribute('data-locale', locale);
  }

  /**
   * Traduit une clé avec interpolation de variables et gestion des pluriels
   * @param {string} key - Clé de traduction (ex: 'auth.join_group' ou 'chat.new_messages')
   * @param {object} params - Variables à injecter (ex: { name: 'Alice', count: 3 })
   * @returns {string}
   */
  t(key, params = {}) {
    if (!key) return '';

    const dict = this.translations.get(this.locale) || this.translations.get(this.fallbackLocale) || {};
    
    // Résolution de la clé pour pluralisation si paramètre 'count' fourni
    let resolvedKey = key;
    if (typeof params.count === 'number') {
      const pr = this.pluralRules.get(this.locale) || new Intl.PluralRules(this.locale);
      const rule = pr.select(params.count); // 'one', 'other', 'zero', etc.
      const candidateKey = `${key}_${rule}`;
      if (this._getNestedValue(dict, candidateKey) !== undefined) {
        resolvedKey = candidateKey;
      }
    }

    let val = this._getNestedValue(dict, resolvedKey);

    // Fallback vers la langue par défaut si clé manquante
    if (val === undefined && this.locale !== this.fallbackLocale) {
      const fallbackDict = this.translations.get(this.fallbackLocale) || {};
      val = this._getNestedValue(fallbackDict, resolvedKey);
    }

    // Si toujours absent, retourner la clé
    if (val === undefined) {
      return key;
    }

    // Interpolation des variables {varName}
    return String(val).replace(/\{(\w+)\}/g, (match, paramName) => {
      if (params[paramName] !== undefined) {
        return params[paramName];
      }
      return match;
    });
  }

  /**
   * Parcourt un objet JSON imbriqué par chemin à points ('a.b.c')
   */
  _getNestedValue(obj, keyPath) {
    if (!obj || !keyPath) return undefined;
    if (obj[keyPath] !== undefined) return obj[keyPath];
    return keyPath.split('.').reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), obj);
  }

  /**
   * Hydrate automatiquement tous les éléments du DOM portant data-i18n
   */
  translateDOM(root = (typeof document !== 'undefined' ? document : null)) {
    if (!root || typeof root.querySelectorAll !== 'function') return;

    // 1. Traduction du textContent
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;

      let vars = {};
      const varsAttr = el.getAttribute('data-i18n-vars');
      if (varsAttr) {
        try { vars = JSON.parse(varsAttr); } catch (_) {}
      }
      el.textContent = this.t(key, vars);
    });

    // 2. Traduction des attributs spécifiques (placeholder, title, aria-label, alt)
    root.querySelectorAll('[data-i18n-attr]').forEach(el => {
      const raw = el.getAttribute('data-i18n-attr');
      if (!raw) return;

      // Format: "placeholder:auth.placeholder_name|title:auth.title_tooltip"
      raw.split('|').forEach(pair => {
        const [attr, key] = pair.split(':');
        if (attr && key) {
          el.setAttribute(attr.trim(), this.t(key.trim()));
        }
      });
    });
  }

  /**
   * Enregistre un écouteur de changement de langue
   */
  onLocaleChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const i18n = new I18nEngine();
