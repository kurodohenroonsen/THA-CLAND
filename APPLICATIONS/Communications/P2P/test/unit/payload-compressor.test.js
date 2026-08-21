/**
 * test/unit/payload-compressor.test.js
 * Banc de test de validation formelle de PayloadCompressor & Dictionnaire P2P (Pass 4)
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { PayloadCompressor, P2PDictionaryCodec } from '../../Extension/sidepanel/js/core/stream-compressor.js';

describe('⚡ G7.P3 — PayloadCompressor & Dictionnaire Partagé P2P', () => {
  it('doit garantir le non-gonflement sur petits messages (Anti-Inflation)', async () => {
    const smallText = 'Hello!';
    const res = await PayloadCompressor.compressAdaptive(smallText);
    assert.strictEqual(res.format, PayloadCompressor.FORMAT_RAW);
    assert.strictEqual(res.compressedSize, res.rawSize + 1);

    const decoded = await PayloadCompressor.decompressAdaptive(res.data);
    assert.strictEqual(new TextDecoder().decode(decoded), smallText);
  });

  it('doit compacter significativement les messages JSON de salon via le dictionnaire statique', async () => {
    const chatMsg = {
      type: 'CHAT_MSG',
      channelId: 'general',
      authorId: 'peer_98a7f6e5d4c3b2a1',
      authorName: 'Alice',
      authorPubkey: '04a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
      timestamp: 1771675825000,
      lamport: 42,
      signature: '3045022100abcde1234567890f...'
    };

    const res = await PayloadCompressor.compressAdaptive(chatMsg);
    assert.ok(res.compressedSize < res.rawSize, `Attendu plus compact : ${res.compressedSize} < ${res.rawSize}`);
    assert.ok(res.ratio < 0.90, `Ratio attendu < 0.90, obtenu: ${res.ratio.toFixed(2)}`);

    const decodedObj = await PayloadCompressor.decompressAdaptive(res.data, true);
    assert.strictEqual(decodedObj.type, chatMsg.type);
    assert.strictEqual(decodedObj.authorPubkey, chatMsg.authorPubkey);
    assert.strictEqual(decodedObj.lamport, chatMsg.lamport);
  });

  it('doit atteindre une réduction significative sur les deltas CRDT volumineux', async () => {
    const mockMessages = Array.from({ length: 30 }, (_, i) => ({
      id: `msg_${i}_${Date.now()}`,
      channelId: 'general',
      authorId: `peer_${i}`,
      authorPubkey: '04'.repeat(33),
      timestamp: Date.now() + i * 1000,
      lamport: 100 + i,
      text: `Contenu du message numéro ${i} synchronisé avec le demi-treillis CRDT et le protocole anti-entropie.`
    }));

    const deltaObj = {
      type: 'CRDT_SYNC_RESP',
      messages: mockMessages,
      threads: [],
      commits: [],
      lamport: 150
    };

    const res = await PayloadCompressor.compressAdaptive(deltaObj);
    assert.ok(res.ratio < 0.40, `Taux de réduction CRDT attendu, ratio obtenu: ${(res.ratio * 100).toFixed(1)}%`);

    const restored = await PayloadCompressor.decompressAdaptive(res.data, true);
    assert.strictEqual(restored.messages.length, 30);
    assert.strictEqual(restored.messages[0].text, mockMessages[0].text);
  });

  it('doit bloquer les attaques Zip Bomb lors de la décompression', async () => {
    const bombSource = new Uint8Array(2 * 1024 * 1024);
    const compressedBomb = await PayloadCompressor.compressRaw(bombSource);

    await assert.rejects(
      async () => {
        await PayloadCompressor.decompressRaw(compressedBomb, 512 * 1024);
      },
      /Quota de sécurité décompression dépassé/
    );
  });
});
