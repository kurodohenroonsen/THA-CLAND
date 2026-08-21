/**
 * modules/drive/media-source-streamer.js
 * Intégration MediaSource Extensions (MSE) pour la lecture vidéo/audio progressive (Pass 4)
 */

import { logger } from '../../core/logger.js';

export class MediaSourceStreamer {
  constructor(mediaElement, sequentialStreamer) {
    this.mediaEl = mediaElement;
    this.streamer = sequentialStreamer;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.isUpdating = false;
    this.session = null;
  }

  /**
   * Initialise le flux MSE sur l'élément vidéo/audio
   */
  async attach(commit) {
    this.session = this.streamer.createStreamSession(commit);

    // Détection de compatibilité Codec
    let mimeCodec = commit.mimeType || 'video/mp4';
    if (mimeCodec.includes('mp4')) {
      mimeCodec = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
    } else if (mimeCodec.includes('webm')) {
      mimeCodec = 'video/webm; codecs="vp8, opus"';
    }

    if (typeof window === 'undefined' || !window.MediaSource || !MediaSource.isTypeSupported(mimeCodec)) {
      logger.warn('MSE', `Format ${mimeCodec} non géré directement par MSE. Repli en direct Blob.`);
      return this._fallbackDirectBlob(commit);
    }

    return new Promise((resolve, reject) => {
      this.mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(this.mediaSource);
      this.mediaEl.src = objectUrl;

      this.mediaSource.addEventListener('sourceopen', async () => {
        try {
          this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeCodec);
          this.sourceBuffer.mode = 'sequence';

          this.sourceBuffer.addEventListener('updateend', () => {
            this.isUpdating = false;
            this._processQueue();
          });

          this._bindPlaybackEvents();
          this._startFeeding();
          resolve(objectUrl);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  async _startFeeding() {
    let nextIndex = 0;
    while (this.session && !this.session.closed && nextIndex < this.session.totalChunks) {
      const chunkBuf = await this.streamer._ensureChunkLoaded(this.session, nextIndex, 'FEEDING');
      if (chunkBuf) {
        this.appendChunk(chunkBuf);
        nextIndex++;
      } else {
        await new Promise(r => setTimeout(r, 150));
      }
    }
  }

  appendChunk(arrayBuffer) {
    this.queue.push(arrayBuffer);
    this._processQueue();
  }

  _processQueue() {
    if (this.isUpdating || this.queue.length === 0 || !this.sourceBuffer) return;
    if (this.sourceBuffer.updating) return;

    try {
      const buffer = this.queue.shift();
      this.isUpdating = true;
      this.sourceBuffer.appendBuffer(buffer);
    } catch (err) {
      logger.error('MSE', 'Erreur appendBuffer:', err);
      this.isUpdating = false;
    }
  }

  _bindPlaybackEvents() {
    if (!this.mediaEl) return;
    this.mediaEl.addEventListener('seeking', () => {
      if (this.mediaEl.duration && this.session) {
        this.streamer.seek(this.session, this.mediaEl.currentTime, this.mediaEl.duration);
      }
    });

    this.mediaEl.addEventListener('timeupdate', () => {
      if (this.sourceBuffer && !this.sourceBuffer.updating && this.mediaEl.currentTime > 30) {
        try {
          this.sourceBuffer.remove(0, this.mediaEl.currentTime - 20);
        } catch {}
      }
    });
  }

  async _fallbackDirectBlob(commit) {
    if (!this.session) return '';
    const chunk0 = await this.streamer._ensureChunkLoaded(this.session, 0);
    const blob = new Blob([chunk0], { type: commit.mimeType });
    const url = URL.createObjectURL(blob);
    if (this.mediaEl) this.mediaEl.src = url;
    return url;
  }

  destroy() {
    if (this.session) {
      this.streamer.closeSession(this.session.fileId);
    }
    if (this.mediaEl && this.mediaEl.src) {
      URL.revokeObjectURL(this.mediaEl.src);
      this.mediaEl.src = '';
    }
    this.queue = [];
  }
}
