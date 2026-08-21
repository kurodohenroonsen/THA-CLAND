import { logger } from '../../core/logger.js';
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
    logger.debug('Auth', '🖥️ Initialisation de l\'interface d\'authentification...');
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
        logger.debug('Auth', '🖱️ Clic sur "Générer un Nouveau Groupe"');
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
        try { await navigator.clipboard.writeText(code); } catch (err) { logger.warn('Auth', 'Presse-papier non accessible:', err); }
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

        logger.info('Auth', `🖱️ Clic sur "Rejoindre le Groupe" (Nom: "${name}")`);

        if (!code) {
          logger.warn('Auth', '⚠️ Tentative de connexion sans code papier.');
          Toast.error('Veuillez renseigner votre code papier.');
          return;
        }

        try {
          btnJoin.disabled = true;
          btnJoin.innerHTML = '<span class="spinner"></span> Dérivation cryptographique...';

          // Dérivation PBKDF2 / HKDF des clés E2EE locales
          logger.debug('Auth', '⏳ Appel de CryptoVault.initializeFromPaperCode...');
          await this.vault.initializeFromPaperCode(code, name || 'Membre P2P');

          // Nettoyage de sécurité : ne JAMAIS persister le code papier en clair dans IndexedDB
          await dbManager.delete('settings', 'last_paper_code').catch(() => {});
          await dbManager.saveSetting('user_name', name || 'Membre P2P');

          // Purge de l'input dans le DOM après dérivation
          if (inputCode) inputCode.value = '';

          Toast.success(`Bienvenue ${name} ! Connexion au maillage P2P...`);
          
          if (this.onAuthenticated) {
            logger.info('Auth', '🚀 Déclenchement du callback onAuthenticated !');
            this.onAuthenticated(this.vault);
          }
        } catch (err) {
          logger.error('Auth', '❌ Erreur critique lors de l\'authentification:', err);
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

    const { bits, label, cls, pct } = CryptoVault.calculateEntropy(code);

    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    fill.className = `entropy-meter-fill ${cls}`;
    text.textContent = label;
    if (bitsEl) bitsEl.textContent = code ? `≈ ${bits} bits` : '';
  }

  /**
   * Restaure uniquement le pseudonyme sauvegardé (Zero-Trace pour le code maître)
   */
  async checkSavedSession() {
    const savedName = await dbManager.getSetting('user_name', 'Membre P2P');
    const inputName = document.getElementById('input-user-name');
    if (inputName && savedName) {
      inputName.value = savedName;
    }
  }
}
