/**
 * core/task-scheduler.js
 * TaskYieldScheduler - Ordonnancement Coopératif & UI Responsiveness (Pass 4 Hardened 2026)
 * Conforme W3C Prioritized Task Scheduling API & WICG LoAF Standard.
 * Zero-Dependency.
 */

import { logger } from './logger.js';

export class TaskYieldScheduler {
  static DEFAULT_SLICE_BUDGET_MS = 8; // 8ms max par tranche pour garantir INP < 16ms / 60fps
  static LONG_TASK_THRESHOLD_MS = 50;  // Seuil normé W3C Long Task

  // Canaux de communication pour fallback macrotask haute précision (sans clamping 4ms)
  static _messageChannel = null;
  static _messageChannelCallbacks = [];

  static {
    if (typeof MessageChannel !== 'undefined') {
      TaskYieldScheduler._messageChannel = new MessageChannel();
      TaskYieldScheduler._messageChannel.port1.onmessage = () => {
        const callbacks = TaskYieldScheduler._messageChannelCallbacks.splice(0);
        for (let i = 0; i < callbacks.length; i++) {
          try { callbacks[i](); } catch (err) { logger.error('Scheduler', 'Erreur fallback macro-task:', err); }
        }
      };
    }
  }

  /**
   * Cède coopérativement le contrôle au fil principal du navigateur.
   * Priorité : scheduler.yield() -> scheduler.postTask() -> MessageChannel -> setTimeout(0)
   * 
   * @param {Object} options
   * @param {'user-blocking' | 'user-visible' | 'background'} [options.priority='user-visible']
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<void>}
   */
  static async yield({ priority = 'user-visible', signal = null } = {}) {
    if (signal?.aborted) {
      throw new DOMException('Opération annulée pendant le yield', 'AbortError');
    }

    // 1. Standard natif W3C WICG scheduler.yield()
    if (typeof globalThis.scheduler?.yield === 'function') {
      try {
        return await globalThis.scheduler.yield({ priority });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        // Repli transparent si scheduler.yield échoue
      }
    }

    // 2. Repli W3C scheduler.postTask()
    if (typeof globalThis.scheduler?.postTask === 'function') {
      return new Promise((resolve, reject) => {
        globalThis.scheduler.postTask(() => resolve(), { priority, signal }).catch(reject);
      });
    }

    // 3. Repli MessageChannel (Macrotask à 0ms sans clamping de 4ms)
    if (TaskYieldScheduler._messageChannel) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Annulé', 'AbortError'));
        
        let onAbort = null;
        if (signal) {
          onAbort = () => reject(new DOMException('Annulé', 'AbortError'));
          signal.addEventListener('abort', onAbort, { once: true });
        }

        TaskYieldScheduler._messageChannelCallbacks.push(() => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          if (signal?.aborted) return reject(new DOMException('Annulé', 'AbortError'));
          resolve();
        });

