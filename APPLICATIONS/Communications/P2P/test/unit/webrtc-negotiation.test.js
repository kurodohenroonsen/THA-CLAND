/**
 * Suite de Tests Unitaires et d'Intégration WebRTC — Négociation SDP Glare & Mocking W3C
 * Persona 7.7 : Mocking Signalement WebRTC & Tests de Négociation SDP Glare (2025/2026)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

export class MockRTCSessionDescription {
  constructor(init = {}) {
    this.type = init.type || 'offer';
    this.sdp = init.sdp || `v=0\r\no=- ${Date.now()} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 127.0.0.1\r\na=mid:0\r\n`;
  }
}

export class MockRTCIceCandidate {
  constructor(init = {}) {
    this.candidate = init.candidate || 'candidate:1 1 UDP 2122260223 127.0.0.1 50000 typ host';
    this.sdpMid = init.sdpMid || '0';
    this.sdpMLineIndex = init.sdpMLineIndex !== undefined ? init.sdpMLineIndex : 0;
    this.usernameFragment = init.usernameFragment || 'ufrag123';
  }
}

export class MockRTCDataChannel {
  constructor(label, options = {}) {
    this.label = label;
    this.id = options.id !== undefined ? options.id : Math.floor(Math.random() * 1000);
    this.ordered = options.ordered !== undefined ? options.ordered : true;
    this.maxRetransmits = options.maxRetransmits !== undefined ? options.maxRetransmits : null;
    this.priority = options.priority || 'high';
    this.binaryType = 'arraybuffer';
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 64 * 1024;

    this._eventListeners = new Map();
    this._pairedChannel = null;

    setTimeout(() => {
      if (this.readyState === 'connecting') {
        this.readyState = 'open';
        this._emit('open', { type: 'open' });
      }
    }, 5);
  }

  addEventListener(type, listener) {
    if (!this._eventListeners.has(type)) {
      this._eventListeners.set(type, []);
    }
    this._eventListeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    if (this._eventListeners.has(type)) {
      const list = this._eventListeners.get(type).filter(l => l !== listener);
      this._eventListeners.set(type, list);
    }
  }

  _emit(type, event) {
    if (typeof this[`on${type}`] === 'function') {
      this[`on${type}`](event);
    }
    if (this._eventListeners.has(type)) {
      this._eventListeners.get(type).forEach(fn => fn(event));
    }
  }

  send(data) {
    if (this.readyState !== 'open') {
      throw new Error(`InvalidStateError: RTCDataChannel.send() called when readyState is ${this.readyState}`);
    }

    const byteLen = typeof data === 'string' ? data.length : (data.byteLength || 0);
    this.bufferedAmount += byteLen;

    setTimeout(() => {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLen);
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this._emit('bufferedamountlow', { type: 'bufferedamountlow' });
      }
    }, 10);

    if (this._pairedChannel && this._pairedChannel.readyState === 'open') {
      setTimeout(() => {
        this._pairedChannel._emit('message', { data });
      }, 5);
    }
  }

  close() {
    if (this.readyState !== 'closed') {
      this.readyState = 'closed';
      this._emit('close', { type: 'close' });
    }
  }
}

export class MockRTCPeerConnection {
  constructor(config = {}) {
    this.config = config;
    this.signalingState = 'stable';
    this.iceConnectionState = 'new';
    this.iceGatheringState = 'new';
    this.connectionState = 'new';

    this.localDescription = null;
    this.remoteDescription = null;
    this.pendingLocalDescription = null;
    this.pendingRemoteDescription = null;

    this.transceivers = [];
    this.senders = [];
    this.receivers = [];
    this.dataChannels = [];
    this.bufferedCandidates = [];

    this._eventListeners = new Map();
    this._isClosed = false;
    this._pairedPC = null;
  }

  addEventListener(type, listener) {
    if (!this._eventListeners.has(type)) {
      this._eventListeners.set(type, []);
    }
    this._eventListeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    if (this._eventListeners.has(type)) {
      const list = this._eventListeners.get(type).filter(l => l !== listener);
      this._eventListeners.set(type, list);
    }
  }

  _emit(type, event) {
    if (typeof this[`on${type}`] === 'function') {
      this[`on${type}`](event);
    }
    if (this._eventListeners.has(type)) {
      this._eventListeners.get(type).forEach(fn => fn(event));
    }
  }

  createDataChannel(label, options = {}) {
    if (this.signalingState === 'closed') {
      throw new Error('InvalidStateError: RTCPeerConnection is closed');
    }
    const channel = new MockRTCDataChannel(label, options);
    this.dataChannels.push(channel);
    return channel;
  }

  async createOffer(options = {}) {
    if (this.signalingState === 'closed') {
      throw new Error('InvalidStateError: RTCPeerConnection is closed');
    }
    const sdpContent = `v=0\r\no=mock-peer ${Date.now()} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=setup:actpass\r\n`;
    return new MockRTCSessionDescription({ type: 'offer', sdp: sdpContent });
  }

  async createAnswer(options = {}) {
    if (this.signalingState !== 'have-remote-offer' && this.signalingState !== 'have-local-pranswer') {
      throw new Error(`InvalidStateError: Cannot create answer in signalingState '${this.signalingState}'`);
    }
    const sdpContent = `v=0\r\no=mock-peer ${Date.now()} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=setup:active\r\n`;
    return new MockRTCSessionDescription({ type: 'answer', sdp: sdpContent });
  }

  async setLocalDescription(description) {
    if (this.signalingState === 'closed') {
      throw new Error('InvalidStateError: RTCPeerConnection is closed');
    }

    if (description && description.type === 'rollback') {
      if (this.signalingState === 'stable') {
        throw new Error('InvalidStateError: Cannot rollback when signalingState is stable');
      }
      this.signalingState = 'stable';
      this.pendingLocalDescription = null;
      this.pendingRemoteDescription = null;
      this._emit('signalingstatechange', { type: 'signalingstatechange' });
      return;
    }

    if (!description || !description.type) {
      throw new Error('TypeError: setLocalDescription requires a valid RTCSessionDescriptionInit');
    }

    if (description.type === 'offer') {
      if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer') {
        throw new Error(`InvalidStateError: Cannot set local offer in state '${this.signalingState}'`);
      }
      this.signalingState = 'have-local-offer';
      this.pendingLocalDescription = new MockRTCSessionDescription(description);
      this.localDescription = this.pendingLocalDescription;
    } else if (description.type === 'answer') {
      if (this.signalingState !== 'have-remote-offer') {
        throw new Error(`InvalidStateError: Cannot set local answer in state '${this.signalingState}'`);
      }
      this.signalingState = 'stable';
      this.localDescription = new MockRTCSessionDescription(description);
      this.pendingLocalDescription = null;
      this.pendingRemoteDescription = null;
      this._transitionToConnected();
    }

    this._emit('signalingstatechange', { type: 'signalingstatechange' });
    this._simulateIceGathering();
  }

  async setRemoteDescription(description) {
    if (this.signalingState === 'closed') {
      throw new Error('InvalidStateError: RTCPeerConnection is closed');
    }

    if (description && description.type === 'rollback') {
      if (this.signalingState === 'stable') {
        throw new Error('InvalidStateError: Cannot rollback remote description in stable state');
      }
      this.signalingState = 'stable';
      this.pendingLocalDescription = null;
      this.pendingRemoteDescription = null;
      this._emit('signalingstatechange', { type: 'signalingstatechange' });
      return;
    }

    if (!description || !description.type) {
      throw new Error('TypeError: setRemoteDescription requires a valid RTCSessionDescriptionInit');
    }

    if (description.type === 'offer') {
      if (this.signalingState !== 'stable') {
        throw new Error(`InvalidStateError: Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': Called in wrong state: ${this.signalingState}`);
      }
      this.signalingState = 'have-remote-offer';
      this.pendingRemoteDescription = new MockRTCSessionDescription(description);
      this.remoteDescription = this.pendingRemoteDescription;
      this._flushBufferedCandidates();
    } else if (description.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') {
        throw new Error(`InvalidStateError: Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': Called in wrong state: ${this.signalingState}`);
      }
      this.signalingState = 'stable';
      this.remoteDescription = new MockRTCSessionDescription(description);
      this.pendingLocalDescription = null;
      this.pendingRemoteDescription = null;
      this._transitionToConnected();
      this._flushBufferedCandidates();
    }

    this._emit('signalingstatechange', { type: 'signalingstatechange' });
  }

  async addIceCandidate(candidate) {
    if (this.signalingState === 'closed') {
      throw new Error('InvalidStateError: RTCPeerConnection is closed');
    }
    if (!this.remoteDescription) {
      this.bufferedCandidates.push(candidate);
      return;
    }
    this.bufferedCandidates.push(candidate);
  }

  _flushBufferedCandidates() {
    if (this.remoteDescription && this.bufferedCandidates.length > 0) {
      this.bufferedCandidates = [];
    }
  }

  _simulateIceGathering() {
    this.iceGatheringState = 'gathering';
    this._emit('icegatheringstatechange', { type: 'icegatheringstatechange' });

    setTimeout(() => {
      if (this._isClosed) return;
      const mockCandidate = new MockRTCIceCandidate({
        candidate: 'candidate:42 1 UDP 2122260223 192.168.1.50 50000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0
      });
      this._emit('icecandidate', { candidate: mockCandidate });

      setTimeout(() => {
        if (this._isClosed) return;
        this.iceGatheringState = 'complete';
        this._emit('icecandidate', { candidate: null });
        this._emit('icegatheringstatechange', { type: 'icegatheringstatechange' });
      }, 10);
    }, 5);
  }

  _transitionToConnected() {
    setTimeout(() => {
      if (this._isClosed) return;
      this.iceConnectionState = 'connected';
      this.connectionState = 'connected';
      this._emit('iceconnectionstatechange', { type: 'iceconnectionstatechange' });
      this._emit('connectionstatechange', { type: 'connectionstatechange' });
    }, 10);
  }

  close() {
    if (!this._isClosed) {
      this._isClosed = true;
      this.signalingState = 'closed';
      this.iceConnectionState = 'closed';
      this.connectionState = 'closed';
      this.dataChannels.forEach(ch => ch.close());
      this._emit('signalingstatechange', { type: 'signalingstatechange' });
      this._emit('iceconnectionstatechange', { type: 'iceconnectionstatechange' });
      this._emit('connectionstatechange', { type: 'connectionstatechange' });
    }
  }
}

export function pairMockConnections(pcA, pcB) {
  pcA._pairedPC = pcB;
  pcB._pairedPC = pcA;

  const pairChannels = (sourcePC, targetPC) => {
    const origCreateDC = sourcePC.createDataChannel.bind(sourcePC);
    sourcePC.createDataChannel = (label, opts) => {
      const chA = origCreateDC(label, opts);
      const chB = new MockRTCDataChannel(label, opts);
      targetPC.dataChannels.push(chB);

      chA._pairedChannel = chB;
      chB._pairedChannel = chA;

      setTimeout(() => {
        targetPC._emit('datachannel', { channel: chB });
      }, 5);

      return chA;
    };
  };

  pairChannels(pcA, pcB);
  pairChannels(pcB, pcA);
}

export class PerfectNegotiationPeer {
  constructor({ id, isPolite, signalingChannel, pcConfig = {} }) {
    this.id = id;
    this.isPolite = isPolite;
    this.signaling = signalingChannel;
    this.pc = new MockRTCPeerConnection(pcConfig);

    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;
    this.negotiationCount = 0;
    this.rollbackCount = 0;
    this.glareCollisionCount = 0;

    this._setupSignalingListeners();
  }

  _setupSignalingListeners() {
    this.pc.onnegotiationneeded = async () => {
      await this.negotiate();
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.signaling.send({
          from: this.id,
          type: 'candidate',
          candidate
        });
      }
    };

    this.signaling.onmessage = async (msg) => {
      if (msg.from === this.id) return;

      try {
        if (msg.type === 'description') {
          await this.handleDescription(msg.description);
        } else if (msg.type === 'candidate') {
          await this.handleCandidate(msg.candidate);
        }
      } catch (err) {
        console.error(`[${this.id}] Erreur traitement signal:`, err);
      }
    };
  }

  async negotiate() {
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      this.signaling.send({
        from: this.id,
        type: 'description',
        description: this.pc.localDescription
      });
      this.negotiationCount++;
    } catch (err) {
      console.error(`[${this.id}] Erreur negotiate():`, err);
    } finally {
      this.makingOffer = false;
    }
  }

  async handleDescription(description) {
    const isOffer = description.type === 'offer';
    const isCollision = isOffer && (this.makingOffer || this.pc.signalingState !== 'stable');

    this.ignoreOffer = !this.isPolite && isCollision;

    if (this.ignoreOffer) {
      this.glareCollisionCount++;
      return;
    }

    if (isCollision && this.isPolite) {
      this.glareCollisionCount++;
      this.rollbackCount++;
      await this.pc.setLocalDescription({ type: 'rollback' });
    }

    this.isSettingRemoteAnswerPending = !isOffer;
    await this.pc.setRemoteDescription(description);
    this.isSettingRemoteAnswerPending = false;

    if (isOffer) {
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.signaling.send({
        from: this.id,
        type: 'description',
        description: this.pc.localDescription
      });
    }
  }

  async handleCandidate(candidate) {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      if (!this.ignoreOffer) {
        throw err;
      }
    }
  }
}

export class InMemorySignalingChannel {
  constructor(latencyMs = 5) {
    this.latencyMs = latencyMs;
    this.peers = new Map();
  }

  register(peerId, onMessageCallback) {
    this.peers.set(peerId, onMessageCallback);
    return {
      send: (msg) => this._routeMessage(peerId, msg),
      onmessage: null
    };
  }

  _routeMessage(senderId, msg) {
    this.peers.forEach((callback, recipientId) => {
      if (recipientId !== senderId && typeof callback === 'function') {
        setTimeout(() => {
          callback(msg);
        }, this.latencyMs);
      }
    });
  }
}

describe('🛰️ Tests WebRTC Mocking & Négociation SDP Glare (Expert 7.7)', () => {

  it('Établissement nominal unilatéral (Offer/Answer)', async () => {
    const signaling = new InMemorySignalingChannel(2);
    const chanA = { send: (m) => signaling._routeMessage('peerA', m), onmessage: null };
    const chanB = { send: (m) => signaling._routeMessage('peerB', m), onmessage: null };

    signaling.register('peerA', (m) => chanA.onmessage && chanA.onmessage(m));
    signaling.register('peerB', (m) => chanB.onmessage && chanB.onmessage(m));

    const peerA = new PerfectNegotiationPeer({ id: 'peerA', isPolite: true, signalingChannel: chanA });
    const peerB = new PerfectNegotiationPeer({ id: 'peerB', isPolite: false, signalingChannel: chanB });
    pairMockConnections(peerA.pc, peerB.pc);

    peerA.pc.createDataChannel('p2p-control');
    await peerA.negotiate();

    await new Promise(r => setTimeout(r, 60));

    assert.equal(peerA.pc.signalingState, 'stable');
    assert.equal(peerB.pc.signalingState, 'stable');
    assert.equal(peerA.pc.connectionState, 'connected');
    assert.equal(peerB.pc.connectionState, 'connected');
  });

  it('Collision SDP Glare simultanée (Polite Rollback vs Impolite Stand-ground)', async () => {
    const signaling = new InMemorySignalingChannel(5);
    const chanA = { send: (m) => signaling._routeMessage('peerA_polite', m), onmessage: null };
    const chanB = { send: (m) => signaling._routeMessage('peerB_impolite', m), onmessage: null };

    signaling.register('peerA_polite', (m) => chanA.onmessage && chanA.onmessage(m));
    signaling.register('peerB_impolite', (m) => chanB.onmessage && chanB.onmessage(m));

    const peerPolite = new PerfectNegotiationPeer({ id: 'peerA_polite', isPolite: true, signalingChannel: chanA });
    const peerImpolite = new PerfectNegotiationPeer({ id: 'peerB_impolite', isPolite: false, signalingChannel: chanB });
    pairMockConnections(peerPolite.pc, peerImpolite.pc);

    peerPolite.pc.createDataChannel('p2p-control');
    peerImpolite.pc.createDataChannel('p2p-control');

    await Promise.all([
      peerPolite.negotiate(),
      peerImpolite.negotiate()
    ]);

    await new Promise(r => setTimeout(r, 100));

    assert.ok(peerPolite.glareCollisionCount > 0, 'Le pair poli a détecté la collision de glare');
    assert.equal(peerPolite.rollbackCount, 1, 'Le pair poli a exécuté exactement 1 rollback W3C');
    assert.ok(peerImpolite.glareCollisionCount > 0, 'Le pair impoli a détecté et ignoré l\'offre concurrente');
    assert.equal(peerPolite.pc.signalingState, 'stable');
    assert.equal(peerImpolite.pc.signalingState, 'stable');
    assert.equal(peerPolite.pc.connectionState, 'connected');
  });

  it('Bufferisation Trickle ICE des candidats prématurés', async () => {
    const pc = new MockRTCPeerConnection();
    const earlyCandidate = new MockRTCIceCandidate({ candidate: 'candidate:1 1 UDP 2122260223 10.0.0.1 5000 typ host' });

    await pc.addIceCandidate(earlyCandidate);
    assert.equal(pc.bufferedCandidates.length, 1);

    const offer = await pc.createOffer();
    await pc.setRemoteDescription(offer);

    assert.equal(pc.bufferedCandidates.length, 0);
  });

  it('Régulation de flux & contre-pression RTCDataChannel (bufferedamountlow)', async () => {
    const dc = new MockRTCDataChannel('p2p-data', { ordered: false, maxRetransmits: 0 });
    dc.readyState = 'open';

    let lowEventFired = false;
    dc.addEventListener('bufferedamountlow', () => {
      lowEventFired = true;
    });

    const largeChunk = new Uint8Array(128 * 1024);
    dc.send(largeChunk);

    assert.equal(dc.bufferedAmount, 128 * 1024);

    await new Promise(r => setTimeout(r, 30));

    assert.equal(lowEventFired, true);
    assert.equal(dc.bufferedAmount, 0);
  });

  it('Teardown déterministe & fermeture des sockets', () => {
    const pc = new MockRTCPeerConnection();
    const dc1 = pc.createDataChannel('p2p-control');
    const dc2 = pc.createDataChannel('p2p-data');

    pc.close();

    assert.equal(pc.signalingState, 'closed');
    assert.equal(pc.connectionState, 'closed');
    assert.equal(dc1.readyState, 'closed');
    assert.equal(dc2.readyState, 'closed');
  });
});
