/**
 * Test Unitaire : Négociation Parfaite WebRTC, ICE Candidate Queuing & Contrôle de Flux
 * Fichier : test/unit/webrtc-negotiation-flow.test.js
 * Personas G3.P1, G3.P2, G3.P4, G3.P7, G3.P8
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IceCandidateManager } from '../../Extension/sidepanel/js/core/ice-manager.js';
import { DataChannelFlowController } from '../../Extension/sidepanel/js/core/datachannel-flow-controller.js';
import { BinaryFrameRouter, FRAME_TYPES, FRAME_FLAGS } from '../../Extension/sidepanel/js/core/binary-frame-router.js';
import { SDPSecureSignaling } from '../../Extension/sidepanel/js/core/secure-signaling-e2ee.js';

describe('🤝 Tests Protocoles WebRTC & Framing Binaire (Pass 4)', () => {

  it('IceCandidateManager : Tri de priorité RFC 8445 et queueing des candidats précoces', async () => {
    const appliedCandidates = [];
    const mockPc = {
      remoteDescription: null,
      signalingState: 'have-local-offer',
      addIceCandidate: async (c) => appliedCandidates.push(c.candidate)
    };

    const iceMgr = new IceCandidateManager(mockPc, 'peer_test');

    // Ajout de candidats avant setRemoteDescription
    await iceMgr.addRemoteCandidate({ candidate: 'candidate:1 1 UDP 2122260223 192.168.1.10 50000 typ host' });
    await iceMgr.addRemoteCandidate({ candidate: 'candidate:2 1 UDP 1686052863 82.64.1.1 50001 typ srflx' });
    await iceMgr.addRemoteCandidate({ candidate: 'candidate:3 1 UDP 41885439 10.0.0.1 50002 typ relay' });

    assert.equal(appliedCandidates.length, 0, 'Aucun candidat ne doit être appliqué avant setRemoteDescription');
    assert.equal(iceMgr.earlyQueue.length, 3);
    // Vérification que le candidat host est en tête (priorité max)
    assert.ok(iceMgr.earlyQueue[0].candidate.includes('typ host'));

    // Simulation de setRemoteDescription
    mockPc.remoteDescription = { type: 'offer' };
    await iceMgr.onRemoteDescriptionSet();

    assert.equal(appliedCandidates.length, 3, 'Les 3 candidats doivent être vidés et appliqués');
    assert.ok(appliedCandidates[0].includes('typ host'), 'Host doit être appliqué en premier');
    assert.equal(iceMgr.earlyQueue.length, 0, 'La file d\'attente doit être vide');
  });

  it('DataChannelFlowController : Dimensionnement dynamique BDP selon contexte média', () => {
    const controller = new DataChannelFlowController();

    // Mode repos (pas d'appel média)
    const idleThresh = controller.computeOptimalThresholds(40, false);
    assert.ok(idleThresh.lowThreshold >= 64 * 1024);
    assert.ok(idleThresh.highWatermark > idleThresh.lowThreshold);

    // Mode appel média actif (seuil resserré pour préserver l'audio)
    const mediaThresh = controller.computeOptimalThresholds(40, true);
    assert.equal(mediaThresh.lowThreshold, 32 * 1024);
    assert.equal(mediaThresh.highWatermark, 64 * 1024);
  });

  it('BinaryFrameRouter : Encodage et décodage Zero-Copy de trames binaires', async () => {
    const router = new BinaryFrameRouter();
    let receivedPayload = null;

    router.registerHandler(FRAME_TYPES.CRDT_DELTA, (frame) => {
      receivedPayload = new TextDecoder().decode(frame.payloadBytes);
    });

    const testPayload = JSON.stringify({ action: 'insert', char: 'K', pos: 42 });
    const encodedBuffer = await router.encodeFrame({
      type: FRAME_TYPES.CRDT_DELTA,
      payload: testPayload,
      streamId: 101,
      compressIfBeneficial: false
    });

    assert.ok(encodedBuffer.byteLength > 12);
    const decodedFrame = await router.decodeAndRoute(encodedBuffer, 'peer_bob');

    assert.equal(decodedFrame.type, FRAME_TYPES.CRDT_DELTA);
    assert.equal(decodedFrame.streamId, 101);
    assert.equal(receivedPayload, testPayload);
  });

  it('SDPSecureSignaling : Calcul déterministe SAS 7 Émojis & 60 Digits', async () => {
    const paramsAlice = {
      localPubkeyHex: '04aabbccdd',
      remotePubkeyHex: '0411223344',
      localDtlsFingerprint: 'sha-256:11:22:33:44:55:66',
      remoteDtlsFingerprint: 'sha-256:aa:bb:cc:dd:ee:ff',
      topicHex: 'deadbeefcafe'
    };

    const paramsBob = {
      localPubkeyHex: '0411223344',
      remotePubkeyHex: '04aabbccdd',
      localDtlsFingerprint: 'sha-256:aa:bb:cc:dd:ee:ff',
      remoteDtlsFingerprint: 'sha-256:11:22:33:44:55:66',
      topicHex: 'deadbeefcafe'
    };

    const sasAlice = await SDPSecureSignaling.computeSessionSAS(paramsAlice);
    const sasBob = await SDPSecureSignaling.computeSessionSAS(paramsBob);

    assert.equal(sasAlice.numericCode, sasBob.numericCode, 'Le code numérique SAS doit être strictement commutatif');
    assert.equal(sasAlice.emojiString, sasBob.emojiString, 'Les 7 émojis doivent être identiques chez Alice et Bob');
    assert.equal(sasAlice.emojis.length, 7, 'Le SAS doit contenir exactement 7 émojis');
  });

  it('SDPSecureSignaling : Découpage et recomposition QR Code Multipart UR', () => {
    const testData = { sdp: 'v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 AA:BB:CC\r\n'.repeat(5) };
    const qrData = SDPSecureSignaling.createMultipartQR(testData, 60);

    assert.ok(qrData.totalChunks > 1, 'Le SDP volumineux doit être découpé en plusieurs trames');
    assert.equal(qrData.frames.length, qrData.totalChunks);

    const collector = new Map();
    let assembled = null;

    for (const frame of qrData.frames) {
      assembled = SDPSecureSignaling.assembleMultipartQR(collector, frame);
    }

    assert.deepEqual(assembled, testData, 'Le SDP réassemblé doit être strictement identique au SDP original');
  });
});
