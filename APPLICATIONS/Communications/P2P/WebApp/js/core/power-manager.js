/**
 * Gestionnaire Centralisé de l'Énergie & Screen Wake Lock (Standards 2025/2026 - Pass 4 Hardened)
 * - Registre de verrous nommés à comptage de références (Multi-tenant)
 * - Ré-acquisition robuste et non-bloquante (W3C Screen Wake Lock API)
 * - Protection contre la concurrence et cycle de vie Page Lifecycle (visibilitychange / pageshow)
 * - Surveillance de la batterie (Battery Status API) & Bascule Eco-Mode
 * - Pontage MV3 chrome.power
 */

import { logger } from './logger.js';

export class PowerManager {
  constructor() {
    this.activeLocks = new Map(); // lockId -> { reason, timestamp }
    this.sentinel = null;
    this.isSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
    this.battery = null;
    this.isEcoMode = false;
    this.listeners = new Set();
    this.isExtension = typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function';
    this._lockAcquiringPromise = null;

    this.initLifecycleHandlers();
    this.initBatteryMonitoring();
  }

  initLifecycleHandlers() {
    if (typeof document === 'undefined') return;

    const handleVisibility = async () => {
      logger.debug('Power', `Visibility state: "${document.visibilityState}"`);
      if (document.visibilityState === 'visible') {
        if (this.activeLocks.size > 0 && !this.sentinel) {
          logger.info('Power', `🔄 Reprise de visibilité avec ${this.activeLocks.size} verrou(s) actif(s) -> Ré-acquisition.`);
          await this._requestNativeLock();
        }
      } else {
        this.sentinel = null;
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', handleVisibility);
  }

  async initBatteryMonitoring() {
    if (typeof navigator === 'undefined' || !('getBattery' in navigator)) {
      this._checkReducedMotionPreference();
      return;
    }

    try {
      this.battery = await navigator.getBattery();
      const evaluateBattery = () => {
        const levelPct = Math.round(this.battery.level * 100);
        const isCharging = this.battery.charging;
        const lowPower = this.battery.level <= 0.20 && !isCharging;

        logger.debug('Power', `🔋 Batterie: ${levelPct}% (En charge: ${isCharging}) -> EcoMode: ${lowPower}`);
        this.setEcoMode(lowPower);
      };

      this.battery.addEventListener('levelchange', evaluateBattery);
      this.battery.addEventListener('chargingchange', evaluateBattery);
      evaluateBattery();
    } catch (_) {
      this._checkReducedMotionPreference();
    }
  }

  _checkReducedMotionPreference() {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const media = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (media.matches) {
        this.setEcoMode(true);
      }
    }
  }

  setEcoMode(enable) {
    if (this.isEcoMode === enable) return;
    this.isEcoMode = enable;
    logger.info('Power', `🌿 Mode Économie d'Énergie (Eco-Mode): ${enable ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('eco-mode-active', enable);
    }

    this._notifyListeners({ type: 'eco-mode-changed', isEcoMode: this.isEcoMode });
  }

  async acquireLock(lockId, reason = '') {
    if (!lockId) return false;

    this.activeLocks.set(lockId, { reason, timestamp: Date.now() });
    logger.info('Power', `🔒 Verrou demandé [${lockId}] - Raison: "${reason}" (Actifs: ${this.activeLocks.size})`);

    if (this.isSupported && typeof document !== 'undefined' && document.visibilityState === 'visible' && !this.sentinel) {
      await this._requestNativeLock();
    }

    if (this.isExtension) {
      try {
        chrome.runtime.sendMessage({ type: 'KEEP_AWAKE_ACQUIRE', lockId, reason }).catch(() => {});
      } catch (_) {}
    }

    this._notifyListeners({ type: 'locks-changed', activeLocksCount: this.activeLocks.size });
    return true;
  }

  async releaseLock(lockId) {
    if (!this.activeLocks.has(lockId)) return;

    this.activeLocks.delete(lockId);
    logger.info('Power', `🔓 Verrou libéré [${lockId}] (Restants: ${this.activeLocks.size})`);

    if (this.activeLocks.size === 0) {
      if (this.sentinel) {
        try {
          await this.sentinel.release();
        } catch (e) {
          logger.debug('Power', 'Erreur release sentinel:', e);
        }
        this.sentinel = null;
        logger.info('Power', '💤 Tous les verrous sont levés. Veille système autorisée.');
      }

      if (this.isExtension) {
        try {
          chrome.runtime.sendMessage({ type: 'KEEP_AWAKE_RELEASE', lockId }).catch(() => {});
        } catch (_) {}
      }
    }

    this._notifyListeners({ type: 'locks-changed', activeLocksCount: this.activeLocks.size });
  }

  async _requestNativeLock() {
    if (this._lockAcquiringPromise) return this._lockAcquiringPromise;

    this._lockAcquiringPromise = (async () => {
      try {
        if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
        this.sentinel = await navigator.wakeLock.request('screen');
        logger.info('Power', '✅ Screen Wake Lock natif acquis avec succès.');

        this.sentinel.addEventListener('release', () => {
          logger.debug('Power', 'ℹ️ Screen Wake Lock révoqué par le système.');
          this.sentinel = null;
        });
      } catch (err) {
        logger.warn('Power', `⚠️ Screen Wake Lock non acquis: ${err.name} - ${err.message}`);
        this.sentinel = null;
      } finally {
        this._lockAcquiringPromise = null;
      }
    })();

    return this._lockAcquiringPromise;
  }

  onPowerEvent(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  _notifyListeners(event) {
    this.listeners.forEach((fn) => {
      try { fn(event); } catch (_) {}
    });
  }
}

export const powerManager = new PowerManager();
