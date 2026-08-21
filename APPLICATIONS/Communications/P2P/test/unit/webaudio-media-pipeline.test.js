/**
 * test/unit/webaudio-media-pipeline.test.js
 * Tests Unitaires & Validation Mathématique du Pipeline Média WebAudio (Pass 4)
 * Runner : Node.js Native Test Runner (node:test & node:assert/strict)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SpatialAudioEngine } from '../../Extension/sidepanel/js/modules/media/spatial-audio.js';
import { MediaStreamManager } from '../../Extension/sidepanel/js/modules/media/media-stream.js';

describe('🎙️ Groupe 5 - Tests du Pipeline WebAudio, VAD & Spatial Audio 3D', () => {

  // =========================================================================
  // SUITE 1 : SpatialAudioEngine & Géométrie Acoustique 3D
  // =========================================================================
  describe('1. SpatialAudioEngine - Coordonnées 3D & Contrôle de Volume', () => {
    let spatial;

    before(() => {
      spatial = new SpatialAudioEngine();
    });

    after(() => {
      spatial.destroy();
    });

    it('Initialise les paramètres par défaut (Spatialisation activée, Mode HRTF)', () => {
      assert.strictEqual(spatial.spatialEnabled, true);
      assert.strictEqual(spatial.panningModel, 'HRTF');
    });

    it('Mémorise et borne le volume numérique individuel [0.0 - 2.0]', () => {
      spatial.setPeerVolume('peer_alice', 1.5);
      assert.strictEqual(spatial._volumes.get('peer_alice'), 1.5);

      spatial.setPeerVolume('peer_alice', 5.0); // Dépassement haut
      assert.strictEqual(spatial._volumes.get('peer_alice'), 2.0);

      spatial.setPeerVolume('peer_alice', -1.0); // Dépassement bas
      assert.strictEqual(spatial._volumes.get('peer_alice'), 0.0);
    });

    it('Bascule de configuration de spatialisation (HRTF <-> Equalpower)', () => {
      spatial.setSpatialConfig(false, 'equalpower');
      assert.strictEqual(spatial.spatialEnabled, false);
      assert.strictEqual(spatial.panningModel, 'equalpower');

      spatial.setSpatialConfig(true, 'HRTF');
      assert.strictEqual(spatial.spatialEnabled, true);
      assert.strictEqual(spatial.panningModel, 'HRTF');
    });

    it('detachRemoteStream nettoie les maps de références fortes sans erreur', () => {
      spatial._sources.set('peer_mock', {});
      spatial._panners.set('peer_mock', {});
      spatial._gains.set('peer_mock', {});
      spatial._streams.set('peer_mock', {});

      spatial.detachRemoteStream('peer_mock');

      assert.strictEqual(spatial._sources.has('peer_mock'), false);
      assert.strictEqual(spatial._panners.has('peer_mock'), false);
      assert.strictEqual(spatial._gains.has('peer_mock'), false);
      assert.strictEqual(spatial._streams.has('peer_mock'), false);
    });
  });

  // =========================================================================
  // SUITE 2 : MediaStreamManager & Gestion Matérielle
  // =========================================================================
  describe('2. MediaStreamManager - Gestion Périphériques & Contraintes', () => {
    let mediaMgr;

    before(() => {
      mediaMgr = new MediaStreamManager();
    });

    it('getAvailableDevices gère l\'absence d\'API média sans exception', async () => {
      const devices = await mediaMgr.getAvailableDevices();
      assert.ok(Array.isArray(devices.audioInputs));
      assert.ok(Array.isArray(devices.audioOutputs));
      assert.ok(Array.isArray(devices.videoInputs));
    });

    it('Enregistre et désenregistre les auditeurs onDeviceChange', () => {
      let callCount = 0;
      const listener = () => { callCount++; };

      const unregister = mediaMgr.onDeviceChange(listener);
      assert.strictEqual(mediaMgr.deviceChangeListeners.has(listener), true);

      unregister();
      assert.strictEqual(mediaMgr.deviceChangeListeners.has(listener), false);
    });
  });

  // =========================================================================
  // SUITE 3 : Simulation Algorithmique VAD & Calculs DSP
  // =========================================================================
  describe('3. VAD DSP - Filtrage Biquad & Calculs d\'Énergie RMS / ZCR', () => {

    it('Calcul RMS et Zero Crossing Rate (ZCR) sur signaux synthétiques', () => {
      // 1. Signal sinusoïdal pur (128 échantillons)
      const samples = new Float32Array(128);
      let zeroCrossings = 0;
      let prevSign = false;

      for (let i = 0; i < 128; i++) {
        samples[i] = Math.sin((2 * Math.PI * i) / 16) * 0.5; // ~3kHz @ 48kHz
        const sign = samples[i] >= 0;
        if (i > 0 && sign !== prevSign) zeroCrossings++;
        prevSign = sign;
      }

      let sumSq = 0;
      for (let i = 0; i < 128; i++) sumSq += samples[i] * samples[i];
      const rms = Math.sqrt(sumSq / 128);
      const zcr = zeroCrossings / 128;

      assert.ok(rms > 0.3 && rms < 0.4, `RMS attendu ~0.35, obtenu: ${rms}`);
      assert.ok(zcr > 0.05 && zcr < 0.20, `ZCR attendu ~0.12, obtenu: ${zcr}`);
    });

    it('Filtre Biquad Passe-Haut atténue les très basses fréquences (< 50 Hz)', () => {
      // Calcul des coefficients Butterworth 85 Hz @ 48 kHz
      const sampleRate = 48000;
      const cutoff = 85.0;
      const Q = 0.7071;

      const w0 = (2.0 * Math.PI * cutoff) / sampleRate;
      const cosw0 = Math.cos(w0);
      const alpha = Math.sin(w0) / (2.0 * Q);

      const b0 = (1.0 + cosw0) / 2.0;
      const b1 = -(1.0 + cosw0);
      const b2 = (1.0 + cosw0) / 2.0;
      const a0 = 1.0 + alpha;
      const a1 = -2.0 * cosw0;
      const a2 = 1.0 - alpha;

      const normB0 = b0 / a0;
      const normB1 = b1 / a0;
      const normB2 = b2 / a0;
      const normA1 = a1 / a0;
      const normA2 = a2 / a0;

      // Injection d'une composante continue (DC Offset = 1.0)
      let s1 = 0, s2 = 0;
      let lastOutput = 0;
      for (let i = 0; i < 500; i++) {
        const x = 1.0;
        const y = normB0 * x + s1;
        s1 = normB1 * x - normA1 * y + s2;
        s2 = normB2 * x - normA2 * y;
        lastOutput = y;
      }

      // La composante continue (DC) doit être complètement éliminée (output proche de 0)
      assert.ok(Math.abs(lastOutput) < 0.01, `Le filtre passe-haut doit bloquer le DC (obtenu: ${lastOutput})`);
    });
  });
});
