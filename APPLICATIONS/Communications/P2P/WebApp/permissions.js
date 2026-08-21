/**
 * Script de gestion d'autorisation Microphone & Caméra (Onglet dédié)
 */

document.addEventListener('DOMContentLoaded', () => {
  const btnAudio = document.getElementById('btn-grant-audio');
  const btnBoth = document.getElementById('btn-grant-both');
  const meter = document.getElementById('audio-meter');
  const meterFill = document.getElementById('audio-meter-fill');
  const successBox = document.getElementById('perm-success');

  let audioCtx = null;

  async function requestPermissions(withVideo = false) {
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

      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Démarrage du vu-mètre audio en direct
      if (meter && meterFill) {
        meter.style.display = 'block';
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        src.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        function updateMeter() {
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          const percent = Math.min(100, Math.round((avg / 128) * 100));
          meterFill.style.width = `${percent}%`;
          requestAnimationFrame(updateMeter);
        }
        updateMeter();
      }

      if (successBox) successBox.style.display = 'block';
      if (btnAudio) btnAudio.style.display = 'none';
      if (btnBoth) btnBoth.style.display = 'none';

      // Auto-fermeture après 3.5 secondes pour confort de l'utilisateur
      setTimeout(() => {
        try { window.close(); } catch {}
      }, 4000);

    } catch (err) {
      console.warn('Erreur demande permission:', err);
      if (btnAudio) {
        btnAudio.disabled = false;
        btnAudio.textContent = '⚠️ Réessayer l\'autorisation';
      }
      if (btnBoth) btnBoth.disabled = false;
      alert(`Autorisation refusée ou ignorée : ${err.message}\nVeuillez autoriser l'accès dans la barre d'adresse pour continuer.`);
    }
  }

  if (btnAudio) {
    btnAudio.addEventListener('click', () => requestPermissions(false));
  }

  if (btnBoth) {
    btnBoth.addEventListener('click', () => requestPermissions(true));
  }
});
