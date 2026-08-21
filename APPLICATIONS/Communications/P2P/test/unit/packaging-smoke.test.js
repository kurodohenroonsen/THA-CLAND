/**
 * test/unit/packaging-smoke.test.js
 * Tests de Fumée (Smoke Tests) & Validation d'Intégrité du Packaging (Pass 4 Hardened - 2026)
 * Persona G8.P9 : Simulateur Installation & Packaging
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

describe('📦 Groupe 8 - Tests Smoke & Intégrité Packaging MV3 / PWA', () => {

  it('Manifest Chrome MV3 : Est syntaxiquement valide et respecte les contraintes 2026', () => {
    const manifestPath = path.join(ROOT_DIR, 'Extension', 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json doit exister dans Extension/');

    const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(content.manifest_version, 3, 'Doit être Manifest Version 3');
    assert.ok(content.name, 'Doit avoir un nom');
    assert.ok(content.version, 'Doit avoir une version sémantique');
    assert.ok(content.side_panel?.default_path, 'Doit déclarer un side_panel.default_path');
    assert.ok(content.background?.service_worker, 'Doit déclarer un background.service_worker');
    assert.ok(content.content_security_policy?.extension_pages, 'Doit déclarer une CSP stricte');

    // Vérifier les icônes requises
    for (const size of ['16', '32', '48', '128']) {
      const iconRelPath = content.icons?.[size];
      assert.ok(iconRelPath, `Icône taille ${size} manquante dans manifest.json`);
      const iconFullPath = path.join(ROOT_DIR, 'Extension', iconRelPath);
      assert.ok(fs.existsSync(iconFullPath), `Fichier icône introuvable : ${iconRelPath}`);
    }
  });

  it('Manifest PWA WebApp : Est valide et configuré pour le mode Standalone / Window Controls Overlay', () => {
    const manifestPath = path.join(ROOT_DIR, 'WebApp', 'manifest.webmanifest');
    assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest doit exister dans WebApp/');

    const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(content.name, 'Doit avoir un nom');
    assert.strictEqual(content.display, 'standalone');
    assert.ok(Array.isArray(content.icons), 'Doit avoir une liste d\'icônes');
    assert.ok(content.icons.length >= 4, 'Doit fournir au minimum 4 déclinaisons d\'icônes');
  });

  it('Service Worker PWA : Déclare tous les assets de pré-cache de la Passe 4 sans fichier fantôme', () => {
    const swPath = path.join(ROOT_DIR, 'WebApp', 'sw.js');
    assert.ok(fs.existsSync(swPath), 'sw.js doit exister');

    const swContent = fs.readFileSync(swPath, 'utf8');
    assert.ok(swContent.includes("CACHE_VERSION = 'v7'"), 'Doit être en version v7');

    const match = swContent.match(/const PRECACHE_ASSETS = \[(.*?)\];/s);
    assert.ok(match, 'PRECACHE_ASSETS doit être défini');

    // Extraire les chemins de fichiers et vérifier leur existence sur le disque
    const rawList = match[1];
    const assetPaths = rawList
      .split('\n')
      .map(line => line.trim().replace(/^['"]|['"],?$/g, ''))
      .filter(line => line.startsWith('./') && line.length > 2 && !line.endsWith('/'));

    assert.ok(assetPaths.length >= 40, `Nombre d'assets pré-cachés attendu >= 40 (trouvé: ${assetPaths.length})`);

    for (const relPath of assetPaths) {
      const fullPath = path.join(ROOT_DIR, 'WebApp', relPath.replace(/^\.\//, ''));
      assert.ok(fs.existsSync(fullPath), `Asset pré-caché introuvable sur le disque : ${relPath} (${fullPath})`);
    }
  });

  it('CI/CD Pipeline : Le fichier .github/workflows/ci.yml est valide et couvre l\'ensemble des étapes', () => {
    const ciPath = path.join(ROOT_DIR, '.github', 'workflows', 'ci.yml');
    assert.ok(fs.existsSync(ciPath), 'Le workflow CI doit exister');

    const ciContent = fs.readFileSync(ciPath, 'utf8');
    assert.ok(ciContent.includes('check-syntax.js') || ciContent.includes('npm run syntax'), 'Doit inclure syntax');
    assert.ok(ciContent.includes('check-parity.js') || ciContent.includes('npm run parity'), 'Doit inclure parity');
    assert.ok(ciContent.includes('node --test') || ciContent.includes('npm run test') || ciContent.includes('npm test'), 'Doit inclure test');
    assert.ok(ciContent.includes('crdt-convergence') || ciContent.includes('npm run test:fuzz'), 'Doit inclure fuzz');
    assert.ok(ciContent.includes('perf-benchmarks') || ciContent.includes('npm run test:bench'), 'Doit inclure bench');
    assert.ok(ciContent.includes('package-extension.js') || ciContent.includes('npm run package'), 'Doit inclure package');
  });

});
