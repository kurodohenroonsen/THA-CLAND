#!/usr/bin/env node
/**
 * scripts/check-syntax.js
 * Vérification syntaxique stricte 'node --check' sur tous les fichiers ESM
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const P2P_DIR = path.resolve(__dirname, '..');

function getJsFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === 'node_modules' || file === '.git' || file === 'dist') continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getJsFiles(fullPath));
    } else if (file.endsWith('.js') || file.endsWith('.mjs')) {
      results.push(fullPath);
    }
  }
  return results;
}

const jsFiles = getJsFiles(P2P_DIR);
console.log(`🔍 [Syntax-Check] Validation de ${jsFiles.length} fichiers JavaScript avec node --check...`);

let errors = 0;
for (const file of jsFiles) {
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe' });
  } catch (err) {
    console.error(`❌ Erreur de syntaxe dans : ${path.relative(P2P_DIR, file)}`);
    console.error(err.stderr ? err.stderr.toString() : err.message);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n🚨 ÉCHEC : ${errors} fichier(s) JavaScript contiennent des erreurs de syntaxe.`);
  process.exit(1);
} else {
  console.log(`\n✅ SUCCÈS : 100% des fichiers JavaScript (${jsFiles.length}) sont syntaxiquement valides.`);
  process.exit(0);
}
