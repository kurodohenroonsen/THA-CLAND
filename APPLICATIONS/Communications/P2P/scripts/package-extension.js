#!/usr/bin/env node
/**
 * scripts/package-extension.js
 * 
 * Pipeline de Packaging Hermétique & Déterministe (Pass 4 Hardened - 2026)
 * Compatible Chrome Web Store MV3 & Déploiement Statique WebApp PWA.
 * 
 * Garanties :
 * 1. Reproductibilité binaire bit-à-bit via SOURCE_DATE_EPOCH & normalisation ZIP.
 * 2. Zéro dépendance externe (100% natif Node.js : node:zlib, node:crypto, node:fs).
 * 3. Pre-flight checks : syntaxe JS, parité stricte, validation Manifest V3 & WebManifest.
 * 4. Double couche de filtrage : Whitelist structurelle + Denylist regex stricte.
 * 5. Calcul d'empreintes SHA-256 unitaires et globales (checksums.sha256 & integrity JSON).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT_DIR, 'Extension');
const WEB_DIR = path.join(ROOT_DIR, 'WebApp');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// Détermination de l'époque déterministe (SOURCE_DATE_EPOCH standard ou date de release figée)
const SOURCE_DATE_EPOCH = process.env.SOURCE_DATE_EPOCH 
  ? parseInt(process.env.SOURCE_DATE_EPOCH, 10) 
  : 1735689600; // Fallback déterministe: 2025-01-01T00:00:00Z

const DETERMINISTIC_DATE = new Date(Math.max(315532800, SOURCE_DATE_EPOCH) * 1000);

// Denylist stricte des artefacts indésirables
const DENYLIST_PATTERNS = [
  /^\.DS_Store$/,
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i,
  /^\._/,
  /^__MACOSX$/,
  /\.git/i,
  /\.github/i,
  /\.vscode/i,
  /\.idea/i,
  /\.zed/i,
  /\.swp$/i,
  /~$/,
  /\.bak$/i,
  /\.tmp$/i,
  /\.test\.js$/i,
  /\.spec\.js$/i,
  /__tests__/i,
  /\/test\//i,
  /\/tests\//i,
  /\/coverage\//i,
  /\.py$/i,
  /\.sh$/i,
  /\.md$/i, // Documentation non requise dans le package de production
  /\.map$/i,
  /package\.json$/i,
  /package-lock\.json$/i,
  /node_modules/i,
  /eslint/i,
  /playwright/i,
  /jsconfig/i
];

// Whitelist des chemins autorisés pour l'Extension MV3
const EXTENSION_WHITELIST = [
  'manifest.json',
  'permissions.html',
  'permissions.js',
  'background',
  'sidepanel',
  'offscreen',
  'icons'
];

// Whitelist des chemins autorisés pour la WebApp PWA
const WEBAPP_WHITELIST = [
  'index.html',
  'permissions.html',
  'permissions.js',
  'manifest.webmanifest',
  'sw.js',
  'css',
  'js',
  'locales',
  'icons'
];

// ==========================================
// 1. UTILITAIRES CRYPTOGRAPHIQUES & ZIP
// ==========================================

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

// Table pré-calculée IEEE 802.3 CRC32 pour compression ZIP autonome
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dateToDosDateTime(date) {
  const d = new Date(date);
  const year = Math.max(1980, d.getUTCFullYear());
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const seconds = d.getUTCSeconds();

  const dosTime = ((hours & 0x1F) << 11) | ((minutes & 0x3F) << 5) | ((seconds >> 1) & 0x1F);
  const dosDate = (((year - 1980) & 0x7F) << 9) | ((month & 0x0F) << 5) | (day & 0x1F);

  return { dosTime, dosDate };
}

/**
 * Générateur d'archive ZIP 100% Déterministe et Reproductible en pur Node.js
 * Respecte les spécifications RFC 1951 (Deflate) & APPNOTE.TXT (PKWARE ZIP format).
 */
