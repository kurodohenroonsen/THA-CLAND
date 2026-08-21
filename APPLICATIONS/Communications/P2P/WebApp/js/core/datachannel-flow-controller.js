/**
 * core/datachannel-flow-controller.js
 * Régulateur de Débit Adaptatif & Contre-Pression Événementielle WebRTC DataChannel (2025/2026)
 * Persona G6.P5 (Pass 4 Hardened)
 * 
 * - Estimation adaptative de bande passante en boucle fermée (Drain-Rate EWMA)
 * - Dimensionnement dynamique du BDP (Bandwidth-Delay Product) sans constante statique
 * - Détection de congestion par gradient de délai (Algorithme LEDBAT-in-JS)
 * - Sanctuarisation absolue du trafic interactif (Chat & Voix / Vidéo)
 * - Découpage adaptatif des tranches (8 Ko à 32 Ko) avec micro-yielding coopératif
 * - Résolution événementielle pure (bufferedamountlow) sans fuite mémoire ni polling
 */

import { logger } from './logger.js';

export class DataChannelFlowController {
  constructor(options = {}) {
    this.minLowThreshold = options.minLowThreshold || (16 * 1024);     // 16 Ko minimum
    this.maxLowThreshold = options.maxLowThreshold || (1024 * 1024);   // 1 Mo maximum
    this.defaultChunkSize = options.defaultChunkSize || 16384;         // 16 Ko standard
    this.headerSize = options.headerSize || 41;                        // 41 octets en-tête Drive

    // File d'attente FIFO par canal pour sérialiser les envois multiples (Mutex)
    this._channelQueues = new WeakMap();

    // État d'apprentissage et métriques par canal
    this._channelMetrics = new WeakMap();

    // RTT de référence minimal (Base RTT pour calcul LEDBAT)
    this.baseRttMs = 9999;
  }

  /**
   * Obtient ou initialise l'état télémétrique d'un canal
   */
  _getOrCreateMetrics(dc) {
    if (!dc || typeof dc !== 'object') {
      return {
        smoothedBandwidth: 4 * 1024 * 1024,
        lastDrainTimestamp: 0,
        bytesQueuedSinceDrain: 0,
        consecutiveTimeouts: 0,
        drainEventsCount: 0,
        minRttObserved: 9999
      };
    }
    let m = this._channelMetrics.get(dc);
    if (!m) {
      m = {
        smoothedBandwidth: 4 * 1024 * 1024, // 4 Mo/s estimation initiale prudente
        lastDrainTimestamp: 0,
        bytesQueuedSinceDrain: 0,
        consecutiveTimeouts: 0,
        drainEventsCount: 0,
        minRttObserved: 9999
      };
      this._channelMetrics.set(dc, m);
    }
    return m;
  }

  /**
   * Met à jour le RTT de référence observé
   */
  updateRttSample(rttMs) {
    if (typeof rttMs === 'number' && rttMs > 0) {
      if (rttMs < this.baseRttMs) {
        this.baseRttMs = rttMs;
      }
    }
  }

