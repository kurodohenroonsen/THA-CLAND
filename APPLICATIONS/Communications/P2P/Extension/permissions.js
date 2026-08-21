/**
 * Script de gestion d'autorisation Microphone & Caméra (Onglet dédié) (2025/2026)
 * - Broadcast de l'autorisation au Side Panel et Service Worker
 * - Libération déterministe des flux matériels, fermeture d'AudioContext et arrêt des boucles RAF.
 */

document.addEventListener('DOMContentLoaded', () => {
  const btnAudio = document.getElementById('btn-grant-audio');
  const btnBoth = document.getElementById('btn-grant-both');
  const meter = document.getElementById('audio-meter');
  const meterFill = document.getElementById('audio-meter-fill');
  const successBox = document.getElementById('perm-success');
  const errorBox = document.getElementById('perm-error');

  let activeStream = null;
  let audioCtx = null;
  let rafId = null;

  function cleanupMedia() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      try { audioCtx.close(); } catch {}
      audioCtx = null;
    }
    if (activeStream) {
      activeStream.getTracks().forEach(track => {
        try { track.stop(); } catch {}
      });
      activeStream = null;
    }
  }

  window.addEventListener('beforeunload', cleanupMedia);
  window.addEventListener('pagehide', cleanupMedia);

  async function requestPermissions(withVideo = false) {
    cleanupMedia();
    if (errorBox) errorBox.style.display = 'none';

    try {
      if (btnAudio) btnAudio.disabled = true;
      if (btnBoth) btnBoth.disabled = true;

      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: withVideo ? { width: 1280, height: 720 } : false
      };

      activeStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Notification immédiate au Side Panel et au Service Worker
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({
            type: 'HARDWARE_PERMISSION_GRANTED',
            hasAudio: true,
            hasVideo: withVideo,
            timestamp: Date.now()
          }).catch(() => {});
        }
      } catch (_) {}

      // Démarrage du vu-mètre audio en direct
      if (meter && meterFill) {
        meter.style.display = 'block';
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume();
        }
        const src = audioCtx.createMediaStreamSource(activeStream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        src.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        function updateMeter() {
          if (!audioCtx || audioCtx.state === 'closed') return;
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          const percent = Math.min(100, Math.round((avg / 128) * 100));
          meterFill.style.width = `${percent}%`;
          rafId = requestAnimationFrame(updateMeter);
        }
        updateMeter();
      }

      if (successBox) successBox.style.display = 'block';
      if (btnAudio) btnAudio.style.display = 'none';
      if (btnBoth) btnBoth.style.display = 'none';

      // Libération des flux et fermeture propre après 2.2 secondes
      setTimeout(() => {
        cleanupMedia();
        try { window.close(); } catch {}
      }, 2200);

    } catch (err) {
      cleanupMedia();
      console.warn('Erreur demande permission:', err);
      if (btnAudio) {
        btnAudio.disabled = false;
        btnAudio.textContent = '🔄 Réessayer l\'autorisation';
      }
      if (btnBoth) btnBoth.disabled = false;

      if (errorBox) {
        errorBox.style.display = 'block';
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          errorBox.innerHTML = `
            <strong>⚠️ Accès refusé par le navigateur</strong><br/>
            Pour débloquer vos périphériques :
            <ol style="margin: 8px 0 0 16px; padding: 0; line-height: 1.5;">
              <li>Cliquez sur l'icône de réglages du site (ou cadenas) à gauche de la barre d'adresse.</li>
              <li>Passez <strong>Microphone</strong> (et Caméra) sur <em>Autoriser</em>.</li>
              <li>Revenez sur cette page et cliquez sur <em>Réessayer</em>.</li>
            </ol>
          `;
        } else {
          errorBox.innerHTML = `<strong>Erreur technique :</strong> ${err.message}`;
        }
      }
    }
  }

  if (btnAudio) {
    btnAudio.addEventListener('click', () => requestPermissions(false));
  }

  if (btnBoth) {
    btnBoth.addEventListener('click', () => requestPermissions(true));
  }
});
