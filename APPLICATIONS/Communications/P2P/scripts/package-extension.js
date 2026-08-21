#!/usr/bin/env node
/**
 * scripts/package-extension.js
 * Empaqueteur hermétique pour Chrome Web Store MV3
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const P2P_DIR = path.resolve(__dirname, '..');
const EXT_DIR = path.join(P2P_DIR, 'Extension');
const DIST_DIR = path.join(P2P_DIR, 'dist');
const STAGING_DIR = path.join(DIST_DIR, 'extension-staging');

// Whitelist stricte des fichiers autorisés pour le Chrome Web Store
const WHITELIST = [
  'manifest.json',
  'permissions.html',
  'permissions.js',
  'background',
  'sidepanel',
  'offscreen',
  'icons'
];

console.log('📦 [Packager] Démarrage de l\'empaquetage hermétique Chrome MV3...');

// 1. Lire la version dans le manifest.json
const manifestPath = path.join(EXT_DIR, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version || '1.0.0';
const zipName = `p2p-mesh-extension-v${version}.zip`;
const zipPath = path.join(DIST_DIR, zipName);

// 2. Préparer les répertoires de staging et dist
if (fs.existsSync(STAGING_DIR)) fs.rmSync(STAGING_DIR, { recursive: true, force: true });
if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
fs.mkdirSync(STAGING_DIR, { recursive: true });

// 3. Copie sélective selon la Whitelist
function copyClean(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      if (entry === '.DS_Store' || entry.endsWith('.py') || entry.endsWith('.md')) continue;
      copyClean(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

for (const entry of WHITELIST) {
  const srcEntry = path.join(EXT_DIR, entry);
  const dstEntry = path.join(STAGING_DIR, entry);
  if (fs.existsSync(srcEntry)) {
    copyClean(srcEntry, dstEntry);
    console.log(`  ➕ Inclus : ${entry}`);
  } else {
    console.warn(`  ⚠️ Avertissement : Élément whitelist introuvable (${entry})`);
  }
}

// 4. Création de l'archive ZIP
console.log(`🗜️ [Packager] Compression dans ${zipName}...`);
try {
  execSync(`cd "${STAGING_DIR}" && zip -r -9 "${zipPath}" . -x "*.DS_Store"`, { stdio: 'pipe' });
  const stat = fs.statSync(zipPath);
  console.log(`✅ [Packager] Extension empaquetée avec succès : ${zipPath} (${(stat.size / 1024).toFixed(1)} Ko)`);
} catch (err) {
  console.error('❌ Erreur lors de la compression ZIP :', err.message);
  process.exit(1);
} finally {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
}