        TaskYieldScheduler._messageChannel.port2.postMessage(null);
      });
    }

    // 4. Repli ultime universel : setTimeout(0)
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Annulé', 'AbortError'));
      const timer = setTimeout(() => resolve(), 0);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Annulé', 'AbortError'));
        }, { once: true });
      }
    });
  }

  /**
   * Planifie l'exécution d'une tâche selon son niveau de priorité explicite
   * @template T
   * @param {() => Promise<T> | T} taskFn
   * @param {Object} options
   * @param {'user-blocking' | 'user-visible' | 'background'} [options.priority='user-visible']
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.delay=0]
   * @returns {Promise<T>}
   */
  static async postTask(taskFn, { priority = 'user-visible', signal = null, delay = 0 } = {}) {
    if (typeof globalThis.scheduler?.postTask === 'function') {
      return globalThis.scheduler.postTask(taskFn, { priority, signal, delay });
    }

    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }
    await TaskYieldScheduler.yield({ priority, signal });
    return await taskFn();
  }

  /**
   * Crée un contrôleur de découpage temporel pour les boucles de calcul intensif.
   * @param {Object} config
   * @param {number} [config.budgetMs=8] Budget maximal alloué par frame (ms)
   * @param {'user-blocking' | 'user-visible' | 'background'} [config.priority='background']
   * @param {AbortSignal} [config.signal]
   * @param {string} [config.taskName='loop']
   */
  static createTimeSlicer({
    budgetMs = TaskYieldScheduler.DEFAULT_SLICE_BUDGET_MS,
    priority = 'background',
    signal = null,
    taskName = 'AnonymousTask'
  } = {}) {
    let startSlice = performance.now();
    let totalYields = 0;
    let totalExecutionTime = 0;

    return {
      /**
       * Évalue la consommation du budget temps et cède le fil si nécessaire
       * @returns {Promise<boolean>} Vrai si un yield a eu lieu
       */
      async yieldIfNeeded() {
        if (signal?.aborted) {
          throw new DOMException(`Tâche "${taskName}" interrompue par signal`, 'AbortError');
        }

        const now = performance.now();
        const elapsedSlice = now - startSlice;

        if (elapsedSlice >= budgetMs) {
          totalExecutionTime += elapsedSlice;
          
          if (elapsedSlice >= TaskYieldScheduler.LONG_TASK_THRESHOLD_MS) {
            logger.warn('Scheduler', `⚠️ Long Task évitée de justesse dans "${taskName}" : tranche de ${elapsedSlice.toFixed(1)}ms (>50ms).`);
          }

          await TaskYieldScheduler.yield({ priority, signal });
          totalYields++;
          startSlice = performance.now();
          return true;
        }
        return false;
      },

      /**
       * Cession inconditionnelle du fil
       */
      async forceYield() {
        if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
        await TaskYieldScheduler.yield({ priority, signal });
        totalYields++;
        startSlice = performance.now();
      },

      /**
       * Métriques finales de la session de calcul
       */
      getMetrics() {
        const totalDuration = totalExecutionTime + (performance.now() - startSlice);
        return {
          taskName,
          totalYields,
          totalDurationMs: Math.round(totalDuration),
          averageSliceMs: totalYields > 0 ? Math.round(totalDuration / (totalYields + 1)) : Math.round(totalDuration)
        };
      }
    };
  }

  /**
   * Exécute une boucle itérative sur une collection de façon coopérative sans bloquer l'UI
   * @template T, R
   * @param {Array<T> | Iterable<T>} items
   * @param {(item: T, index: number) => Promise<R> | R} processItemFn
   * @param {Object} options
   * @param {number} [options.budgetMs=8]
   * @param {'user-blocking' | 'user-visible' | 'background'} [options.priority='background']
   * @param {(progressPercent: number, processedCount: number) => void} [options.onProgress]
   * @param {AbortSignal} [options.signal]
   * @param {string} [options.taskName='BatchProcess']
   * @returns {Promise<Array<R>>}
   */
  static async forEachSliced(items, processItemFn, {
    budgetMs = TaskYieldScheduler.DEFAULT_SLICE_BUDGET_MS,
    priority = 'background',
    onProgress = null,
    signal = null,
    taskName = 'BatchProcess'
  } = {}) {
    const slicer = TaskYieldScheduler.createTimeSlicer({ budgetMs, priority, signal, taskName });
    const results = [];
    const arrayItems = Array.isArray(items) ? items : Array.from(items);
    const total = arrayItems.length;

    for (let i = 0; i < total; i++) {
      const itemResult = await processItemFn(arrayItems[i], i);
      results.push(itemResult);

      if (onProgress && total > 0) {
        onProgress(Math.round(((i + 1) / total) * 100), i + 1);
      }

      await slicer.yieldIfNeeded();
    }

    const metrics = slicer.getMetrics();
    logger.debug('Scheduler', `✅ [${taskName}] Traitement terminé (${total} items, ${metrics.totalYields} yields, ${metrics.totalDurationMs}ms).`);
    return results;
  }
}