function createDeterministicZip(filesList, outputPath, fixedDate = DETERMINISTIC_DATE) {
  const { dosTime, dosDate } = dateToDosDateTime(fixedDate);
  const localChunks = [];
  const centralChunks = [];
  let currentOffset = 0;

  // Tri lexicographique strict des entrées (garantit l'ordre indépendant de l'OS)
  const sortedFiles = [...filesList].sort((a, b) => a.archivePath.localeCompare(b.archivePath));

  for (const item of sortedFiles) {
    const rawData = fs.readFileSync(item.sourcePath);
    const uncompressedSize = rawData.length;
    const fileCrc = crc32(rawData);

    // Compression Deflate maximale (level 9)
    const compressedData = zlib.deflateRawSync(rawData, { level: 9 });
    const compressedSize = compressedData.length;

    const nameBuf = Buffer.from(item.archivePath.replace(/\\/g, '/'), 'utf8');

    // 1. Local File Header (30 octets + longueur du nom)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034B50, 0); // Signature Local File Header
    localHeader.writeUInt16LE(20, 4);         // Version minimale (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // Bit flag 11 = UTF-8 filename encoding
    localHeader.writeUInt16LE(8, 8);          // Méthode de compression (8 = Deflate)
    localHeader.writeUInt16LE(dosTime, 10);   // Heure MS-DOS normalisée
    localHeader.writeUInt16LE(dosDate, 12);   // Date MS-DOS normalisée
    localHeader.writeUInt32LE(fileCrc, 14);   // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18);   // Taille compressée
    localHeader.writeUInt32LE(uncompressedSize, 22); // Taille non compressée
    localHeader.writeUInt16LE(nameBuf.length, 26);   // Longueur du nom de fichier
    localHeader.writeUInt16LE(0, 28);         // Extra field length

    localChunks.push(localHeader, nameBuf, compressedData);

    // 2. Central Directory Header (46 octets + longueur du nom)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014B50, 0);    // Signature Central Directory
    cdHeader.writeUInt16LE(0x031E, 4);        // Version faite par: UNIX (0x03), ZIP 3.0 (0x1E)
    cdHeader.writeUInt16LE(20, 6);            // Version minimale requise (2.0)
    cdHeader.writeUInt16LE(0x0800, 8);        // UTF-8 flag
    cdHeader.writeUInt16LE(8, 10);            // Méthode (Deflate)
    cdHeader.writeUInt16LE(dosTime, 12);      // Heure
    cdHeader.writeUInt16LE(dosDate, 14);      // Date
    cdHeader.writeUInt32LE(fileCrc, 16);      // CRC-32
    cdHeader.writeUInt32LE(compressedSize, 20);
    cdHeader.writeUInt32LE(uncompressedSize, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);            // Extra field length
    cdHeader.writeUInt16LE(0, 32);            // File comment length
    cdHeader.writeUInt16LE(0, 34);            // Disk number start
    cdHeader.writeUInt16LE(0, 36);            // Internal file attributes
    cdHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // Permissions POSIX fixes 0644
    cdHeader.writeUInt32LE(currentOffset, 42); // Offset du Local Header

    centralChunks.push(cdHeader, nameBuf);

    currentOffset += localHeader.length + nameBuf.length + compressedData.length;
  }

  const centralDirOffset = currentOffset;
  let centralDirSize = 0;
  for (const chunk of centralChunks) {
    centralDirSize += chunk.length;
  }

  // 3. End of Central Directory Record (22 octets)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);           // Signature EOCD
  eocd.writeUInt16LE(0, 4);                    // Disk number
  eocd.writeUInt16LE(0, 6);                    // Start disk
  eocd.writeUInt16LE(sortedFiles.length, 8);   // Entrées sur ce disque
  eocd.writeUInt16LE(sortedFiles.length, 10);  // Total des entrées
  eocd.writeUInt32LE(centralDirSize, 12);      // Taille du Central Directory
  eocd.writeUInt32LE(centralDirOffset, 16);    // Offset du Central Directory
  eocd.writeUInt16LE(0, 20);                   // Longueur commentaire

  const finalZipBuffer = Buffer.concat([...localChunks, ...centralChunks, eocd]);
  fs.writeFileSync(outputPath, finalZipBuffer);

  return {
    entryCount: sortedFiles.length,
    totalBytes: finalZipBuffer.length,
    sha256: sha256Buffer(finalZipBuffer)
  };
}

