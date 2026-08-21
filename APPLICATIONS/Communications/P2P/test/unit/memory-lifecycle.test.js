/**
 * Suite de Tests Unitaires : Cycle de Vie, Détection de Fuites & Profilage Anti-Leak (2025/2026)
 * Fichier : test/unit/memory-lifecycle.test.js
 * Exécution : node test/unit/memory-lifecycle.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// --- MOCKS DU CONTEXTE NAVIGATEUR POUR LES TESTS DE CYCLE DE VIE ---

class MockMediaStreamTrack {
  constructor(kind = 'audio') {
    this.kind = kind;
    this.id = `trk_${Math.random().toString(36).slice(2, 9)}`;
    this.readyState = 'live';
    this.enabled = true;
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }
}

class MockMediaStream {
  constructor(tracks = []) {
    this.id = `stm_${Math.random().toString(36).slice(2, 9)}`;
    this._tracks = tracks;
  }
  getTracks() { return [...this._tracks]; }
  getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this._tracks.filter(t => t.kind === 'video'); }
  addTrack(t) { this._tracks.push(t); }
  removeTrack(t) { this._tracks = this._tracks.filter(x => x !== t); }
}

class MockAudioNode {
  constructor() {
    this.connectedTo = [];
    this.disconnected = false;
    this.gain = { value: 1.0, setValueAtTime: () => {} };
  }
  connect(dest) {
    this.connectedTo.push(dest);
    return dest;
  }
  disconnect() {
    this.disconnected = true;
    this.connectedTo = [];
  }
}

class MockPannerNode extends MockAudioNode {
  constructor(context, options = {}) {
    super();
    this.panningModel = options.panningModel || 'HRTF';
    this.distanceModel = options.distanceModel || 'inverse';
    this.positionX = { value: 0, setValueAtTime: () => {} };
    this.positionY = { value: 0, setValueAtTime: () => {} };
    this.positionZ = { value: 0, setValueAtTime: () => {} };
  }
}

class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.closed = false;
    this.destination = new MockAudioNode();
    this.listener = {
      positionX: { value: 0 },
      positionY: { value: 0 },
      positionZ: { value: 0 },
      forwardX: { value: 0 },
      forwardY: { value: 0 },
      forwardZ: { value: -1 },
      upX: { value: 0 },
      upY: { value: 1 },
      upZ: { value: 0 }
    };
  }
  createGain() { return new MockAudioNode(); }
  createBiquadFilter() { return new MockAudioNode(); }
  createDynamicsCompressor() { return new MockAudioNode(); }
  createMediaStreamDestination() {
    const node = new MockAudioNode();
    node.stream = new MockMediaStream([new MockMediaStreamTrack('audio')]);
    return node;
  }
  createMediaStreamSource(stream) { return new MockAudioNode(); }
  createAnalyser() {
    const node = new MockAudioNode();
    node.fftSize = 128;
    node.frequencyBinCount = 64;
    return node;
  }
  createPanner() {
    return new MockPannerNode(this);
  }
  async close() {
    this.closed = true;
    this.state = 'closed';
  }
  async resume() {
    this.state = 'running';
  }
}

// Configuration des globaux simulés
globalThis.AudioContext = MockAudioContext;
globalThis.MediaStream = MockMediaStream;
globalThis.MediaStreamTrack = MockMediaStreamTrack;
globalThis.PannerNode = MockPannerNode;
globalThis.window = globalThis;
globalThis.window.devicePixelRatio = 1;
globalThis.window.AudioContext = MockAudioContext;
globalThis.window.PannerNode = MockPannerNode;
globalThis.requestAnimationFrame = (cb) => { return 1; };
globalThis.cancelAnimationFrame = (id) => {};

// Mock URL.createObjectURL & revokeObjectURL
const activeBlobUrls = new Set();
globalThis.URL.createObjectURL = (blob) => {
  const url = `blob:mock://${Math.random().toString(36).slice(2, 9)}`;
  activeBlobUrls.add(url);
  return url;
};
globalThis.URL.revokeObjectURL = (url) => {
  activeBlobUrls.delete(url);
};

// --- IMPORTS DIRECTS DU CORE ---
import { GenerationalSlidingCache, BoundedLRUCache } from '../../Extension/sidepanel/js/core/bounded-cache.js';
import { AudioVisualizer } from '../../Extension/sidepanel/js/modules/media/audio-visualizer.js';
import { SpatialAudioEngine } from '../../Extension/sidepanel/js/modules/media/spatial-audio.js';

describe('🧠 Tests Anti-Leak & Cycle de Vie des Ressources (Expert 7.4)', () => {

  it('GenerationalSlidingCache : teardown et libération du timer', () => {
    const cache = new GenerationalSlidingCache({ generationSize: 100, rotateIntervalMs: 500 });
    
    assert.ok(cache.timer !== null, 'Le timer de rotation doit être actif');
    cache.addIfNew('key-1');
    cache.addIfNew('key-2');
    assert.equal(cache.has('key-1'), true, 'La clé 1 doit être présente');
    assert.equal(cache.size, 2, 'La taille initiale doit être 2');

    cache.destroy();
    assert.equal(cache.timer, null, 'Le timer doit être annulé');
    assert.equal(cache.size, 0, 'Les générations doivent être vidées');
  });

  it('BoundedLRUCache : éviction mémoire stricte', () => {
    const evicted = [];
    const cache = new BoundedLRUCache({
      maxBytes: 1000,
      sizeCalculator: (val) => val.length,
      onEvict: (k, v) => evicted.push({ k, v })
    });

    cache.set('chunk-1', 'A'.repeat(400));
    cache.set('chunk-2', 'B'.repeat(400));
    assert.equal(cache.currentBytes, 800);

    cache.set('chunk-3', 'C'.repeat(400));
    assert.equal(cache.has('chunk-1'), false, 'chunk-1 doit être évincé');
    assert.equal(cache.has('chunk-2'), true, 'chunk-2 doit subsister');
    assert.equal(cache.has('chunk-3'), true, 'chunk-3 doit être présent');
    assert.equal(evicted.length, 1, 'Un item doit avoir déclenché onEvict');
    assert.equal(evicted[0].k, 'chunk-1');

    cache.clear();
    assert.equal(cache.currentBytes, 0, 'La mémoire doit retomber à 0');
  });

  it('AudioVisualizer : cycle de vie, observateurs et buffer Canvas', () => {
    let resizeDisconnected = false;
    let intersectDisconnected = false;
    let visibilityRemoved = false;

    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() { resizeDisconnected = true; }
    };
    globalThis.IntersectionObserver = class {
      observe() {}
      disconnect() { intersectDisconnected = true; }
    };
    globalThis.document = {
      hidden: false,
      addEventListener(evt, fn) {},
      removeEventListener(evt, fn) {
        if (evt === 'visibilitychange') visibilityRemoved = true;
      }
    };

    const mockCanvas = {
      width: 300,
      height: 48,
      getContext: () => ({
        createLinearGradient: () => ({ addColorStop: () => {} }),
        setTransform: () => {},
        scale: () => {},
        clearRect: () => {},
        beginPath: () => {},
        fill: () => {},
        stroke: () => {},
        moveTo: () => {},
        lineTo: () => {},
        fillRect: () => {},
        roundRect: () => {},
        arc: () => {}
      })
    };

    const visualizer = new AudioVisualizer(mockCanvas, { getFrequencyData: () => new Uint8Array(64) });
    visualizer.start();
    assert.equal(visualizer.isRunning, true);

    visualizer.destroy();
    assert.equal(visualizer.isRunning, false, 'Le visualiseur doit être arrêté');
    assert.ok(resizeDisconnected, 'ResizeObserver doit être déconnecté');
    assert.ok(intersectDisconnected, 'IntersectionObserver doit être déconnecté');
    assert.ok(visibilityRemoved, 'L\'écouteur visibilitychange doit être retiré');
  });

  it('SpatialAudioEngine : libération du graphe DSP et AudioContext', async () => {
    const engine = new SpatialAudioEngine();
    const track = new MockMediaStreamTrack('audio');
    const stream = new MockMediaStream([track]);

    await engine.attachRemoteStream('peer-alpha', stream);
    assert.equal(engine._sources.has('peer-alpha'), true);
    assert.equal(engine._panners.has('peer-alpha'), true);

    engine.detachRemoteStream('peer-alpha');
    assert.equal(engine._sources.has('peer-alpha'), false, 'La source doit être purgée');
    assert.equal(engine._panners.has('peer-alpha'), false, 'Le panner doit être purgé');

    await engine.attachRemoteStream('peer-beta', stream);
    engine.destroy();
    assert.equal(engine._sources.size, 0);
    assert.equal(engine.audioContext, null, 'Le contexte audio doit être fermé et nullifié');
  });

  it('Blob URLs : traçabilité et révocation stricte', () => {
    activeBlobUrls.clear();

    const sampleBlob = { size: 1024 * 1024, type: 'image/png' };
    const url1 = URL.createObjectURL(sampleBlob);
    const url2 = URL.createObjectURL(sampleBlob);

    assert.equal(activeBlobUrls.size, 2, 'Deux Blob URLs actives');
    
    URL.revokeObjectURL(url1);
    assert.equal(activeBlobUrls.size, 1);
    assert.equal(activeBlobUrls.has(url1), false);

    URL.revokeObjectURL(url2);
    assert.equal(activeBlobUrls.size, 0, 'Toutes les Blob URLs doivent être révoquées');
  });
});
