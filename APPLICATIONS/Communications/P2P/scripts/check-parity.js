#!/usr/bin/env node
/**
 * scripts/check-parity.js
 * Vérificateur de parité stricte SHA-256 entre Extension/sidepanel/ et WebApp/
 * Intègre HTML, CSS, JS, Permissions et Locales i18n.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_DIR = path.resolve(__dirname, '..');
const EXT_SIDE = path.join(BASE_DIR, 'Extension/sidepanel');
const EXT_ROOT = path.join(BASE_DIR, 'Extension');
const WEB_ROOT = path.join(BASE_DIR, 'WebApp');

// Définition exhaustive des cibles de parité
const PARITY_TARGETS = [
  { src: path.join(EXT_SIDE, 'index.html'), dst: path.join(WEB_ROOT, 'index.html') },
  { src: path.join(EXT_SIDE, 'css'), dst: path.join(WEB_ROOT, 'css'), isDir: true },
  { src: path.join(EXT_SIDE, 'js'), dst: path.join(WEB_ROOT, 'js'), isDir: true },
  { src: path.join(EXT_SIDE, 'locales'), dst: path.join(WEB_ROOT, 'locales'), isDir: true },
  { src: path.join(EXT_ROOT, 'permissions.html'), dst: path.join(WEB_ROOT, 'permissions.html') },
  { src: path.join(EXT_ROOT, 'permissions.js'), dst: path.join(WEB_ROOT, 'permissions.js') },
];

function sha256(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getFilesRecursively(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === '.DS_Store' || file.startsWith('._')) continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getFilesRecursively(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

console.log('🔍 [Parity-Engine] Vérification de la parité stricte Extension ⇆ WebApp...');
let violations = 0;
let verifiedCount = 0;

for (const target of PARITY_TARGETS) {
  if (!fs.existsSync(target.src)) {
    console.error(`❌ [Manquant] Source introuvable : ${target.src}`);
    violations++;
    continue;
  }
  if (!fs.existsSync(target.dst)) {
    console.error(`❌ [Manquant] Destination introuvable : ${target.dst}`);
    violations++;
    continue;
  }

  if (target.isDir) {
    const srcFiles = getFilesRecursively(target.src);
    for (const srcFile of srcFiles) {
      const relPath = path.relative(target.src, srcFile);
      const dstFile = path.join(target.dst, relPath);

      if (!fs.existsSync(dstFile)) {
        console.error(`❌ [Divergence] Fichier absent dans WebApp : ${relPath}`);
        violations++;
        continue;
      }

      const hSrc = sha256(srcFile);
      const hDst = sha256(dstFile);

      if (hSrc !== hDst) {
        console.error(`❌ [Mismatch SHA-256] Dérive détectée sur : ${relPath}`);
        console.error(`   - Extension: ${hSrc}`);
        console.error(`   - WebApp   : ${hDst}`);
        violations++;
      } else {
        verifiedCount++;
      }
    }
  } else {
    const hSrc = sha256(target.src);
    const hDst = sha256(target.dst);
    if (hSrc !== hDst) {
      console.error(`❌ [Mismatch SHA-256] Fichier divergent : ${path.basename(target.src)}`);
      violations++;
    } else {
      verifiedCount++;
    }
  }
}

if (violations > 0) {
  console.error(`\n🚨 ÉCHEC : ${violations} violation(s) de parité détectée(s) ! Bloquant pour la CI.`);
  process.exit(1);
} else {
  console.log(`\n✅ SUCCÈS : 100% de parité validée (${verifiedCount} fichiers vérifiés avec succès).`);
  process.exit(0);
}
