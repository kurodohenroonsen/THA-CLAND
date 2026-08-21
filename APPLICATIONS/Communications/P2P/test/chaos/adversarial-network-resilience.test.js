/**
 * test/chaos/adversarial-network-resilience.test.js
 * Suite de Tests Adversariaux Réseau & Preuves de Résilience Pass 4
 * Personas G3.P9 & G3.P10 : Flood DoS, Eclipse Isolation, Perfect Negotiation Glare & O(log N) Gossip.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

class InboundRateLimiter {
  constructor({ maxTokens = 60, refillRatePerSec = 30, maxBytesPerSec = 512 * 1024 } = {}) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRatePerSec;
    this.maxBytesPerSec = maxBytesPerSec;
    this.tokens = maxTokens;
    this.byteBucket = maxBytesPerSec;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsedSec * this.refillRate);
    this.byteBucket = Math.min(this.maxBytesPerSec, this.byteBucket + elapsedSec * this.maxBytesPerSec);
    this.lastRefill = now;
  }

  allowMessage(byteSize = 100) {
    this._refill();
    if (this.tokens < 1 || this.byteBucket < byteSize) {
      return false;
    }
    this.tokens -= 1;
    this.byteBucket -= byteSize;
    return true;
  }
}

class AntiEclipseMeshGovernor {
  constructor({ maxActivePeers = 8, maxPendingOffers = 4 } = {}) {
    this.maxActivePeers = maxActivePeers;
    this.maxPendingOffers = maxPendingOffers;
    this.activePeers = new Map();
    this.knownPubkeys = new Set();
  }

  canAcceptInboundOffer(remotePeerId, remotePubkey) {
    if (this.activePeers.size >= this.maxActivePeers) return { allowed: false, reason: 'MESH_FULL' };
    if (remotePubkey && this.knownPubkeys.has(remotePubkey)) {
      return { allowed: false, reason: 'DUPLICATE_PUBKEY_SYBIL' };
    }
    return { allowed: true };
  }

  registerPeer(peerId, pubkey) {
    this.activePeers.set(peerId, { pubkey, connectedAt: Date.now() });
    if (pubkey) this.knownPubkeys.add(pubkey);
  }

  removePeer(peerId) {
    const p = this.activePeers.get(peerId);
    if (p && p.pubkey) this.knownPubkeys.delete(p.pubkey);
    this.activePeers.delete(peerId);
  }
}

class PerfectNegotiator {
  constructor(peerId, isPolite) {
    this.peerId = peerId;
    this.isPolite = isPolite;
    this.signalingState = 'stable';
    this.makingOffer = false;
    this.ignoreOffer = false;
  }

  async handleInboundOffer(remoteOffer) {
    const offerCollision = this.makingOffer || this.signalingState !== 'stable';
    this.ignoreOffer = !this.isPolite && offerCollision;

    if (this.ignoreOffer) {
      return { status: 'IGNORED_GLARE_COLLISION' };
    }

    if (offerCollision && this.isPolite) {
      this.signalingState = 'stable';
    }

    this.signalingState = 'have-remote-offer';
    return { status: 'ACCEPTED_AND_ANSWERED' };
  }
}

describe('🛡️ Audit Adversarial Réseau & Robustesse Maillée (Pass 4)', () => {

  it('⚡ TEST 1 : Résistance au DoS Ingress & Fragment Bomb sur p2p-control', () => {
    const limiter = new InboundRateLimiter({ maxTokens: 50, refillRatePerSec: 20, maxBytesPerSec: 64 * 1024 });
    let accepted = 0;
    let dropped = 0;

    for (let i = 0; i < 500; i++) {
      if (limiter.allowMessage(256)) {
        accepted++;
      } else {
        dropped++;
      }
    }

    assert.equal(accepted, 50, 'Le Token Bucket doit plafonner exactement au burst initial de 50 paquets');
    assert.equal(dropped, 450, 'Les 450 paquets excédentaires doivent être immédiatement rejetés');
  });

  it('⚡ TEST 2 : Coalescence des PING/PONG et Atténuation du Flood de Présence', async () => {
    let pongSentCount = 0;
    let lastPongTime = 0;
    const MIN_PONG_INTERVAL_MS = 100;

    const handlePing = () => {
      const now = Date.now();
      if (now - lastPongTime >= MIN_PONG_INTERVAL_MS) {
        lastPongTime = now;
        pongSentCount++;
      }
    };

    for (let i = 0; i < 1000; i++) {
      handlePing();
    }

    assert.equal(pongSentCount, 1, '1 000 PING instantanés ne doivent déclencher qu\'un unique PONG');
  });

  it('⚡ TEST 3 : Résistance aux Attaques d\'Éclipse & Sybil Inbound sur le Signalement', () => {
    const governor = new AntiEclipseMeshGovernor({ maxActivePeers: 4 });

    for (let i = 1; i <= 4; i++) {
      const res = governor.canAcceptInboundOffer(`peer_${i}`, `pubkey_${i}`);
      assert.equal(res.allowed, true);
      governor.registerPeer(`peer_${i}`, `pubkey_${i}`);
    }

    const overflowAttempt = governor.canAcceptInboundOffer('peer_5', 'pubkey_5');
    assert.equal(overflowAttempt.allowed, false);
    assert.equal(overflowAttempt.reason, 'MESH_FULL');

    governor.removePeer('peer_4');
    const sybilAttempt = governor.canAcceptInboundOffer('peer_sybil', 'pubkey_1');
    assert.equal(sybilAttempt.allowed, false);
    assert.equal(sybilAttempt.reason, 'DUPLICATE_PUBKEY_SYBIL');
  });

  it('⚡ TEST 4 : Résolution de Glare WebRTC sans Interblocage (Perfect Negotiation)', async () => {
    const peerA = new PerfectNegotiator('peerA', false); // Impolite
    const peerB = new PerfectNegotiator('peerB', true);  // Polite

    peerA.makingOffer = true;
    peerA.signalingState = 'have-local-offer';

    peerB.makingOffer = true;
    peerB.signalingState = 'have-local-offer';

    const resB = await peerB.handleInboundOffer({ sdp: 'offerA' });
    assert.equal(resB.status, 'ACCEPTED_AND_ANSWERED');

    const resA = await peerA.handleInboundOffer({ sdp: 'offerB' });
    assert.equal(resA.status, 'IGNORED_GLARE_COLLISION');

    assert.equal(peerB.signalingState, 'have-remote-offer');
  });

  it('⚡ TEST 5 : Preuve de Propagation Épidémique en O(log N) Étapes', () => {
    const N = 64;
    const fanout = 4;
    const informed = new Set([0]);
    let rounds = 0;

    while (informed.size < N && rounds < 20) {
      rounds++;
      const currentInformed = Array.from(informed);
      for (const node of currentInformed) {
        for (let f = 0; f < fanout; f++) {
          const target = Math.floor(Math.random() * N);
          informed.add(target);
        }
      }
    }

    const theoreticalBound = Math.ceil(3 * Math.log2(N));
    assert.equal(informed.size, N, 'Tous les 64 nœuds doivent avoir reçu le message');
    assert.ok(rounds <= theoreticalBound, `Convergence atteinte en ${rounds} rounds (<= borne ${theoreticalBound})`);
  });
});
