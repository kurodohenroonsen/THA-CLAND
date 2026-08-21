/**
 * core/memory-leak-detector.js
 * Détecteur de Fuites Mémoire Heap & Gestionnaire de Nettoyage Automatique (Pass 4 Hardened 2026)
 * Persona G7.P1 - Zero-Dependency / V8 & Web Standards Compliant
 */

import { logger } from './logger.js';

export class AutoCleanupTracker {
  constructor(name = 'GenericTracker') {
    this.name = name;
    this.abortController = new AbortController();
    
    this._intervals = new Set();
    this._timeouts = new Set();
    this._peerConnections = new Set();
    this._dataChannels = new Set();
    this._mediaStreams = new Set();
    this._mediaTracks = new Set();
    this._audioContexts = new Set();
    this._audioNodes = new Set();
    this._streamReaders = new Set();
    this._streamWriters = new Set();
    this._disposables = new Set();

    this.isDestroyed = false;
  }

  get signal() {
    return this.abortController.signal;
  }

  addEventListener(target, type, listener, options = {}) {
    if (this.isDestroyed || !target || typeof target.addEventListener !== 'function') return;
    const combinedOptions = {
      ...options,
      signal: this.abortController.signal
    };
    target.addEventListener(type, listener, combinedOptions);
  }

  setInterval(fn, ms) {
    if (this.isDestroyed) return null;
    const id = setInterval(fn, ms);
    this._intervals.add(id);
    return id;
  }

  clearInterval(id) {
    if (!id) return;
    clearInterval(id);
    this._intervals.delete(id);
  }

  setTimeout(fn, ms) {
    if (this.isDestroyed) return null;
    let id = null;
    id = setTimeout(() => {
      this._timeouts.delete(id);
      fn();
    }, ms);
    this._timeouts.add(id);
    return id;
  }

  clearTimeout(id) {
    if (!id) return;
    clearTimeout(id);
    this._timeouts.delete(id);
  }

  trackPeerConnection(pc) {
    if (!pc || this.isDestroyed) return pc;
    this._peerConnections.add(pc);
    return pc;
  }

  trackDataChannel(dc) {
    if (!dc || this.isDestroyed) return dc;
    this._dataChannels.add(dc);
    return dc;
  }

  trackMediaStream(stream) {
    if (!stream || this.isDestroyed) return stream;
    this._mediaStreams.add(stream);
    stream.getTracks().forEach(t => this.trackMediaTrack(t));
    return stream;
  }

  trackMediaTrack(track) {
    if (!track || this.isDestroyed) return track;
    this._mediaTracks.add(track);
    return track;
  }

  trackAudioContext(ctx) {
    if (!ctx || this.isDestroyed) return ctx;
    this._audioContexts.add(ctx);
    return ctx;
  }

  trackAudioNode(node) {
    if (!node || this.isDestroyed) return node;
    this._audioNodes.add(node);
    return node;
  }

  trackStreamReader(reader) {
    if (!reader || this.isDestroyed) return reader;
    this._streamReaders.add(reader);
    return reader;
  }

  trackStreamWriter(writer) {
    if (!writer || this.isDestroyed) return writer;
    this._streamWriters.add(writer);
    return writer;
  }

  addDisposable(cleanupFn) {
    if (typeof cleanupFn === 'function' && !this.isDestroyed) {
      this._disposables.add(cleanupFn);
    }
  }

  destroy() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    try {
      this.abortController.abort();
    } catch (_) {}

    this._intervals.forEach(id => clearInterval(id));
    this._intervals.clear();

    this._timeouts.forEach(id => clearTimeout(id));
    this._timeouts.clear();

    this._streamReaders.forEach(r => {
      try { r.releaseLock(); } catch (_) {}
    });
    this._streamReaders.clear();

    this._streamWriters.forEach(w => {
      try { w.releaseLock(); } catch (_) {}
    });
    this._streamWriters.clear();

    this._audioNodes.forEach(node => {
      try { node.disconnect(); } catch (_) {}
    });
    this._audioNodes.clear();

    this._audioContexts.forEach(ctx => {
      try {
        if (ctx.state !== 'closed') ctx.close();
      } catch (_) {}
    });
    this._audioContexts.clear();

    this._mediaTracks.forEach(track => {
      try {
        track.stop();
        track.enabled = false;
      } catch (_) {}
    });
    this._mediaTracks.clear();
    this._mediaStreams.clear();

    this._dataChannels.forEach(dc => {
      try {
        dc.onopen = null;
        dc.onmessage = null;
        dc.onerror = null;
        dc.onclose = null;
        if (dc.readyState !== 'closed') dc.close();
      } catch (_) {}
    });
    this._dataChannels.clear();

