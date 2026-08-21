/**
 * canvas-capture-pipeline.js - Pipeline de Capture Canvas / Tableau Blanc & Annotations Collaboratives (Pass 4 Hardened)
 * P2P Mesh Workspace (2025/2026)
 * - Support Retina/DPR 2.0x
 * - Laser pointer & zones de flou de confidentialité (Privacy Area Blur)
 * - Export de flux MediaStreamTrack via canvas.captureStream(fps)
 */

export class CanvasCapturePipeline {
  constructor(canvasElement, options = {}) {
    this.canvas = canvasElement;
    this.fps = options.fps || 30;
    this.dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2.0) : 1;
    this.ctx = null;
    this.stream = null;
    this.track = null;

    this.laserPointer = null; // { x, y, active: boolean, color: string }
    this.privacyZones = [];   // Array<{ x, y, width, height }>

    this._initCanvas();
  }

  _initCanvas() {
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext?.('2d', {
      alpha: false,
      desynchronized: true,
      willReadFrequently: false
    });
    this.resize(this.canvas.clientWidth || 1280, this.canvas.clientHeight || 720);
  }

  resize(width, height) {
    this.width = Math.floor(width * this.dpr);
    this.height = Math.floor(height * this.dpr);
    if (this.canvas) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
  }

  captureStream() {
    if (!this.canvas) throw new Error('Canvas non initialisé.');
    
    if (typeof this.canvas.captureStream === 'function') {
      this.stream = this.canvas.captureStream(this.fps);
      this.track = this.stream.getVideoTracks()[0];
      if (this.track) {
        this.track.contentHint = 'detail';
      }
      return this.track;
    }
    throw new Error('HTMLCanvasElement.captureStream non supporté.');
  }

  setLaserPointer(x, y, active = true, color = '#ff3366') {
    this.laserPointer = { x: x * this.dpr, y: y * this.dpr, active, color };
  }

  addPrivacyZone(x, y, width, height) {
    this.privacyZones.push({
      x: x * this.dpr,
      y: y * this.dpr,
      width: width * this.dpr,
      height: height * this.dpr
    });
  }

  renderFrame(backgroundSource = null) {
    if (!this.ctx) return;
    const ctx = this.ctx;

    if (backgroundSource) {
      ctx.drawImage(backgroundSource, 0, 0, this.width, this.height);
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, this.width, this.height);
    }

    if (this.privacyZones.length > 0) {
      ctx.save();
      for (const zone of this.privacyZones) {
        ctx.filter = 'blur(12px)';
        ctx.drawImage(this.canvas, zone.x, zone.y, zone.width, zone.height, zone.x, zone.y, zone.width, zone.height);
      }
      ctx.restore();
    }

    if (this.laserPointer?.active) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(this.laserPointer.x, this.laserPointer.y, 8 * this.dpr, 0, Math.PI * 2);
      ctx.fillStyle = this.laserPointer.color;
      ctx.shadowColor = this.laserPointer.color;
      ctx.shadowBlur = 15;
      ctx.fill();
      ctx.restore();
    }

    if (this.track && typeof this.track.requestFrame === 'function') {
      this.track.requestFrame();
    }
  }

  destroy() {
    if (this.track) {
      try { this.track.stop(); } catch {}
      this.track = null;
    }
    this.stream = null;
    this.privacyZones = [];
    this.laserPointer = null;
  }
}
