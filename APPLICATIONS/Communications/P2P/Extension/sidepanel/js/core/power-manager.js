/**
 * Gestionnaire Centralisé de l'Énergie & Screen Wake Lock (Standards 2025/2026)
 * - Registre de verrous d'activité nommés à comptage de références (Multi-tenant)
 * - Ré-acquisition automatique sur reprise de visibilité (W3C Screen Wake Lock API)
 * - Surveillance de la batterie (Battery Status API) & Bascule Eco-Mode
 * - Pontage vers chrome.power en contexte Extension Chrome MV3
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

    this.initVisibilityHandler();
    this.initBatteryMonitoring();
  }

  /**
   * Initialise la surveillance du cycle de vie de la page pour la ré-acquisition
   */
  initVisibilityHandler() {
    if (typeof document === 'undefined') return;

    document.addEventListener('visibilitychange', async () => {
      logger.debug('Power', `Visibility state changé: "${document.visibilityState}"`);
      if (document.visibilityState === 'visible') {
        if (this.activeLocks.size > 0 && !this.sentinel) {
          logger.info('Power', `🔄 Reprise de visibilité avec ${this.activeLocks.size} verrou(s) actif(s) -> Ré-acquisition.`);
          await this._requestNativeLock();
        }
      } else {
        // La sentinelle est révoquée automatiquement par le navigateur
        this.sentinel = null;
      }
    });
  }

  /**
   * Initialise la détection de la batterie (Battery Status API)
   */
  async initBatteryMonitoring() {
    if (typeof navigator === 'undefined' || !('getBattery' in navigator)) return;

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
    } catch (err) {
      logger.debug('Power', 'Battery Status API indisponible ou restreinte:', err);
    }
  }

  /**
   * Active ou désactive le mode Économie d'Énergie
   */
  setEcoMode(enable) {
    if (this.isEcoMode === enable) return;
    this.isEcoMode = enable;
    logger.info('Power', `🌿 Mode Économie d'Énergie (Eco-Mode): ${enable ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('eco-mode-active', enable);
    }

    this._notifyListeners({ type: 'eco-mode-changed', isEcoMode: this.isEcoMode });
  }

  /**
   * Acquiert un verrou d'écran pour une opération critique
   */
  async acquireLock(lockId, reason = '') {
    if (!lockId) return false;

    this.activeLocks.set(lockId, { reason, timestamp: Date.now() });
    logger.info('Power', `🔒 Verrou demandé [${lockId}] - Raison: "${reason}" (Total actifs: ${this.activeLocks.size})`);

    // 1. Verrou natif Web Screen Wake Lock
    if (this.isSupported && typeof document !== 'undefined' && document.visibilityState === 'visible' && !this.sentinel) {
      await this._requestNativeLock();
    }

    // 2. Maintien en tâche de fond Extension MV3
    if (this.isExtension) {
      try {
        chrome.runtime.sendMessage({ type: 'KEEP_AWAKE_ACQUIRE', lockId, reason }).catch(() => {});
      } catch (_) {}
    }

    this._notifyListeners({ type: 'locks-changed', activeLocksCount: this.activeLocks.size });
    return true;
  }

  /**
   * Libère un verrou d'activité
   */
  async releaseLock(lockId) {
    if (!this.activeLocks.has(lockId)) return;

    this.activeLocks.delete(lockId);
    logger.info('Power', `🔓 Verrou libéré [${lockId}] (Restants actifs: ${this.activeLocks.size})`);

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
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      logger.info('Power', '✅ Screen Wake Lock natif acquis avec succès.');

      this.sentinel.addEventListener('release', () => {
        logger.debug('Power', 'ℹ️ Screen Wake Lock révoqué par le système/navigateur.');
        this.sentinel = null;
      });
    } catch (err) {
      logger.warn('Power', `⚠️ Impossible d'acquérir le Screen Wake Lock: ${err.name} - ${err.message}`);
      this.sentinel = null;
    }
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