  /**
   * Calcule les seuils optimaux (LowThreshold & HighWatermark) ainsi que le pacing
   */
  computeOptimalThresholds(arg1 = 30, arg2 = false, arg3 = false, arg4 = null) {
    let dc = null;
    let rttMs = 30;
    let isMediaActive = false;
    let availableOutgoingBitrate = null;

    if (typeof arg1 === 'number') {
      rttMs = arg1;
      isMediaActive = Boolean(arg2);
      availableOutgoingBitrate = typeof arg3 === 'number' ? arg3 : null;
    } else {
      dc = arg1;
      rttMs = typeof arg2 === 'number' ? arg2 : 30;
      isMediaActive = Boolean(arg3);
      availableOutgoingBitrate = typeof arg4 === 'number' ? arg4 : null;
    }

    this.updateRttSample(rttMs);
    const metrics = this._getOrCreateMetrics(dc);

    // 1. Estimation de la bande passante disponible
    let effectiveBwBytesPerSec = metrics.smoothedBandwidth;
    if (availableOutgoingBitrate && availableOutgoingBitrate > 0) {
      // Intégration prioritaire de la bande passante estimée par RTCPeerConnection getStats()
      effectiveBwBytesPerSec = Math.round(availableOutgoingBitrate / 8);
    }

    // 2. Détection de congestion LEDBAT (Gradient de délai)
    const delayGradient = Math.max(0, rttMs - (this.baseRttMs === 9999 ? rttMs : this.baseRttMs));
    const isCongested = delayGradient > 40 || rttMs > 250;

    // 3. Calcul du BDP
    const effectiveRttSec = Math.max(0.01, rttMs / 1000);
    const rawBdp = effectiveBwBytesPerSec * effectiveRttSec;

    let lowThreshold;
    let highWatermark;
    let sliceSize;
    let interSlicePacingMs = 0;

    if (isMediaActive) {
      // 🎙️ Mode Voix/Média Actif : Sanctuarisation absolue, buffer restreint
      sliceSize = 8192; // 8 Ko pour minimiser l'occupation ponctuelle de la socket
      lowThreshold = 32 * 1024; // 32 Ko
      highWatermark = 64 * 1024; // 64 Ko
      interSlicePacingMs = isCongested ? 25 : 8; // Pacing forcé pour laisser passer RTP
    } else if (isCongested) {
      // ⚠️ Mode Congestion Réseau : Réduction de moitié et pacing modéré
      sliceSize = 8192;
      lowThreshold = Math.max(this.minLowThreshold, Math.min(64 * 1024, Math.floor(rawBdp * 0.25)));
      highWatermark = lowThreshold + (2 * sliceSize);
      interSlicePacingMs = Math.min(40, Math.round(delayGradient * 0.5));
    } else {
      // 🚀 Mode Nominal (100% Bande Passante Drive)
      // Ajustement de la taille de tranche selon la vitesse
      sliceSize = effectiveBwBytesPerSec > 20 * 1024 * 1024 ? 32768 : 16384;
      
      // Low threshold calibré à ~50% du BDP pour assurer un débit continu sans trou de bulle
      lowThreshold = Math.max(this.minLowThreshold, Math.min(this.maxLowThreshold, Math.floor(rawBdp * 0.5)));
      highWatermark = lowThreshold + (4 * sliceSize);
      interSlicePacingMs = 0;
    }

    return {
      lowThreshold,
      highWatermark,
      sliceSize,
      interSlicePacingMs,
      estimatedBandwidth: effectiveBwBytesPerSec,
      delayGradient
    };
  }

