/**
 * Test Unitaire & Simulation Réseau : Gossip Hybride, Arbre Couvrant (MST) & Auto-Guérison
 * Fichier : test/unit/gossip-mesh-mst.test.js
 * Persona G3.P3 : Moteur Gossip Multi-Hop Epidémique & Arbre Couvrant Minimum
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GenerationalSlidingCache } from '../../Extension/sidepanel/js/core/bounded-cache.js';
import { HybridGossipEngine } from '../../Extension/sidepanel/js/core/hybrid-gossip-engine.js';

describe('🌲 Tests Formels Moteur Gossip Hybride & Arbre Couvrant (Persona G3.P3)', () => {

  it('GenerationalSlidingCache : Résistance aux rafales et protection anti-avalanche', () => {
    const cache = new GenerationalSlidingCache({
      generationSize: 100,
      rotateIntervalMs: 1000,
      minRotateIntervalMs: 200
    });

    for (let i = 0; i < 250; i++) {
      cache.addIfNew(`burst_key_${i}`);
    }

    assert.equal(cache.has('burst_key_0'), true, 'burst_key_0 doit être conservée');
    assert.equal(cache.has('burst_key_249'), true, 'burst_key_249 doit être conservée');
    assert.ok(cache.size >= 250, 'La taille globale doit englober le buffer de débordement');

    cache.destroy();
  });

  it('PlumTree Spanning Tree : Convergence vers un arbre sans cycle via PRUNE', async () => {
    const eventsC = [];

    let engineA, engineB, engineC;

    const mockMeshA = { peers: new Map([['peerB', {}], ['peerC', {}]]), on: () => {}, sendToPeer: async (p, m) => {
      if (p === 'peerB') engineB.handleGossipMessage('peerA', m);
      if (p === 'peerC') engineC.handleGossipMessage('peerA', m);
    }};

    const mockMeshB = { peers: new Map([['peerA', {}], ['peerC', {}]]), on: () => {}, sendToPeer: async (p, m) => {
      if (p === 'peerA') engineA.handleGossipMessage('peerB', m);
      if (p === 'peerC') engineC.handleGossipMessage('peerB', m);
    }};

    const mockMeshC = { peers: new Map([['peerA', {}], ['peerB', {}]]), on: () => {}, sendToPeer: async (p, m) => {
      if (p === 'peerA') engineA.handleGossipMessage('peerC', m);
      if (p === 'peerB') engineB.handleGossipMessage('peerC', m);
    }};

    const vaultMock = { peerIdHex: '00'.repeat(20) };

    engineA = new HybridGossipEngine(mockMeshA, vaultMock, { targetEagerDegree: 2 });
    engineB = new HybridGossipEngine(mockMeshB, vaultMock, { targetEagerDegree: 2 });
    engineC = new HybridGossipEngine(mockMeshC, vaultMock, { targetEagerDegree: 2 });

    engineA._onPeerJoined('peerB');
    engineA._onPeerJoined('peerC');
    engineB._onPeerJoined('peerA');
    engineB._onPeerJoined('peerC');
    engineC._onPeerJoined('peerA');
    engineC._onPeerJoined('peerB');

    engineC.on('message', (m) => eventsC.push(m));

    await engineA.publish('CHAT_MSG', { text: 'Hello Tree' }, 'msg_test_1');

    await new Promise(r => setTimeout(r, 100));

    assert.equal(eventsC.length, 1, 'C doit recevoir le message exactement une fois');
    assert.equal(eventsC[0].payload.text, 'Hello Tree');

    engineA.destroy();
    engineB.destroy();
    engineC.destroy();
  });

  it('Auto-guérison de partition (Tree Healing via IWANT + GRAFT)', async () => {
    let iwantReceived = false;
    let graftReceived = false;

    const mockMeshB = { peers: new Map([['peerA', {}]]), on: () => {}, sendToPeer: async (p, m) => {
      if (m.type === 'GOSSIP_IWANT') iwantReceived = true;
      if (m.type === 'GOSSIP_GRAFT') graftReceived = true;
    }};

    const vaultMock = { peerIdHex: '11'.repeat(20) };
    const engineB = new HybridGossipEngine(mockMeshB, vaultMock, { ihaveTimeoutMs: 50 });
    engineB.peerRoles.set('peerA', 'lazy');

    engineB.handleGossipMessage('peerA', { type: 'GOSSIP_IHAVE', ids: ['msg_missing_42'] });

    await new Promise(r => setTimeout(r, 80));

    assert.ok(iwantReceived, 'Une requête IWANT doit être émise suite au timeout de message manquant');
    assert.ok(graftReceived, 'Une requête GRAFT doit être émise pour promouvoir le lien en Eager');
    assert.equal(engineB.peerRoles.get('peerA'), 'eager', 'Le lien vers peerA doit être promu EAGER');

    engineB.destroy();
  });
});