    this._peerConnections.forEach(pc => {
      try {
        pc.ontrack = null;
        pc.ondatachannel = null;
        pc.onicecandidate = null;
        pc.oniceconnectionstatechange = null;
        pc.onconnectionstatechange = null;
        pc.onsignalingstatechange = null;
        if (pc.signalingState !== 'closed') pc.close();
      } catch (_) {}
    });
    this._peerConnections.clear();

    this._disposables.forEach(fn => {
      try { fn(); } catch (e) { logger.warn('Tracker', `Erreur disposable ${this.name}:`, e); }
    });
    this._disposables.clear();

    logger.debug('Tracker', `🧹 [${this.name}] Toutes les ressources ont été libérées avec succès.`);
  }
}

export class MemoryLeakDetector {
  constructor(options = {}) {
    this.enabled = options.enabled !== undefined ? options.enabled : true;
    this.alertThresholdMs = options.alertThresholdMs || 15000;
    
    this._trackedTargets = new Map();
    this._collectedCount = 0;
    this._leakWarningCount = 0;

    this._registry = (typeof FinalizationRegistry !== 'undefined' && this.enabled)
      ? new FinalizationRegistry((heldTag) => {
          this._onObjectFinalized(heldTag);
        })
      : null;

    if (this.enabled && typeof setInterval !== 'undefined') {
      this._checkInterval = setInterval(() => this.auditPendingObjects(), 10000);
      if (this._checkInterval?.unref) this._checkInterval.unref();
    }
  }

  watch(target, tag, context = {}) {
    if (!this.enabled || !target || typeof target !== 'object') return target;

    const id = `track_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`;
    const entry = {
      id,
      tag: `${tag}#${id.slice(6, 11)}`,
      weakRef: new WeakRef(target),
      registeredAt: Date.now(),
      expectedReleaseAt: Date.now() + this.alertThresholdMs,
      context,
      warned: false
    };

    this._trackedTargets.set(entry.tag, entry);

    if (this._registry) {
      this._registry.register(target, entry.tag, entry);
    }

    return target;
  }

  _onObjectFinalized(heldTag) {
    this._collectedCount++;
    const entry = this._trackedTargets.get(heldTag);
    if (entry) {
      const elapsed = Date.now() - entry.registeredAt;
      logger.debug('LeakDetector', `♻️ [GC Cleaned] Objet libéré et collecté par V8 : ${heldTag} (en ${elapsed}ms)`);
      this._trackedTargets.delete(heldTag);
    }
  }

  auditPendingObjects() {
    if (!this.enabled) return [];
    const now = Date.now();
    const leaking = [];

    for (const [tag, entry] of this._trackedTargets) {
      const target = entry.weakRef.deref();
      if (!target) {
        this._trackedTargets.delete(tag);
        continue;
      }

      if (now > entry.expectedReleaseAt) {
        leaking.push({
          tag,
          retainedTimeMs: now - entry.registeredAt,
          context: entry.context
        });

        if (!entry.warned) {
          entry.warned = true;
          this._leakWarningCount++;
          logger.warn('LeakDetector', `⚠️ [FUITE MÉMOIRE SUSPECTE] L'objet "${tag}" est toujours retenu en RAM après ${now - entry.registeredAt}ms !`, entry.context);
        }
      }
    }

    return leaking;
  }

  getDiagnostics() {
    const memory = (typeof performance !== 'undefined' && performance.memory)
      ? {
          usedJSHeapSize: (performance.memory.usedJSHeapSize / 1048576).toFixed(2) + ' Mo',
          totalJSHeapSize: (performance.memory.totalJSHeapSize / 1048576).toFixed(2) + ' Mo',
          jsHeapSizeLimit: (performance.memory.jsHeapSizeLimit / 1048576).toFixed(2) + ' Mo'
        }
      : 'Non disponible';

    const pending = [];
    for (const [tag, entry] of this._trackedTargets) {
      if (entry.weakRef.deref()) {
        pending.push({
          tag,
          ageMs: Date.now() - entry.registeredAt,
          warned: entry.warned
        });
      }
    }

    return {
      enabled: this.enabled,
      memory,
      activeWatchCount: this._trackedTargets.size,
      totalCollectedCount: this._collectedCount,
      totalLeakWarnings: this._leakWarningCount,
      pendingObjects: pending
    };
  }

  destroy() {
    if (this._checkInterval) clearInterval(this._checkInterval);
    this._trackedTargets.clear();
  }
}

export const memoryLeakDetector = new MemoryLeakDetector({ enabled: true, alertThresholdMs: 20000 });
