/**
 * device-manager.js - Gestionnaire Universel de Périphériques Audio/Vidéo, Permissions & Failover (Pass 4 Hardened)
 * P2P Mesh Workspace (2025/2026)
 * - Inventaire matériel avec analyse différentielle (Diffing)
 * - Debounce 350ms sur 'devicechange' & auto-failover
 * - Permissions API W3C monitoring
 * - Usine de flux virtuels de secours (Silent Audio Track & Canvas Placeholder)
 */

import { logger } from '../../core/logger.js';

export class DeviceManager {
  constructor() {
    this.audioInputs = [];
    this.audioOutputs = [];
    this.videoInputs = [];

    this.activeAudioInputId = 'default';
    this.activeVideoInputId = 'default';
    this.activeAudioOutputId = 'default';

    this.permissions = {
      microphone: 'prompt',
      camera: 'prompt',
      speakerSelection: 'prompt'
    };

    this.listeners = new Set();
    this.deviceLossListeners = new Set();
    this.debounceTimer = null;
    this.isRecovering = false;

    this.placeholderCanvas = null;
    this.placeholderAnimationId = null;

    this.initPermissionsMonitoring();
    this.initHardwareMonitoring();
  }

  async initPermissionsMonitoring() {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;

    const querySpecs = [
      { key: 'microphone', name: 'microphone' },
      { key: 'camera', name: 'camera' },
      { key: 'speakerSelection', name: 'speaker-selection' }
    ];

    for (const spec of querySpecs) {
      try {
        const status = await navigator.permissions.query({ name: spec.name });
        this.permissions[spec.key] = status.state;
        
        status.onchange = async () => {
          logger.info('DeviceManager', `🔒 Permission '${spec.name}' modifiée: ${status.state}`);
          this.permissions[spec.key] = status.state;
          if (status.state === 'granted') {
            await this.refreshDeviceInventory();
          }
        };
      } catch (_) {}
    }
  }

  initHardwareMonitoring() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return;

