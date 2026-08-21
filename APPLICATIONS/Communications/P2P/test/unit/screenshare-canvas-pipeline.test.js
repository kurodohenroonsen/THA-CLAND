/**
 * test/unit/screenshare-canvas-pipeline.test.js
 * Tests Unitaires & Validation du ScreenShare et Pipeline Canvas (Pass 4)
 * Runner : Node.js Native Test Runner (node:test & node:assert/strict)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenShareController, SCREEN_PRESETS } from '../../Extension/sidepanel/js/modules/media/screen-share-controller.js';
import { CanvasCapturePipeline } from '../../Extension/sidepanel/js/modules/media/canvas-capture-pipeline.js';

describe('🖥️ Groupe 5 - Tests ScreenShareController & Canvas Pipeline', () => {
  let mockMesh;
  let mockMediaManager;
  let fakeVideoTrack;
  let fakeAudioTrack;
  let fakeStream;

  beforeEach(() => {
    fakeVideoTrack = {
      kind: 'video',
      readyState: 'live',
      enabled: true,
      contentHint: '',
      stop: () => { fakeVideoTrack.readyState = 'ended'; },
      cropTo: async (target) => { fakeVideoTrack._cropped = target; },
      restrictTo: async (target) => { fakeVideoTrack._restricted = target; }
    };

    fakeAudioTrack = {
      kind: 'audio',
      readyState: 'live',
      enabled: true,
      stop: () => { fakeAudioTrack.readyState = 'ended'; }
    };

    fakeStream = {
      getVideoTracks: () => [fakeVideoTrack],
      getAudioTracks: () => [fakeAudioTrack],
      getTracks: () => [fakeVideoTrack, fakeAudioTrack]
    };

    mockMesh = {
      replacedTracks: [],
      peers: new Map([
        ['peer-1', {
          connection: {
            getSenders: () => [{
              track: fakeVideoTrack,
              getParameters: () => ({ encodings: [{}] }),
              setParameters: async (p) => { mockMesh.lastParams = p; }
            }]
          }
        }]
      ]),
      replaceVideoTrack: async (track, hint) => {
        mockMesh.replacedTracks.push({ track, hint });
      }
    };

    mockMediaManager = {
      localStream: {
        getVideoTracks: () => [{ kind: 'video', readyState: 'live', enabled: true }]
      }
    };

    if (!globalThis.navigator.mediaDevices) {
      Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        value: {},
        writable: true,
        configurable: true
      });
    }

    globalThis.navigator.mediaDevices.getDisplayMedia = async (constraints) => {
      mockMediaManager.lastConstraints = constraints;
      return fakeStream;
    };
  });

  test('1. Initialisation et presets de capture par défaut', () => {
    const controller = new ScreenShareController({ mesh: mockMesh, mediaManager: mockMediaManager });
    assert.strictEqual(controller.isScreenSharing, false);
    assert.strictEqual(controller.activePreset.name, 'detail');
    assert.strictEqual(SCREEN_PRESETS.MOTION.idealFps, 60);
    assert.strictEqual(SCREEN_PRESETS.DETAIL.idealFps, 15);
  });

  test('2. Démarrage et injection QoS adaptée dans le mesh WebRTC', async () => {
    const controller = new ScreenShareController({ mesh: mockMesh, mediaManager: mockMediaManager });
    const stream = await controller.startScreenShare({ preset: 'MOTION', withAudio: true });

    assert.ok(stream);
    assert.strictEqual(controller.isScreenSharing, true);
    assert.strictEqual(fakeVideoTrack.contentHint, 'motion');
    assert.strictEqual(mockMesh.replacedTracks.length, 1);
    assert.strictEqual(mockMesh.replacedTracks[0].hint, 'motion');
    assert.strictEqual(mockMesh.lastParams.encodings[0].maxFramerate, 60);
  });

  test('3. Arrêt natif du navigateur via track.onended et restauration caméra', async () => {
    let stateChanged = null;
    const controller = new ScreenShareController({
      mesh: mockMesh,
      mediaManager: mockMediaManager,
      onStateChange: (isSharing) => { stateChanged = isSharing; }
    });

    await controller.startScreenShare();
    assert.strictEqual(controller.isScreenSharing, true);

    fakeVideoTrack.onended();
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.strictEqual(controller.isScreenSharing, false);
    assert.strictEqual(stateChanged, false);
    assert.strictEqual(mockMesh.replacedTracks.length, 2);
    assert.strictEqual(mockMesh.replacedTracks[1].hint, 'motion');
  });

  test('4. Region Capture & Element Capture invocation', async () => {
    const controller = new ScreenShareController({ mesh: mockMesh, mediaManager: mockMediaManager });
    controller.capabilities.cropTarget = true;
    controller.capabilities.restrictionTarget = true;
    globalThis.window = {
      CropTarget: { fromElement: async (el) => ({ target: el }) },
      RestrictionTarget: { fromElement: async (el) => ({ target: el }) }
    };

    await controller.startScreenShare();
    const fakeEl = { id: 'whiteboard-container' };

    const cropOk = await controller.cropToElement(fakeEl);
    assert.strictEqual(cropOk, true);
    assert.ok(fakeVideoTrack._cropped);

    const restrictOk = await controller.restrictToElement(fakeEl);
    assert.strictEqual(restrictOk, true);
    assert.ok(fakeVideoTrack._restricted);
  });

  test('5. CanvasCapturePipeline avec Retina DPR et captureStream', () => {
    const fakeCanvas = {
      clientWidth: 800,
      clientHeight: 600,
      getContext: () => ({
        fillRect: () => {},
        drawImage: () => {},
        beginPath: () => {},
        arc: () => {},
        fill: () => {},
        save: () => {},
        restore: () => {}
      }),
      captureStream: (fps) => ({
        getVideoTracks: () => [{ kind: 'video', readyState: 'live', contentHint: '', requestFrame: () => {} }]
      })
    };

    const pipeline = new CanvasCapturePipeline(fakeCanvas, { fps: 30 });
    assert.ok(pipeline.ctx);
    assert.strictEqual(pipeline.fps, 30);

    const track = pipeline.captureStream();
    assert.ok(track);
    assert.strictEqual(track.contentHint, 'detail');

    pipeline.setLaserPointer(100, 200, true);
    pipeline.addPrivacyZone(10, 10, 100, 50);
    pipeline.renderFrame();

    pipeline.destroy();
    assert.strictEqual(pipeline.track, null);
  });
});
