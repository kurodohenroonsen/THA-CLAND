/**
 * js/core/lazy-module-loader.js
 * Routeur de Modules Paresseux & Cache de Promesses (Pass 4 Hardened - 2025/2026)
 * - Dynamic import() avec mémoïsation de promesses idempotente
 * - Préchargement en temps mort (requestIdleCallback / requestAnimationFrame)
 * - Cycle de vie sécurisé (load, mount, unmount, teardown)
 * - Tolérance aux pannes réseau / flakiness avec retry automatique
 * - Zéro dépendance externe - Compatible Chrome Extension MV3 Sidepanel & PWA
 */

import { logger } from './logger.js';
import { Toast } from '../ui/toast.js';

export class LazyModuleLoader {
  constructor() {
    this.registry = new Map();
    this.importPromiseCache = new Map();
    this.instances = new Map();
    this.preloadingSet = new Set();
  }

  register(moduleName, importFactory) {
    if (this.registry.has(moduleName)) {
      logger.warn('LazyLoader', `Le module "${moduleName}" est déjà enregistré. Écrasement.`);
    }
    this.registry.set(moduleName, importFactory);
    logger.debug('LazyLoader', `Module "${moduleName}" enregistré dans le catalogue paresseux.`);
  }

  async load(moduleName, context = {}, options = { retries: 2, timeoutMs: 12000 }) {
    if (!this.registry.has(moduleName)) {
      const err = new Error(`Module non enregistré : "${moduleName}"`);
      logger.error('LazyLoader', err.message);
      throw err;
    }

    if (this.instances.has(moduleName)) {
      return this.instances.get(moduleName);
    }

    let modulePromise = this.importPromiseCache.get(moduleName);
    if (!modulePromise) {
      modulePromise = this._importWithRetry(moduleName, options.retries, options.timeoutMs);
      this.importPromiseCache.set(moduleName, modulePromise);
    }

    try {
      const moduleExports = await modulePromise;
      const ControllerClass = this._resolveControllerClass(moduleName, moduleExports);
      if (!ControllerClass) {
        throw new Error(`Classe de contrôleur introuvable dans les exports de "${moduleName}"`);
      }

      logger.info('LazyLoader', `⚡ Instanciation à la demande du contrôleur : "${moduleName}"`);
      const instance = this._instantiateController(moduleName, ControllerClass, context);
      this.instances.set(moduleName, instance);

      return instance;
    } catch (error) {
      this.importPromiseCache.delete(moduleName);
      logger.error('LazyLoader', `Échec critique chargement module "${moduleName}":`, error);
      Toast.error(`Échec du chargement du module ${moduleName}`);
      throw error;
    }
  }

  preload(moduleName, priority = 'idle') {
    if (this.importPromiseCache.has(moduleName) || this.preloadingSet.has(moduleName)) {
      return;
    }
    if (!this.registry.has(moduleName)) return;

    this.preloadingSet.add(moduleName);

    const executeImport = () => {
      logger.debug('LazyLoader', `⏳ Préchargement en tâche de fond (Idle) : "${moduleName}"`);
      const importPromise = this._importWithRetry(moduleName, 1, 15000);
      this.importPromiseCache.set(moduleName, importPromise);
      importPromise
        .then(() => {
          this.preloadingSet.delete(moduleName);
          logger.debug('LazyLoader', `✅ Préchargement terminé avec succès : "${moduleName}"`);
        })
        .catch(err => {
          this.preloadingSet.delete(moduleName);
          this.importPromiseCache.delete(moduleName);
          logger.debug('LazyLoader', `Échec non-bloquant préchargement "${moduleName}":`, err);
        });
    };

    if (priority === 'immediate' || typeof window === 'undefined') {
      executeImport();
    } else if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => executeImport(), { timeout: 3500 });
    } else {
      setTimeout(executeImport, 800);
    }
  }

  isLoaded(moduleName) {
    return this.instances.has(moduleName);
  }

  getLoaded(moduleName) {
    return this.instances.get(moduleName) || null;
  }

  unload(moduleName) {
    if (!this.instances.has(moduleName)) return;

    const instance = this.instances.get(moduleName);
    logger.info('LazyLoader', `🧹 Déchargement et libération mémoire du module : "${moduleName}"`);

    if (typeof instance.destroy === 'function') {
      try { instance.destroy(); } catch (e) { logger.warn('LazyLoader', `Erreur destroy() "${moduleName}":`, e); }
    } else if (typeof instance.teardown === 'function') {
      try { instance.teardown(); } catch (e) { logger.warn('LazyLoader', `Erreur teardown() "${moduleName}":`, e); }
    } else if (typeof instance.unmount === 'function') {
      try { instance.unmount(); } catch (e) { logger.warn('LazyLoader', `Erreur unmount() "${moduleName}":`, e); }
    }

    this.instances.delete(moduleName);
  }

  unloadAll() {
    for (const moduleName of Array.from(this.instances.keys())) {
      this.unload(moduleName);
    }
    this.importPromiseCache.clear();
    this.preloadingSet.clear();
  }

  async _importWithRetry(moduleName, retriesLeft, timeoutMs) {
    const importFactory = this.registry.get(moduleName);
    let attempt = 0;

    while (attempt <= retriesLeft) {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout de chargement (${timeoutMs}ms) pour ${moduleName}`)), timeoutMs)
        );
        return await Promise.race([importFactory(), timeoutPromise]);
      } catch (err) {
        attempt++;
        if (attempt > retriesLeft) throw err;
        const delay = Math.pow(2, attempt) * 200;
        logger.warn('LazyLoader', `Tentative ${attempt}/${retriesLeft} échouée pour "${moduleName}". Réessai dans ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
      }
    }
  }

  _resolveControllerClass(moduleName, moduleExports) {
    if (moduleExports.default && typeof moduleExports.default === 'function') {
      return moduleExports.default;
    }
    const classMap = {
      drive: 'DriveController',
      media: 'CallController',
      call: 'CallController',
      forum: 'ForumController',
      notes: 'NotesController',
      whiteboard: 'WhiteboardController',
      'command-palette': 'CommandPalette'
    };
    const expectedName = classMap[moduleName];
    if (expectedName && moduleExports[expectedName]) {
      return moduleExports[expectedName];
    }
    const firstExport = Object.values(moduleExports).find(v => typeof v === 'function');
    return firstExport || null;
  }

  _instantiateController(moduleName, ControllerClass, context) {
    switch (moduleName) {
      case 'drive':
        return new ControllerClass(context.crdt, context.mesh, context.vault);
      case 'media':
      case 'call':
        return new ControllerClass(context.mesh, context.presence, context.vault);
      case 'forum':
        return new ControllerClass(context.crdt, context.vault);
      case 'notes':
        return new ControllerClass(context.crdt, context.vault);
      case 'whiteboard':
        return new ControllerClass(context.mesh, context.crdt, context.vault);
      case 'command-palette':
        return new ControllerClass(context.app);
      default:
        return new ControllerClass(context);
    }
  }
}

export const lazyLoader = new LazyModuleLoader();
