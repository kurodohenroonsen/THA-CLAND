/**
 * 🌪️ NetworkChaosSimulator - Simulateur de Pannes Réseau & Chaos Engineering P2P (2025/2026)
 * Persona 7.3 : Flakiness Réseau, Gigue, Latence, Perte de Paquets, Partitions & Mesure TTC.
 */

export class NetworkChaosSimulator {
  constructor(options = {}) {
    this.name = options.name || 'P2P-Chaos-Monkey';
    this.enabled = false;
    
    this.profile = {
      baseLatencyMs: 0,
      jitterMs: 0,
      packetLossRatio: 0.0,
      burstLossLength: 0,
      partitionActive: false,
      reorderProbability: 0.0,
      corruptPayloadRatio: 0.0
    };

    this.metrics = {
      totalPacketsSent: 0,
      packetsDelayed: 0,
      packetsDropped: 0,
      packetsReordered: 0,
      partitionsCount: 0,
      ttcMeasurements: []
    };

    this.activePartitions = new Map();
    this.listeners = new Map();
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try { cb(data); } catch (e) { console.error(`[Chaos] Erreur écouteur ${event}:`, e); }
      });
    }
  }

  static get PROFILES() {
    return {
      CLEAN: {
        baseLatencyMs: 0,
        jitterMs: 0,
        packetLossRatio: 0.0,
        reorderProbability: 0.0,
        partitionActive: false
      },
      JITTER_BURST: {
        baseLatencyMs: 40,
        jitterMs: 160,
        packetLossRatio: 0.02,
        reorderProbability: 0.05,
        partitionActive: false
      },
      HIGH_LATENCY_INTERCONTINENTAL: {
        baseLatencyMs: 350,
        jitterMs: 50,
        packetLossRatio: 0.04,
        reorderProbability: 0.02,
        partitionActive: false
      },
      LOSSY_WIFI_4G: {
        baseLatencyMs: 80,
        jitterMs: 70,
        packetLossRatio: 0.18,
        burstLossLength: 2,
        reorderProbability: 0.08,
        partitionActive: false
      },
      EXTREME_PACKET_LOSS: {
        baseLatencyMs: 120,
        jitterMs: 100,
        packetLossRatio: 0.30,
        burstLossLength: 4,
        reorderProbability: 0.15,
        partitionActive: false
      }
    };
  }

  applyProfile(profileNameOrObject) {
    const p = typeof profileNameOrObject === 'string'
      ? NetworkChaosSimulator.PROFILES[profileNameOrObject]
      : profileNameOrObject;

    if (!p) throw new Error(`Profil de chaos inconnu: ${profileNameOrObject}`);
    this.profile = { ...this.profile, ...p };
    this.enabled = true;
    this.emit('profile-changed', { profile: this.profile });
  }

  reset() {
    this.profile = { ...NetworkChaosSimulator.PROFILES.CLEAN };
    this.enabled = false;
    this.clearAllPartitions();
  }

  _computePacketDelay() {
    if (!this.enabled) return 0;
    const base = this.profile.baseLatencyMs || 0;
    const jitterMax = this.profile.jitterMs || 0;
    if (jitterMax <= 0) return base;
    const u1 = Math.random();
    const u2 = Math.random();
    const randStdNormal = Math.sqrt(-2.0 * Math.log(u1 || 1e-6)) * Math.cos(2.0 * Math.PI * u2);
    const jitter = Math.abs(randStdNormal * (jitterMax / 2));
    return Math.round(base + Math.min(jitterMax, jitter));
  }

  _shouldDropPacket() {
    if (!this.enabled) return false;
    if (this.profile.partitionActive) return true;
    const lossRatio = this.profile.packetLossRatio || 0.0;
    return Math.random() < lossRatio;
  }

  wrapDataChannel(dataChannel, peerId = 'unknown') {
    const simulator = this;
    const originalSend = dataChannel.send.bind(dataChannel);

    dataChannel.send = function (data) {
      simulator.metrics.totalPacketsSent++;

      if (simulator.profile.partitionActive) {
        simulator.metrics.packetsDropped++;
        simulator.emit('packet-dropped', { peerId, channel: dataChannel.label, reason: 'network-partition' });
        return;
      }

      if (simulator._shouldDropPacket()) {
        simulator.metrics.packetsDropped++;
        simulator.emit('packet-dropped', { peerId, channel: dataChannel.label, reason: 'random-loss' });
        return;
      }

      const delay = simulator._computePacketDelay();
      if (delay <= 0) {
        return originalSend(data);
      }

      simulator.metrics.packetsDelayed++;
      setTimeout(() => {
        if (dataChannel.readyState === 'open') {
          try {
            originalSend(data);
          } catch (err) {
            console.warn('[Chaos] Erreur envoi différé DataChannel:', err);
          }
        }
      }, delay);
    };

    return dataChannel;
  }

  async injectBrutalPartition(durationMs = 15000, affectedPeers = null) {
    const partitionId = `part_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    this.profile.partitionActive = true;
    this.metrics.partitionsCount++;

    const startTime = Date.now();
    this.emit('partition-started', { partitionId, durationMs, affectedPeers, startTime });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.healPartition(partitionId);
        resolve({ partitionId, durationMs, healedAt: Date.now() });
      }, durationMs);

      this.activePartitions.set(partitionId, timer);
    });
  }

  healPartition(partitionId) {
    if (this.activePartitions.has(partitionId)) {
      clearTimeout(this.activePartitions.get(partitionId));
      this.activePartitions.delete(partitionId);
    }
    this.profile.partitionActive = false;
    const healTime = Date.now();
    this.emit('partition-healed', { partitionId, healTime });
  }

  clearAllPartitions() {
    this.activePartitions.forEach((t) => clearTimeout(t));
    this.activePartitions.clear();
    this.profile.partitionActive = false;
  }

  async measureTimeToConsistency(nodeA, nodeB, stateHashFn, timeoutMs = 30000) {
    const startTime = Date.now();
    const testId = `ttc_${startTime}`;

    this.emit('ttc-measurement-started', { testId, startTime });

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(async () => {
        try {
          const [hashA, hashB] = await Promise.all([stateHashFn(nodeA), stateHashFn(nodeB)]);
          const elapsed = Date.now() - startTime;

          if (hashA === hashB) {
            clearInterval(checkInterval);
            const result = {
              testId,
              converged: true,
              ttcMs: elapsed,
              finalStateHash: hashA
            };
            this.metrics.ttcMeasurements.push(result);
            this.emit('ttc-measurement-completed', result);
            resolve(result);
          } else if (elapsed >= timeoutMs) {
            clearInterval(checkInterval);
            const result = {
              testId,
              converged: false,
              ttcMs: elapsed,
              hashA,
              hashB
            };
            this.metrics.ttcMeasurements.push(result);
            this.emit('ttc-measurement-timeout', result);
            resolve(result);
          }
        } catch (e) {
          clearInterval(checkInterval);
          reject(e);
        }
      }, 100);
    });
  }

  getReport() {
    return {
      name: this.name,
      enabled: this.enabled,
      currentProfile: this.profile,
      metrics: this.metrics,
      lossPercentage: this.metrics.totalPacketsSent > 0
        ? ((this.metrics.packetsDropped / this.metrics.totalPacketsSent) * 100).toFixed(2) + '%'
        : '0%'
    };
  }
}
