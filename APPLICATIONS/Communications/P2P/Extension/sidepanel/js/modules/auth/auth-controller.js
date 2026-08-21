/**
 * Contrôleur d'Authentification & Onboarding Code Papier
 * Gestion de la saisie, de la génération de codes maîtres et de l'initialisation du coffre.
 */

import { CryptoVault } from '../../core/crypto-vault.js';
import { dbManager } from '../../core/local-storage.js';
import { Toast } from '../../ui/toast.js';

export class AuthController {
  constructor(cryptoVault, onAuthenticated) {
    this.vault = cryptoVault;
    this.onAuthenticated = onAuthenticated;
    this.initUI();
  }

  initUI() {
    console.log('[Auth] 🖥️ Initialisation de l\'interface d\'authentification...');
    const btnGenerate = document.getElementById('btn-generate-code');
    const btnJoin = document.getElementById('btn-join-group');
    const inputCode = document.getElementById('input-paper-code');
    const inputName = document.getElementById('input-user-name');
    const btnCopyCode = document.getElementById('btn-copy-generated-code');
    const generatedBox = document.getElementById('generated-code-box');
    const displayCode = document.getElementById('display-generated-code');
    const btnReveal = document.getElementById('btn-reveal-code');

    // Jauge d'entropie en temps réel
    const updateEntropy = () => this.updateEntropyMeter(inputCode ? inputCode.value : '');
    if (inputCode) inputCode.addEventListener('input', updateEntropy);

    // Bascule afficher / masquer le code
    if (btnReveal && inputCode) {
      btnReveal.addEventListener('click', () => {
        const reveal = inputCode.type === 'password';
        inputCode.type = reveal ? 'text' : 'password';
        btnReveal.textContent = reveal ? '🙈' : '👁️';
      });
    }

    // 1. Bouton Générer un Nouveau Groupe
    if (btnGenerate) {
      btnGenerate.addEventListener('click', () => {
        console.log('[Auth] 🖱️ Clic sur "Générer un Nouveau Groupe"');
        const newCode = CryptoVault.generatePaperCode();
        if (inputCode) { inputCode.value = newCode; inputCode.type = 'text'; }
        if (btnReveal) btnReveal.textContent = '🙈';
        if (displayCode) displayCode.textContent = newCode;
        if (generatedBox) generatedBox.classList.remove('hidden');
        updateEntropy();
        Toast.success('Nouveau code de groupe généré !');
      });
    }

    // 2. Bouton Copier le code généré (avec retour visuel)
    if (btnCopyCode) {
      btnCopyCode.addEventListener('click', async () => {
        const code = displayCode.textContent;
        if (!code) return;
        try { await navigator.clipboard.writeText(code); } catch {}
        const original = btnCopyCode.textContent;
        btnCopyCode.textContent = '✓ Copié !';
        btnCopyCode.classList.add('copied-flash');
        setTimeout(() => { btnCopyCode.textContent = original; btnCopyCode.classList.remove('copied-flash'); }, 1600);
      });
    }

    // 3. Bouton Rejoindre le groupe
    if (btnJoin) {
      btnJoin.addEventListener('click', async () => {
        const code = inputCode ? inputCode.value.trim() : '';
        const name = inputName ? inputName.value.trim() : 'Membre P2P';

        console.log(`[Auth] 🖱️ Clic sur "Rejoindre le Groupe" avec Code: "${code}", Nom: "${name}"`);

        if (!code) {
          console.warn('[Auth] ⚠️ Tentative de connexion sans code papier.');
          Toast.error('Veuillez renseigner votre code papier.');
          return;
        }

        try {
          btnJoin.disabled = true;
          btnJoin.innerHTML = '<span class="spinner"></span> Dérivation cryptographique...';

          // Dérivation PBKDF2 / HKDF des clés E2EE locales
          console.log('[Auth] ⏳ Appel de CryptoVault.initializeFromPaperCode...');
          await this.vault.initializeFromPaperCode(code, name || 'Membre P2P');

          // Sauvegarde de la session locale
          console.log('[Auth] 💾 Enregistrement de la session dans IndexedDB...');
          await dbManager.saveSetting('last_paper_code', code);
          await dbManager.saveSetting('user_name', name || 'Membre P2P');

          Toast.success(`Bienvenue ${name} ! Connexion au maillage P2P...`);
          
          if (this.onAuthenticated) {
            console.log('[Auth] 🚀 Déclenchement du callback onAuthenticated !');
            this.onAuthenticated(this.vault);
          }
        } catch (err) {
          console.error('[Auth] ❌ Erreur critique lors de l\'authentification:', err);
          Toast.error(`Erreur d'initialisation : ${err.message}`);
          btnJoin.disabled = false;
          btnJoin.innerHTML = 'Rejoindre le Groupe';
        }
      });
    }
  }

  /**
   * Met à jour la jauge d'entropie du code papier.
   */
  updateEntropyMeter(code) {
    const fill = document.getElementById('entropy-fill');
    const text = document.getElementById('entropy-text');
    const bitsEl = document.getElementById('entropy-bits');
    if (!fill || !text) return;

    const bits = CryptoVault.estimatePaperCodeEntropyBits(code || '');
    // Barème adapté au schéma (PBKDF2 100k SHA-512 ajoute ~17 bits de facteur de
    // travail) : < 40 faible, 40–59 moyenne, ≥ 60 forte. Un code généré par
    // défaut (~61 bits) est ainsi correctement classé « fort ».
    let pct, cls, label;
    if (!code) { pct = 0; cls = ''; label = 'Saisissez ou générez un code'; }
    else if (bits < 40) { pct = Math.min(38, bits); cls = 'e-weak'; label = 'Robustesse faible'; }
    else if (bits < 60) { pct = 40 + (bits - 40) * 1.5; cls = 'e-medium'; label = 'Robustesse moyenne'; }
    else { pct = Math.min(100, 70 + (bits - 60) * 0.5); cls = 'e-strong'; label = 'Robustesse forte'; }

    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    fill.className = `entropy-meter-fill ${cls}`;
    text.textContent = label;
    if (bitsEl) bitsEl.textContent = code ? `≈ ${bits} bits` : '';
  }

  /**
   * Vérifie si une session précédente existe pour reconnexion automatique
   */
  async checkSavedSession() {
    console.log('[Auth] 🔍 Recherche d\'une session précédente enregistrée...');
    const savedCode = await dbManager.getSetting('last_paper_code');
    const savedName = await dbManager.getSetting('user_name', 'Membre P2P');

    if (savedCode) {
      console.log('[Auth] 🔄 Session précédente retrouvée:', savedCode, savedName);
      const inputCode = document.getElementById('input-paper-code');
      const inputName = document.getElementById('input-user-name');
      if (inputCode) inputCode.value = savedCode;
      if (inputName) inputName.value = savedName;
      this.updateEntropyMeter(savedCode);
    } else {
      console.log('[Auth] ℹ️ Aucune session précédente trouvée.');
    }
  }
}
