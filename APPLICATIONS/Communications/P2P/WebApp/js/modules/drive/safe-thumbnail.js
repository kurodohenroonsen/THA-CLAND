/**
 * modules/drive/safe-thumbnail.js
 * Générateur et Assainisseur de Miniatures Léger (WebP 64x64 / 128x128 ~1.5 Ko)
 * Conforme Sandbox & Politique de Sécurité Zéro-Exécution (Pass 4)
 */

export class SafeThumbnailExtractor {
  /**
   * Génère une miniature optimisée depuis une image ou vidéo locale
   */
  static async generateThumbnail(file, maxSize = 96) {
    if (!file || typeof window === 'undefined') return null;

    if (file.type && file.type.startsWith('image/')) {
      return SafeThumbnailExtractor._generateFromImage(file, maxSize);
    } else if (file.type && file.type.startsWith('video/')) {
      return SafeThumbnailExtractor._generateFromVideo(file, maxSize);
    }
    return null;
  }

  static async _generateFromImage(file, maxSize) {
    return new Promise((resolve) => {
      if (typeof Image === 'undefined') return resolve(null);
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(url);
        const { width, height } = SafeThumbnailExtractor._calcAspect(img.width, img.height, maxSize);
        
        if (typeof OffscreenCanvas !== 'undefined') {
          const canvas = new OffscreenCanvas(width, height);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          canvas.convertToBlob({ type: 'image/webp', quality: 0.65 }).then(async (blob) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          }).catch(() => resolve(null));
        } else if (typeof document !== 'undefined') {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/webp', 0.65));
        } else {
          resolve(null);
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };

      img.src = url;
    });
  }

  static async _generateFromVideo(file, maxSize) {
    return new Promise((resolve) => {
      if (typeof document === 'undefined') return resolve(null);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      const url = URL.createObjectURL(file);

      video.onloadeddata = () => {
        video.currentTime = Math.min(1.0, (video.duration || 10) * 0.1);
      };

      video.onseeked = () => {
        URL.revokeObjectURL(url);
        const { width, height } = SafeThumbnailExtractor._calcAspect(video.videoWidth || 160, video.videoHeight || 90, maxSize);
        
        if (typeof OffscreenCanvas !== 'undefined') {
          const canvas = new OffscreenCanvas(width, height);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, width, height);

          canvas.convertToBlob({ type: 'image/webp', quality: 0.6 }).then(async (blob) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          }).catch(() => resolve(null));
        } else {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, width, height);
          resolve(canvas.toDataURL('image/webp', 0.6));
        }
      };

      video.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };

      video.src = url;
    });
  }

  static _calcAspect(w, h, max) {
    if (w > h) {
      return { width: max, height: Math.round((h * max) / w) };
    }
    return { width: Math.round((w * max) / h), height: max };
  }

  /**
   * Assainit une URL de miniature pour injection DOM sécurisée
   */
  static sanitizeDataUrl(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    if (dataUrl.startsWith('data:image/webp;base64,') || dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.startsWith('data:image/png;base64,')) {
      return dataUrl;
    }
    return null;
  }
}