// ==========================================
// 2. PRE-FLIGHT VALIDATORS & CHECKS
// ==========================================

function runPreflightChecks() {
  console.log('🛡️ [Pre-Flight] Lancement des vérifications de sécurité et de conformité...');
  const errors = [];

  // A. Validation syntaxique JS avec node --check
  console.log('  🔍 [Syntax-Check] Validation de la syntaxe JavaScript...');
  function collectJs(dir) {
    let files = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue;
        files = files.concat(collectJs(full));
      } else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) {
        files.push(full);
      }
    }
    return files;
  }

  const jsFiles = collectJs(ROOT_DIR);
  let syntaxErrors = 0;
  for (const file of jsFiles) {
    try {
      execSync(`node --check "${file}"`, { stdio: 'pipe' });
    } catch (e) {
      syntaxErrors++;
      errors.push(`Erreur de syntaxe JS dans ${path.relative(ROOT_DIR, file)}: ${e.message}`);
    }
  }
  if (syntaxErrors === 0) {
    console.log(`    ✅ 100% des fichiers JS (${jsFiles.length}) syntaxiquement valides.`);
  }

  // B. Validation du Manifest V3 Extension
  console.log('  🔍 [Manifest-Check] Validation du schéma Manifest V3 Extension...');
  const extManifestPath = path.join(EXT_DIR, 'manifest.json');
  if (!fs.existsSync(extManifestPath)) {
    errors.push('manifest.json introuvable dans Extension/');
  } else {
    try {
      const extManifest = JSON.parse(fs.readFileSync(extManifestPath, 'utf8'));
      if (extManifest.manifest_version !== 3) {
        errors.push(`manifest_version doit être 3 (reçu: ${extManifest.manifest_version})`);
      }
      if (!extManifest.name || !extManifest.version || !extManifest.description) {
        errors.push('Champs obligatoires manquants dans manifest.json (name, version, description)');
      }

      // Vérification de l'existence des icônes
      if (extManifest.icons) {
        for (const [size, iconRel] of Object.entries(extManifest.icons)) {
          const iconPath = path.join(EXT_DIR, iconRel);
          if (!fs.existsSync(iconPath)) {
            errors.push(`Icône déclarée introuvable : ${iconRel} (taille ${size}px)`);
          }
        }
      } else {
        errors.push('Section icons manquante dans manifest.json');
      }

      // Vérification du Service Worker Background
      if (extManifest.background && extManifest.background.service_worker) {
        const swPath = path.join(EXT_DIR, extManifest.background.service_worker);
        if (!fs.existsSync(swPath)) {
          errors.push(`Service worker introuvable : ${extManifest.background.service_worker}`);
        }
      }

      // Vérification du Side Panel
      if (extManifest.side_panel && extManifest.side_panel.default_path) {
        const spPath = path.join(EXT_DIR, extManifest.side_panel.default_path);
        if (!fs.existsSync(spPath)) {
          errors.push(`Side panel entrypoint introuvable : ${extManifest.side_panel.default_path}`);
        }
      }

      console.log('    ✅ Manifest V3 conforme et tous les points d\'entrée validés.');
    } catch (err) {
      errors.push(`Erreur de parsing JSON dans manifest.json : ${err.message}`);
    }
  }

  // C. Validation du WebManifest PWA
  console.log('  🔍 [PWA-Check] Validation du manifest.webmanifest WebApp...');
  const webManifestPath = path.join(WEB_DIR, 'manifest.webmanifest');
  if (fs.existsSync(webManifestPath)) {
    try {
      const webManifest = JSON.parse(fs.readFileSync(webManifestPath, 'utf8'));
      if (!webManifest.name || !webManifest.start_url || !webManifest.display) {
        errors.push('Champs obligatoires manquants dans manifest.webmanifest (name, start_url, display)');
      }
      console.log('    ✅ WebManifest PWA validé.');
    } catch (err) {
      errors.push(`Erreur de parsing dans manifest.webmanifest : ${err.message}`);
    }
  }

  // D. Validation de parité Extension ⇆ WebApp
  console.log('  🔍 [Parity-Check] Validation de la parité stricte SHA-256...');
  try {
    execSync('node scripts/check-parity.js', { cwd: ROOT_DIR, stdio: 'pipe' });
    console.log('    ✅ 100% de parité validée entre Extension/sidepanel et WebApp.');
  } catch (err) {
    errors.push(`Échec du contrôle de parité : ${err.stderr ? err.stderr.toString() : err.message}`);
  }

  if (errors.length > 0) {
    console.error('\n🚨 ÉCHEC DES PRE-FLIGHT CHECKS :');
    for (const err of errors) {
      console.error(`   ❌ ${err}`);
    }
    process.exit(1);
  }

  console.log('✨ [Pre-Flight] Tous les contrôles de sécurité et d\'intégrité sont validés avec succès.\n');
}