    navigator.mediaDevices.addEventListener('devicechange', () => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(async () => {
        logger.info('DeviceManager', '🔌 Événement matériel détecté (devicechange)');
        await this.handleHardwareChange();
      }, 350);
    });

    this.refreshDeviceInventory();
  }

  async refreshDeviceInventory() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return { audioInputs: [], audioOutputs: [], videoInputs: [] };
    }

    try {
      const rawDevices = await navigator.mediaDevices.enumerateDevices();
      
      const newAudioInputs = rawDevices.filter(d => d.kind === 'audioinput');
      const newAudioOutputs = rawDevices.filter(d => d.kind === 'audiooutput');
      const newVideoInputs = rawDevices.filter(d => d.kind === 'videoinput');

      const diff = {
        removedAudioInputs: this.audioInputs.filter(old => !newAudioInputs.some(n => n.deviceId === old.deviceId)),
        removedAudioOutputs: this.audioOutputs.filter(old => !newAudioOutputs.some(n => n.deviceId === old.deviceId)),
        removedVideoInputs: this.videoInputs.filter(old => !newVideoInputs.some(n => n.deviceId === old.deviceId)),
        addedCount: (newAudioInputs.length + newAudioOutputs.length + newVideoInputs.length) -
                    (this.audioInputs.length + this.audioOutputs.length + this.videoInputs.length)
      };

      this.audioInputs = newAudioInputs;
      this.audioOutputs = newAudioOutputs;
      this.videoInputs = newVideoInputs;

      this._notifyListeners({
        audioInputs: this.audioInputs,
        audioOutputs: this.audioOutputs,
        videoInputs: this.videoInputs,
        diff
      });

      return { audioInputs: this.audioInputs, audioOutputs: this.audioOutputs, videoInputs: this.videoInputs, diff };
    } catch (err) {
      logger.error('DeviceManager', 'Erreur enumerateDevices:', err);
      return { audioInputs: this.audioInputs, audioOutputs: this.audioOutputs, videoInputs: this.videoInputs };
    }
  }

  async handleHardwareChange() {
    const { diff } = await this.refreshDeviceInventory();
    if (!diff) return;

    if (this.activeAudioInputId && this.activeAudioInputId !== 'default') {
      const lost = diff.removedAudioInputs.find(d => d.deviceId === this.activeAudioInputId);
      if (lost) {
        logger.warn('DeviceManager', `⚠️ Microphone actif déconnecté: ${lost.label || lost.deviceId}`);
        this._notifyDeviceLoss('audio', lost);
      }
    }

    if (this.activeVideoInputId && this.activeVideoInputId !== 'default') {
      const lost = diff.removedVideoInputs.find(d => d.deviceId === this.activeVideoInputId);
      if (lost) {
        logger.warn('DeviceManager', `⚠️ Caméra active déconnectée: ${lost.label || lost.deviceId}`);
        this._notifyDeviceLoss('video', lost);
      }
    }

    if (this.activeAudioOutputId && this.activeAudioOutputId !== 'default') {
      const lost = diff.removedAudioOutputs.find(d => d.deviceId === this.activeAudioOutputId);
      if (lost) {
        logger.warn('DeviceManager', `⚠️ Sortie audio active déconnectée: ${lost.label || lost.deviceId}`);
        this._notifyDeviceLoss('output', lost);
      }
    }
  }

  createSilentAudioTrack() {
    try {
      const AudioCtx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
      if (!AudioCtx) return null;
      const ctx = new AudioCtx();
      const dest = ctx.createMediaStreamDestination();
      const gain = ctx.createGain();
      gain.gain.value = 0.0;
      const osc = ctx.createOscillator();
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      
      const track = dest.stream.getAudioTracks()[0];
      track.contentHint = 'speech';
      logger.info('DeviceManager', '🔇 Piste audio de secours silencieuse générée.');
      return track;
    } catch (e) {
      logger.error('DeviceManager', 'Échec création piste silencieuse:', e);
      return null;
    }
  }

  createCanvasPlaceholderTrack(userName = 'Utilisateur', width = 640, height = 480) {
    try {
      if (typeof document === 'undefined') return null;
      if (this.placeholderAnimationId) {
        cancelAnimationFrame(this.placeholderAnimationId);
      }

      this.placeholderCanvas = document.createElement('canvas');
      this.placeholderCanvas.width = width;
      this.placeholderCanvas.height = height;
      const ctx = this.placeholderCanvas.getContext('2d');
      if (!ctx) return null;

      let frame = 0;
      const draw = () => {
        frame++;
        const grad = ctx.createLinearGradient(0, 0, width, height);
        grad.addColorStop(0, '#0f172a');
        grad.addColorStop(1, '#1e1b4b');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);

        const pulse = Math.sin(frame * 0.05) * 8;
        ctx.beginPath();
        ctx.arc(width / 2, height / 2 - 20, 60 + pulse, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(99, 102, 241, 0.15)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(width / 2, height / 2 - 20, 50, 0, Math.PI * 2);
        ctx.fillStyle = '#4f46e5';
        ctx.fill();

        ctx.font = 'bold 36px sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(userName.charAt(0).toUpperCase() || '👤', width / 2, height / 2 - 18);

        ctx.font = '16px sans-serif';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(userName, width / 2, height / 2 + 55);

        ctx.font = '12px sans-serif';
        ctx.fillStyle = '#64748b';
        ctx.fillText('📷 Caméra indisponible', width / 2, height / 2 + 80);

        if (typeof requestAnimationFrame !== 'undefined') {
          this.placeholderAnimationId = requestAnimationFrame(draw);
        }
      };

      draw();

      if (typeof this.placeholderCanvas.captureStream === 'function') {
        const stream = this.placeholderCanvas.captureStream(25);
        const track = stream.getVideoTracks()[0];
        if (track) {
          track.contentHint = 'motion';
          return track;
        }
      }
      return null;
    } catch (e) {
      logger.error('DeviceManager', 'Échec création Canvas Placeholder:', e);
      return null;
    }
  }

  stopPlaceholder() {
    if (this.placeholderAnimationId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.placeholderAnimationId);
      this.placeholderAnimationId = null;
    }
    this.placeholderCanvas = null;
  }

  onDeviceChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onActiveDeviceLost(callback) {
    this.deviceLossListeners.add(callback);
    return () => this.deviceLossListeners.delete(callback);
  }

  _notifyListeners(data) {
    this.listeners.forEach(cb => {
      try { cb(data); } catch (e) { logger.warn('DeviceManager', 'Listener error:', e); }
    });
  }

  _notifyDeviceLoss(kind, device) {
    this.deviceLossListeners.forEach(cb => {
      try { cb(kind, device); } catch (e) { logger.warn('DeviceManager', 'Device loss listener error:', e); }
    });
  }
}

export const deviceManager = new DeviceManager();
