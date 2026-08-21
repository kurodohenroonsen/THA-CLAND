import { logger } from '../../core/logger.js';

/**
 * Visualiseur Audio Canvas 60 FPS Haute Performance (Standard 2025/2026)
 * - DPR (Retina) Scaling dynamique via ResizeObserver
 * - Zero GC Churn : Gradients et dimensions mis en cache hors de la boucle de trame
 * - Économie d'énergie : Suspension automatique par IntersectionObserver & Visibility API
 * - Graphisme moderne : Barres adoucies (roundRect) & Dégradé Cyan/Violet/Rose
 * - Support Accessibilité (prefers-reduced-motion)
 */
export class AudioVisualizer {
  constructor(canvasElement, audioProcessor) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d', {
      alpha: true,
      desynchronized: true,
      willReadFrequently: false
    });
    this.processor = audioProcessor;
    this.animationFrameId = null;

    // Dimensions logiques mises en cache
    this.logicalWidth = 300;
    this.logicalHeight = 48;
    this.dpr = 1;
    this.cachedGradient = null;

    // États de cycle de vie et visibilité
    this.isRunning = false;
    this.isIntersecting = true;
    this.isPageVisible = !document.hidden;
    this.prefersReducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;

    // Observateurs de ressources
    this.resizeObserver = null;
    this.intersectionObserver = null;
    this.boundVisibilityHandler = this.handleVisibilityChange.bind(this);

    this.initObservers();
  }

  initObservers() {
    // 1. Gestion dynamique du Retina / DPR et redimensionnement
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const rect = entry.contentRect;
          if (rect.width > 0 && rect.height > 0) {
            this.handleResize(rect.width, rect.height);
          }
        }
      });
      this.resizeObserver.observe(this.canvas);
    } else {
      this.handleResize(this.canvas.clientWidth || 300, this.canvas.clientHeight || 48);
    }

    // 2. Suspension hors-champ (IntersectionObserver)
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          this.isIntersecting = entry.isIntersecting;
          this.evaluateLoopState();
        }
      }, { threshold: 0.05 });
      this.intersectionObserver.observe(this.canvas);
    }

    // 3. Suspension onglet/Sidepanel masqué
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);
  }

  handleResize(cssWidth, cssHeight) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2); // Clamping à 2.0 pour préserver le GPU
    this.logicalWidth = cssWidth;
    this.logicalHeight = cssHeight;

    this.canvas.width = Math.floor(cssWidth * this.dpr);
    this.canvas.height = Math.floor(cssHeight * this.dpr);

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);

    // Pré-calcul et mise en cache du dégradé (Zéro allocation par frame)
    this.cachedGradient = this.ctx.createLinearGradient(0, this.logicalHeight, 0, 0);
    this.cachedGradient.addColorStop(0, '#06b6d4');   // Cyan fluo
    this.cachedGradient.addColorStop(0.5, '#8b5cf6'); // Violet électrique
    this.cachedGradient.addColorStop(1, '#ec4899');   // Rose néon
  }

  handleVisibilityChange() {
    this.isPageVisible = !document.hidden;
    this.evaluateLoopState();
  }

  evaluateLoopState() {
    if (this.isRunning && this.isIntersecting && this.isPageVisible) {
      if (!this.animationFrameId) {
        this.draw();
      }
    } else {
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
    }
  }

  start() {
    this.isRunning = true;
    this.evaluateLoopState();
  }

  draw() {
    if (!this.isRunning || !this.isIntersecting || !this.isPageVisible) {
      this.animationFrameId = null;
      return;
    }

    this.animationFrameId = requestAnimationFrame(() => this.draw());

    const width = this.logicalWidth;
    const height = this.logicalHeight;
    const dataArray = this.processor.getFrequencyData();

    // Effacement de la frame
    this.ctx.clearRect(0, 0, width, height);

    if (!dataArray || dataArray.length === 0) {
      this.drawIdleLine(width, height);
      return;
    }

    // Mode Accessibilité Réduite : jauge d'énergie globale douce
    if (this.prefersReducedMotion) {
      this.drawReducedMotionMeter(dataArray, width, height);
      return;
    }

    // Nombre de barres d'égaliseur calibré (ex: 28 barres)
    const numBars = Math.min(28, Math.floor(width / 8));
    const barSpacing = 3;
    const totalSpacing = barSpacing * (numBars - 1);
    const barWidth = Math.max(3, (width - totalSpacing) / numBars);

    const step = Math.max(1, Math.floor(dataArray.length / numBars));
    let x = 0;

    this.ctx.fillStyle = this.cachedGradient;

    for (let i = 0; i < numBars; i++) {
      let sum = 0;
      let count = 0;
      for (let j = 0; j < step && (i * step + j) < dataArray.length; j++) {
        sum += dataArray[i * step + j];
        count++;
      }
      const val = count > 0 ? (sum / count) : 0;
      const normalizedHeight = Math.max(2, (val / 255) * (height - 4));
      const y = height - normalizedHeight;

      this.ctx.beginPath();
      if (typeof this.ctx.roundRect === 'function') {
        this.ctx.roundRect(x, y, barWidth, normalizedHeight, [3, 3, 0, 0]);
      } else {
        this.ctx.rect(x, y, barWidth, normalizedHeight);
      }
      this.ctx.fill();

      x += barWidth + barSpacing;
      if (x >= width) break;
    }
  }

  drawIdleLine(width, height) {
    this.ctx.beginPath();
    this.ctx.moveTo(0, height / 2);
    this.ctx.lineTo(width, height / 2);
    this.ctx.strokeStyle = 'rgba(6, 182, 212, 0.25)';
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();
  }

  drawReducedMotionMeter(dataArray, width, height) {
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
    const avg = sum / (dataArray.length || 1);
    const energy = Math.min(1, avg / 120);

    this.ctx.fillStyle = 'rgba(6, 182, 212, 0.15)';
    this.ctx.fillRect(0, height / 2 - 2, width, 4);

    this.ctx.fillStyle = this.cachedGradient;
    const meterWidth = width * energy;
    this.ctx.fillRect((width - meterWidth) / 2, height / 2 - 3, meterWidth, 6);
  }

  stop() {
    this.isRunning = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.logicalWidth, this.logicalHeight);
    }
  }

  destroy() {
    this.stop();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.intersectionObserver) this.intersectionObserver.disconnect();
    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
  }
}