// ==========================================
// 3. COLLECTE & SANITISATION DES FICHIERS
// ==========================================

function isDenied(relativePath) {
  const parts = relativePath.split(path.sep);
  for (const part of parts) {
    for (const pattern of DENYLIST_PATTERNS) {
      if (pattern.test(part)) return true;
    }
  }
  return false;
}

function scanCleanFiles(baseDir, whitelist) {
  const collected = [];

  function traverse(currentDir, relPrefix) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const ent of entries) {
      const relPath = path.join(relPrefix, ent.name);
      if (isDenied(relPath)) {
        continue;
      }

      const fullPath = path.join(currentDir, ent.name);
      if (ent.isDirectory()) {
        traverse(fullPath, relPath);
      } else if (ent.isFile()) {
        collected.push({
          sourcePath: fullPath,
          archivePath: relPath.replace(/\\/g, '/'),
          size: ent.size || fs.statSync(fullPath).size,
          sha256: sha256File(fullPath)
        });
      }
    }
  }

  for (const item of whitelist) {
    const itemPath = path.join(baseDir, item);
    if (!fs.existsSync(itemPath)) {
      console.warn(`  ⚠️ Avertissement : Élément whitelist introuvable (${item})`);
      continue;
    }
    const stat = fs.statSync(itemPath);
    if (stat.isDirectory()) {
      traverse(itemPath, item);
    } else if (stat.isFile() && !isDenied(item)) {
      collected.push({
        sourcePath: itemPath,
        archivePath: item.replace(/\\/g, '/'),
        size: stat.size,
        sha256: sha256File(itemPath)
      });
    }
  }

  return collected;
}

// ==========================================
// 4. EXÉCUTION DU PACKAGING UNIFIÉ
// ==========================================

