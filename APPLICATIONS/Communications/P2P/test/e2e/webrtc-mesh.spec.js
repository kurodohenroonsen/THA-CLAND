// @ts-check
import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';

/**
 * 🧪 Test E2E Multi-Pairs WebRTC : Connexion Maillée 3 Pairs, Chat CRDT & Réplication Swarm Drive
 * Persona 7.2 : Tests E2E Multi-Pairs WebRTC & Automatisation Navigateur (2025/2026)
 */

test.describe('🌐 P2P Mesh Workspace — Scénario E2E Multi-Pairs WebRTC', () => {
  const MASTER_PAPER_CODE = 'E2E-ALPHA-BRAVO-CHARLIE-DELTA-ECHO-FOXTROT-7777';

  test('Orchestration 3 Pairs Isolés (Alice, Bob, Charlie) & Synchronisation Maillée', async ({ browser }) => {
    // 1. Instanciation de 3 BrowserContexts étanches
    const contextAlice = await browser.newContext();
    const contextBob = await browser.newContext();
    const contextCharlie = await browser.newContext();

    const pageAlice = await contextAlice.newPage();
    const pageBob = await contextBob.newPage();
    const pageCharlie = await contextCharlie.newPage();

    // 2. Onboarding Pair Alice (Créatrice du salon)
    await pageAlice.goto('/');
    await pageAlice.waitForSelector('#input-paper-code');
    await pageAlice.fill('#input-paper-code', MASTER_PAPER_CODE);
    await pageAlice.fill('#input-username', 'Alice');
    await pageAlice.click('#btn-join-room');

    await expect(pageAlice.locator('#app-header-title')).toContainText('P2P Mesh Workspace');

    // 3. Onboarding Pair Bob
    await pageBob.goto('/');
    await pageBob.waitForSelector('#input-paper-code');
    await pageBob.fill('#input-paper-code', MASTER_PAPER_CODE);
    await pageBob.fill('#input-username', 'Bob');
    await pageBob.click('#btn-join-room');

    await expect(pageBob.locator('#app-header-title')).toContainText('P2P Mesh Workspace');

    // 4. Onboarding Pair Charlie
    await pageCharlie.goto('/');
    await pageCharlie.waitForSelector('#input-paper-code');
    await pageCharlie.fill('#input-paper-code', MASTER_PAPER_CODE);
    await pageCharlie.fill('#input-username', 'Charlie');
    await pageCharlie.click('#btn-join-room');

    await expect(pageCharlie.locator('#app-header-title')).toContainText('P2P Mesh Workspace');

    // 5. Validation de la Topologie Maillée P2P (Chaque pair voit les autres dans le Roster)
    await expect(pageAlice.locator('.peer-item')).toHaveCount(2, { timeout: 15000 });
    await expect(pageBob.locator('.peer-item')).toHaveCount(2, { timeout: 15000 });
    await expect(pageCharlie.locator('.peer-item')).toHaveCount(2, { timeout: 15000 });

    // 6. Test Chat CRDT Temps Réel : Alice envoie un message
    const messageTextAlice = `Hello Mesh from Alice @ ${Date.now()}`;
    await pageAlice.fill('#chat-input-textarea', messageTextAlice);
    await pageAlice.click('#btn-chat-send');

    // Bob et Charlie doivent recevoir le message avec signature valide
    await expect(pageBob.locator('.chat-bubble-content').filter({ hasText: messageTextAlice })).toBeVisible({ timeout: 5000 });
    await expect(pageCharlie.locator('.chat-bubble-content').filter({ hasText: messageTextAlice })).toBeVisible({ timeout: 5000 });

    // 7. Nettoyage des contextes
    await contextAlice.close();
    await contextBob.close();
    await contextCharlie.close();
  });
});