  /**
   * Attente asynchrone non-bloquante du dégonflement du buffer SCTP avec mesure de débit
   */
  async waitForDrain(dc, targetThreshold, signal = null, timeoutMs = null) {
    if (dc.readyState !== 'open') {
      throw new Error(`DataChannel fermé (readyState: ${dc.readyState})`);
    }

    if (dc.bufferedAmount <= targetThreshold) {
      return 0;
    }

    const metrics = this._getOrCreateMetrics(dc);
    const startBuffered = dc.bufferedAmount;
    const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    if (dc.bufferedAmountLowThreshold !== targetThreshold) {
      dc.bufferedAmountLowThreshold = targetThreshold;
    }

    // Timeout dynamique : proportionnel au volume à drainer et au RTT
    const effectiveTimeout = timeoutMs || Math.max(1500, Math.min(10000, Math.round((startBuffered / 10000) * 1000)));

    return new Promise((resolve, reject) => {
      let cleaned = false;
      let timer = null;

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer) clearTimeout(timer);
        dc.removeEventListener('bufferedamountlow', onLow);
        dc.removeEventListener('close', onClose);
        dc.removeEventListener('error', onError);
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      const recordDrainMeasurement = () => {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const elapsedMs = Math.max(1, now - startTime);
        const bytesDrained = Math.max(0, startBuffered - dc.bufferedAmount);
        if (bytesDrained > 0 && elapsedMs > 2) {
          const sampleBw = (bytesDrained / elapsedMs) * 1000;
          // Lissage EWMA (Facteur alpha 0.85)
          metrics.smoothedBandwidth = Math.round((metrics.smoothedBandwidth * 0.85) + (sampleBw * 0.15));
          metrics.drainEventsCount++;
        }
      };

      const onLow = () => {
        recordDrainMeasurement();
        cleanup();
        metrics.consecutiveTimeouts = 0;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        resolve(now - startTime);
      };

      const onClose = () => {
        cleanup();
        reject(new Error('RTCDataChannel fermé pendant l\'attente de contre-pression'));
      };

      const onError = (e) => {
        cleanup();
        reject(new Error(`Erreur RTCDataChannel: ${e.message || 'inconnue'}`));
      };

      const onAbort = () => {
        cleanup();
        reject(new DOMException('Envoi annulé par AbortSignal', 'AbortError'));
      };

      timer = setTimeout(() => {
        recordDrainMeasurement();
        cleanup();
        metrics.consecutiveTimeouts++;
        logger.debug('FlowControl', `Attente drain timeout (${effectiveTimeout}ms). bufferedAmount: ${dc.bufferedAmount}`);
        resolve(effectiveTimeout);
      }, effectiveTimeout);

      dc.addEventListener('bufferedamountlow', onLow);
      dc.addEventListener('close', onClose);
      dc.addEventListener('error', onError);
      if (signal) signal.addEventListener('abort', onAbort);

      // Double vérification au cas où le seuil aurait été atteint immédiatement
      if (dc.bufferedAmount <= targetThreshold) {
        cleanup();
        resolve(0);
      }
    });
  }

  /**
   * Envoi sérialisé et cadencé d'un bloc de données volumineux découpé en tranches
   */
  async sendBinaryChunkPaced(dc, hashHex, arrayBuffer, options = {}) {
    if (!dc || dc.readyState !== 'open') return false;

    let queue = this._channelQueues.get(dc);
    if (!queue) {
      queue = Promise.resolve();
      this._channelQueues.set(dc, queue);
    }

    const currentTask = queue.then(async () => {
      return this._executeChunkSend(dc, hashHex, arrayBuffer, options);
    });

    this._channelQueues.set(dc, currentTask.catch(() => {}));
    return currentTask;
  }

  async _executeChunkSend(dc, hashHex, arrayBuffer, options) {
    const {
      rttMs = 30,
      isMediaActive = false,
      availableOutgoingBitrate = null,
      signal = null,
      onProgress = null
    } = options;

    const rawHashBytes = this._hexToUint8(hashHex);
    let offset = 0;
    let sliceIdx = 0;
    const totalBytes = arrayBuffer.byteLength;

    // Première estimation des paramètres
    let params = this.computeOptimalThresholds(dc, rttMs, isMediaActive, availableOutgoingBitrate);
    const payloadPerSlice = params.sliceSize - this.headerSize;
    const totalSlices = Math.ceil(totalBytes / payloadPerSlice);

    while (offset < totalBytes) {
      if (signal?.aborted) {
        throw new DOMException('Transfert annulé', 'AbortError');
      }
      if (dc.readyState !== 'open') {
        throw new Error('DataChannel déconnecté en cours de transfert');
      }

      // Réévaluation périodique des seuils (toutes les 4 tranches)
      if (sliceIdx % 4 === 0) {
        params = this.computeOptimalThresholds(dc, rttMs, isMediaActive, availableOutgoingBitrate);
      }

      // Application de la contre-pression adaptative
      if (dc.bufferedAmount >= params.highWatermark) {
        await this.waitForDrain(dc, params.lowThreshold, signal);
      }

      const end = Math.min(offset + payloadPerSlice, totalBytes);
      const sliceLength = end - offset;

      // Construction du paquet binaire Drive optimisé Zero-Copy
      const packet = new Uint8Array(this.headerSize + sliceLength);
      packet[0] = 0xFD; // Magic Byte Bloc Drive
      packet.set(rawHashBytes, 1);

      const view = new DataView(packet.buffer);
      view.setUint16(33, sliceIdx, false);
      view.setUint16(35, totalSlices, false);
      view.setUint32(37, totalBytes, false);

      packet.set(new Uint8Array(arrayBuffer, offset, sliceLength), this.headerSize);

      // Émission sur la RTCDataChannel
      dc.send(packet.buffer);

      offset += sliceLength;
      sliceIdx++;

      if (onProgress) {
        onProgress({
          sliceIdx,
          totalSlices,
          bytesSent: offset,
          totalBytes
        });
      }

      // Pacing inter-tranches (LEDBAT / Audio Shield) & Yielding coopératif pour la boucle d'événements
      if (params.interSlicePacingMs > 0) {
        await new Promise((r) => setTimeout(r, params.interSlicePacingMs));
      } else if (sliceIdx % 8 === 0) {
        // Micro-yield pour laisser respirer le thread d'interface et les canaux de contrôle
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    return true;
  }

  _hexToUint8(hexStr) {
    const cleanHex = hexStr.length % 2 !== 0 ? '0' + hexStr : hexStr;
    const bytes = new Uint8Array(cleanHex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
    }
    return bytes;
  }
}