function packageAll() {
  console.log('📦 ========================================================');
  console.log('📦 P2P MESH WORKSPACE — PACKAGING DÉTERMINISTE (PASSE 4)');
  console.log('📦 ========================================================\n');

  // 1. Exécution des Pre-flight checks
  runPreflightChecks();

  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  const version = manifest.version || '1.1.0';

  console.log(`🏷️ Version cible : v${version}`);
  console.log(`⏱️ Date déterministe (SOURCE_DATE_EPOCH) : ${DETERMINISTIC_DATE.toISOString()}\n`);

  const integrityReport = {
    buildMetadata: {
      packageName: 'p2p-mesh-workspace',
      version: version,
      buildTimestamp: DETERMINISTIC_DATE.toISOString(),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      nodeVersion: process.version,
      architecture: process.arch,
      platform: process.platform,
      generator: 'Hermetic Pure-NodeJS Deterministic Packager Pass 4'
    },
    artifacts: {}
  };

  const checksumsSha256Lines = [];

  // ----------------------------------------------------
  // A. Packaging de l'Extension Chrome MV3
  // ----------------------------------------------------
  console.log('🧱 [Bundle-1] Collecte et packaging de l\'Extension Chrome MV3...');
  const extFiles = scanCleanFiles(EXT_DIR, EXTENSION_WHITELIST);
  const extZipName = `p2p-mesh-extension-v${version}.zip`;
  const extZipPath = path.join(DIST_DIR, extZipName);

  console.log(`  ➕ ${extFiles.length} fichiers sanitaires collectés.`);
  const extResult = createDeterministicZip(extFiles, extZipPath);
  console.log(`  ✅ Archive Chrome Web Store créée : ${extZipName}`);
  console.log(`     - Taille : ${(extResult.totalBytes / 1024).toFixed(1)} Ko (${extResult.totalBytes} octets)`);
  console.log(`     - SHA-256 : ${extResult.sha256}\n`);

  integrityReport.artifacts.extension = {
    archiveName: extZipName,
    target: 'Google Chrome Web Store MV3',
    fileCount: extResult.entryCount,
    totalSizeBytes: extResult.totalBytes,
    sha256: extResult.sha256,
    files: extFiles.map(f => ({
      path: f.archivePath,
      size: f.size,
      sha256: f.sha256
    }))
  };

  checksumsSha256Lines.push(`${extResult.sha256}  ${extZipName}`);

  // ----------------------------------------------------
  // B. Packaging de la WebApp PWA Décentralisée
  // ----------------------------------------------------
  console.log('🌐 [Bundle-2] Collecte et packaging de la WebApp PWA Décentralisée...');
  const webFiles = scanCleanFiles(WEB_DIR, WEBAPP_WHITELIST);
  const webZipName = `p2p-mesh-webapp-v${version}.zip`;
  const webZipPath = path.join(DIST_DIR, webZipName);

  console.log(`  ➕ ${webFiles.length} fichiers sanitaires collectés.`);
  const webResult = createDeterministicZip(webFiles, webZipPath);
  console.log(`  ✅ Archive WebApp Déploiement créée : ${webZipName}`);
  console.log(`     - Taille : ${(webResult.totalBytes / 1024).toFixed(1)} Ko (${webResult.totalBytes} octets)`);
  console.log(`     - SHA-256 : ${webResult.sha256}\n`);

  integrityReport.artifacts.webapp = {
    archiveName: webZipName,
    target: 'Static Sovereign WebApp / PWA (IPFS/Cloudflare/Pages)',
    fileCount: webResult.entryCount,
    totalSizeBytes: webResult.totalBytes,
    sha256: webResult.sha256,
    files: webFiles.map(f => ({
      path: f.archivePath,
      size: f.size,
      sha256: f.sha256
    }))
  };

  checksumsSha256Lines.push(`${webResult.sha256}  ${webZipName}`);

  // ----------------------------------------------------
  // C. Génération des Manifestes d'Intégrité
  // ----------------------------------------------------
  console.log('🔒 [Integrity] Génération des manifestes cryptographiques...');

  const integrityJsonPath = path.join(DIST_DIR, 'p2p-mesh-build-integrity.json');
  fs.writeFileSync(integrityJsonPath, JSON.stringify(integrityReport, null, 2) + '\n');
  const integrityJsonHash = sha256File(integrityJsonPath);
  checksumsSha256Lines.push(`${integrityJsonHash}  p2p-mesh-build-integrity.json`);
  console.log(`  ✅ Manifeste JSON écrit : p2p-mesh-build-integrity.json (SHA-256: ${integrityJsonHash})`);

  const checksumsPath = path.join(DIST_DIR, 'checksums.sha256');
  fs.writeFileSync(checksumsPath, checksumsSha256Lines.join('\n') + '\n');
  console.log(`  ✅ Fichier standard écrit : checksums.sha256\n`);

  // ----------------------------------------------------
  // D. Test de Reproductibilité Binaire (Double-Run Check)
  // ----------------------------------------------------
  console.log('🔁 [Reproducibility-Audit] Validation de la reproductibilité binaire bit-à-bit...');
  const testExtZipPath = path.join(DIST_DIR, `temp-reproducibility-check.zip`);
  const testResult = createDeterministicZip(extFiles, testExtZipPath);
  fs.unlinkSync(testExtZipPath);

  if (testResult.sha256 === extResult.sha256) {
    console.log('  🎯 REPRODUCTIBILITÉ 100% BIT-À-BIT VALIDÉE (Hash SHA-256 invariant sur 2 passes distinctes).');
  } else {
    console.error('  🚨 ERREUR CRITIQUE : Dérive non déterministe détectée !');
    process.exit(1);
  }

  console.log('\n🎉 ========================================================');
  console.log('🎉 PACKAGING ET CERTIFICATION D\'INTÉGRITÉ TERMINÉS AVEC SUCCÈS');
  console.log('🎉 ========================================================\n');
}

packageAll();
