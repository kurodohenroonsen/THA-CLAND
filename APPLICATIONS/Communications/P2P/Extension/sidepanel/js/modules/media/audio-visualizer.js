/**
 * Visualiseur Audio Canvas en Temps Réel
 * Animation fluide par onde spectrale / barres lumineuses avec dégradé cyan/violet.
 */

export class AudioVisualizer {
  constructor(canvasElement, audioProcessor) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.processor = audioProcessor;
    this.animationFrameId = null;
  }

  start() {
    this.stop();
    this.draw();
  }

  draw() {
    this.animationFrameId = requestAnimationFrame(() => this.draw());

    const width = this.canvas.width;
    const height = this.canvas.height;
    const dataArray = this.processor.getFrequencyData();

    this.ctx.clearRect(0, 0, width, height);

    if (!dataArray || dataArray.length === 0) {
      // Ligne plate de repos
      this.ctx.beginPath();
      this.ctx.moveTo(0, height / 2);
      this.ctx.lineTo(width, height / 2);
      this.ctx.strokeStyle = 'rgba(6, 182, 212, 0.2)';
      this.ctx.lineWidth = 2;
      this.ctx.stroke();
      return;
    }

    const barWidth = (width / dataArray.length) * 2.5;
    let x = 0;

    const gradient = this.ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#06b6d4');
    gradient.addColorStop(0.5, '#8b5cf6');
    gradient.addColorStop(1, '#ec4899');

    for (let i = 0; i < dataArray.length; i++) {
      const barHeight = (dataArray[i] / 255) * height;

      this.ctx.fillStyle = gradient;
      this.ctx.fillRect(x, height - barHeight, barWidth, barHeight);

      x += barWidth + 1;
      if (x > width) break;
    }
  }

  stop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
