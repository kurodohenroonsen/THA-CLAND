/**
 * Visualiseur de Spectre Audio Canvas HTML5
 */

export class AudioVisualizer {
  constructor(canvasElement, audioProcessor) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.processor = audioProcessor;
    this.animationFrameId = null;
  }

  start() {
    const draw = () => {
      this.animationFrameId = requestAnimationFrame(draw);
      const data = this.processor.getFrequencyData();
      if (!data || data.length === 0) return;

      const width = this.canvas.width;
      const height = this.canvas.height;
      this.ctx.clearRect(0, 0, width, height);

      const barWidth = (width / (data.length / 2)) * 1.5;
      let x = 0;

      for (let i = 0; i < data.length / 2; i++) {
        const barHeight = (data[i] / 255) * height;

        // Dégradé cyan-violet
        const grad = this.ctx.createLinearGradient(0, height, 0, 0);
        grad.addColorStop(0, '#06b6d4');
        grad.addColorStop(1, '#a855f7');

        this.ctx.fillStyle = grad;
        this.ctx.fillRect(x, height - barHeight, barWidth - 1, barHeight);
        x += barWidth;
      }
    };

    draw();
  }

  stop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
