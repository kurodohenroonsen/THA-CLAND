/**
 * Service Universel des États Vides & Onboarding Progressif P2P (2025/2026)
 * Génération de composants accessibles avec SVG inline et câblage réactif d'actions.
 */

import { Toast } from './toast.js';
import { Modal } from './modal.js';
import { ZeroTraceClipboard } from '../core/os-interop.js';

export const EmptyStateService = {

  // ================= 1. CHAT (MESSAGERIE INSTANTANÉE) =================
  renderChatEmptyState(channelName, onPromptClick, onAttachClick, vault) {
    const el = document.createElement('div');
    el.className = 'p2p-empty-state-wrapper empty-chat-state';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', `Espace vide du salon #${channelName}`);

    el.innerHTML = `
      <div class="empty-svg-art p2p-anim-float" aria-hidden="true">
        <svg viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="70" cy="70" r="54" stroke="url(#chat-grad-bg)" stroke-width="1.5" stroke-dasharray="4 4" class="p2p-anim-orbit"/>
          <circle cx="70" cy="70" r="38" fill="#111726" stroke="#06b6d4" stroke-width="2"/>
          <path d="M50 56C50 49.37 55.37 44 62 44H78C84.63 44 90 49.37 90 56V70C90 76.63 84.63 82 78 82H66L54 92V82H62C55.37 82 50 76.63 50 70V56Z" fill="url(#chat-bubble-grad)"/>
          <circle cx="62" cy="63" r="3.5" fill="#ffffff"/>
          <circle cx="70" cy="63" r="3.5" fill="#ffffff" opacity="0.8"/>
          <circle cx="78" cy="63" r="3.5" fill="#ffffff" opacity="0.6"/>
          <!-- Badge Cadenas E2EE P2P -->
          <g class="p2p-anim-pulse" transform="translate(82, 38)">
            <circle cx="12" cy="12" r="11" fill="#10b981" stroke="#0a0d14" stroke-width="2"/>
            <path d="M12 7C10.62 7 9.5 8.12 9.5 9.5V11H8.5C7.95 11 7.5 11.45 7.5 12V15.5C7.5 16.05 7.95 16.5 8.5 16.5H15.5C16.05 16.5 16.5 16.05 16.5 15.5V12C16.5 11.45 16.05 11 15.5 11H14.5V9.5C14.5 8.12 13.38 7 12 7ZM10.7 9.5C10.7 8.78 11.28 8.2 12 8.2C12.72 8.2 13.3 8.78 13.3 9.5V11H10.7V9.5Z" fill="#ffffff"/>
          </g>
          <defs>
            <linearGradient id="chat-grad-bg" x1="16" y1="16" x2="124" y2="124" gradientUnits="userSpaceOnUse">
              <stop stop-color="#06b6d4" stop-opacity="0.6"/>
              <stop offset="1" stop-color="#8b5cf6" stop-opacity="0.1"/>
            </linearGradient>
            <linearGradient id="chat-bubble-grad" x1="50" y1="44" x2="90" y2="92" gradientUnits="userSpaceOnUse">
              <stop stop-color="#06b6d4"/>
              <stop offset="1" stop-color="#8b5cf6"/>
            </linearGradient>
          </defs>
        </svg>
      </div>

      <div class="p2p-zero-server-badge">🔒 Chiffrement E2EE • Zéro Serveur Central</div>
      <h3 class="empty-state-heading">Bienvenue dans le salon #${channelName}</h3>
      <p class="empty-state-description">
        Les messages sont chiffrés avec vos clés Ed25519/X25519 et répliqués en direct entre pairs connectés via CRDT.
      </p>

      <div class="empty-state-actions">
        <button type="button" class="btn btn-primary empty-state-primary-btn" id="btn-empty-first-msg">
          ✍️ Envoyer le premier message
        </button>

        <div class="empty-state-chips-group">
          <button type="button" class="empty-state-chip" data-prompt="👋 Bonjour à tous ! Heureux de vous rejoindre.">
            👋 « Bonjour à tous ! »
          </button>
          <button type="button" class="empty-state-chip" id="btn-empty-chat-attach">
            📎 Joindre un média
          </button>
          <button type="button" class="empty-state-chip" id="btn-empty-copy-code">
            📋 Copier le Code Papier
          </button>
        </div>
      </div>
    `;

    el.querySelector('#btn-empty-first-msg')?.addEventListener('click', () => {
      const input = document.getElementById('chat-input-text');
      if (input) {
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    el.querySelectorAll('.empty-state-chip[data-prompt]').forEach(chip => {
      chip.addEventListener('click', () => {
        const prompt = chip.getAttribute('data-prompt');
        if (typeof onPromptClick === 'function') onPromptClick(prompt);
      });
    });

    el.querySelector('#btn-empty-chat-attach')?.addEventListener('click', () => {
      if (typeof onAttachClick === 'function') onAttachClick();
    });

    el.querySelector('#btn-empty-copy-code')?.addEventListener('click', async () => {
      if (vault?.paperCode) {
        await ZeroTraceClipboard.copySensitive(vault.paperCode, 60000);
        Toast.success('Code papier copié ! Transmettez-le de façon sécurisée.');
      } else {
        Toast.info('Consultez vos réglages ⚙️ pour copier le code papier.');
      }
    });

    return el;
  },

  // ================= 2. DRIVE (PARTAGE DE FICHIERS P2P) =================
  renderDriveEmptyState(currentPath, onUploadClick, onCreateFolderClick) {
    const el = document.createElement('div');
    el.className = 'p2p-empty-state-wrapper empty-drive-state';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', `Dossier Drive vide : ${currentPath}`);

    el.innerHTML = `
      <div class="empty-svg-art p2p-anim-float" aria-hidden="true">
        <svg viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="25" y="45" width="90" height="65" rx="10" fill="#111726" stroke="#8b5cf6" stroke-width="2"/>
          <path d="M25 55C25 49.48 29.48 45 35 45H55L65 57H105C110.52 57 115 61.48 115 67V100C115 105.52 110.52 110 105 110H35C29.48 110 25 105.52 25 100V55Z" fill="url(#drive-folder-grad)"/>
          <g class="p2p-anim-pulse">
            <rect x="58" y="28" width="24" height="24" rx="4" fill="#06b6d4" stroke="#ffffff" stroke-width="1.5"/>
            <path d="M70 34V46M64 40H76" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
          </g>
          <defs>
            <linearGradient id="drive-folder-grad" x1="25" y1="45" x2="115" y2="110" gradientUnits="userSpaceOnUse">
              <stop stop-color="#8b5cf6" stop-opacity="0.85"/>
              <stop offset="1" stop-color="#06b6d4" stop-opacity="0.95"/>
            </linearGradient>
          </defs>
        </svg>
      </div>

      <div class="p2p-zero-server-badge">⚡ Swarm P2P • Blocs SHA-256 de 512 Ko</div>
      <h3 class="empty-state-heading">Espace Drive ${currentPath === '/' ? 'à la Racine' : currentPath}</h3>
      <p class="empty-state-description">
        Les documents sont découpés en blocs cryptographiques, versionnés par Merkle DAG et répliqués en essaim local-first entre pairs sans passer par le cloud.
      </p>

      <div class="empty-state-actions">
        <button type="button" class="btn btn-primary empty-state-primary-btn" id="btn-empty-drive-upload">
          📤 Téléverser un premier fichier
        </button>

        <div class="empty-state-chips-group">
          <button type="button" class="empty-state-chip" id="btn-empty-drive-folder">
            📁 Créer un sous-dossier
          </button>
          <button type="button" class="empty-state-chip" id="btn-empty-drive-info">
            💡 Comment fonctionne l'essaim ?
          </button>
        </div>
      </div>
    `;

    el.querySelector('#btn-empty-drive-upload')?.addEventListener('click', () => {
      if (typeof onUploadClick === 'function') onUploadClick();
    });

    el.querySelector('#btn-empty-drive-folder')?.addEventListener('click', () => {
      if (typeof onCreateFolderClick === 'function') onCreateFolderClick();
    });

    el.querySelector('#btn-empty-drive-info')?.addEventListener('click', () => {
      Toast.info('Co-seeding P2P : Dès qu\'un pair reçoit un bloc de fichier, il devient automatiquement source de distribution pour les autres membres.');
    });

    return el;
  },

  // ================= 3. FORUM (DISCUSSIONS ARBORESCENTES) =================
  renderForumEmptyState(category, onCreateTopicWithTemplate) {
    const el = document.createElement('div');
    el.className = 'p2p-empty-state-wrapper empty-forum-state';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', `Catégorie de forum vide : ${category}`);

    el.innerHTML = `
      <div class="empty-svg-art p2p-anim-float" aria-hidden="true">
        <svg viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="70" cy="70" r="50" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.4"/>
          <rect x="34" y="42" width="72" height="56" rx="8" fill="#111726" stroke="#f59e0b" stroke-width="2"/>
          <rect x="44" y="52" width="36" height="6" rx="3" fill="#f59e0b"/>
          <rect x="44" y="64" width="52" height="4" rx="2" fill="#94a3b8" opacity="0.7"/>
          <rect x="44" y="72" width="42" height="4" rx="2" fill="#94a3b8" opacity="0.5"/>
          <rect x="44" y="80" width="28" height="4" rx="2" fill="#94a3b8" opacity="0.3"/>
          <g class="p2p-anim-pulse" transform="translate(86, 74)">
            <circle cx="12" cy="12" r="10" fill="#ec4899"/>
            <path d="M12 8V16M8 12H16" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
          </g>
        </svg>
      </div>

      <div class="p2p-zero-server-badge">📑 Base de Connaissances • Arborescence CRDT</div>
      <h3 class="empty-state-heading">Aucun sujet dans la catégorie « ${category} »</h3>
      <p class="empty-state-description">
        Les forums permettent de structurer vos échanges longs, documentations et décisions collectives avec conservation asynchrone hors-ligne.
      </p>

      <div class="empty-state-actions">
        <button type="button" class="btn btn-primary empty-state-primary-btn" id="btn-empty-new-topic">
          ✍️ Rédiger un nouveau sujet
        </button>

        <div class="empty-state-chips-group">
          <button type="button" class="empty-state-chip" data-tpl-title="🎯 Objectifs & Feuille de Route" data-tpl-cat="Architecture" data-tpl-content="Définissons ensemble les priorités majeures du groupe pour ce trimestre :&#10;1. Architecture décentralisée&#10;2. Sécurité et sauvegarde papier">
            🎯 Modèle : Feuille de Route
          </button>
          <button type="button" class="empty-state-chip" data-tpl-title="💡 Boîte à Idées & Suggestions" data-tpl-cat="Idées & Brainstorming" data-tpl-content="Partagez ici toutes vos propositions d'améliorations et de fonctionnalités utiles pour notre groupe.">
            💡 Modèle : Brainstorming
          </button>
        </div>
      </div>
    `;

    el.querySelector('#btn-empty-new-topic')?.addEventListener('click', () => {
      Modal.open('modal-new-topic');
    });

    el.querySelectorAll('.empty-state-chip[data-tpl-title]').forEach(chip => {
      chip.addEventListener('click', () => {
        const title = chip.getAttribute('data-tpl-title');
        const cat = chip.getAttribute('data-tpl-cat');
        const content = chip.getAttribute('data-tpl-content');
        if (typeof onCreateTopicWithTemplate === 'function') {
          onCreateTopicWithTemplate({ title, cat, content });
        }
      });
    });

    return el;
  },

  // ================= 4. SALON VOCAL & VIDÉO (LOBBY SANS PAIRS) =================
  renderMediaLobbyEmptyState(onJoinCall, onTestAudio, onOpenPermissions, vault) {
    const el = document.createElement('div');
    el.className = 'p2p-empty-state-wrapper empty-media-state';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Salon vocal et vidéo inactif');

    el.innerHTML = `
      <div class="empty-svg-art p2p-anim-float" aria-hidden="true">
        <svg viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="70" cy="70" r="55" stroke="url(#media-grad)" stroke-width="1.5" stroke-dasharray="6 4" class="p2p-anim-orbit"/>
          <circle cx="70" cy="70" r="38" fill="#111726" stroke="#10b981" stroke-width="2"/>
          <path d="M70 48C64.48 48 60 52.48 60 58V70C60 75.52 64.48 80 70 80C75.52 80 80 75.52 80 70V58C80 52.48 75.52 48 70 48Z" fill="#10b981"/>
          <path d="M52 66C52 75.94 60.06 84 70 84C79.94 84 88 75.94 88 66M70 84V94M62 94H78" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
          <defs>
            <linearGradient id="media-grad" x1="20" y1="20" x2="120" y2="120" gradientUnits="userSpaceOnUse">
              <stop stop-color="#10b981"/>
              <stop offset="1" stop-color="#06b6d4"/>
            </linearGradient>
          </defs>
        </svg>
      </div>

      <div class="p2p-zero-server-badge">🎙️ WebRTC Maillé Direct • Spatialisation 3D HRTF</div>
      <h3 class="empty-state-heading">Salon Vocal & Vidéo P2P Souverain</h3>
      <p class="empty-state-description">
        Les flux audio/vidéo circulent de pair à pair sans serveur intermédiaire MCU/SFU. Votre micro et votre caméra restent totalement inactifs tant que vous ne rejoignez pas.
      </p>

      <div class="empty-state-actions">
        <button type="button" class="btn btn-primary empty-state-primary-btn" id="btn-empty-join-call">
          🎙️ Rejoindre le salon maintenant
        </button>

        <div class="empty-state-chips-group">
          <button type="button" class="empty-state-chip" id="btn-empty-test-speaker">
            🔊 Tester le son
          </button>
          <button type="button" class="empty-state-chip" id="btn-empty-perms">
            ⚙️ Autorisations micro/caméra
          </button>
          <button type="button" class="empty-state-chip" id="btn-empty-invite-call">
            📋 Inviter un pair
          </button>
        </div>
      </div>
    `;

    el.querySelector('#btn-empty-join-call')?.addEventListener('click', () => {
      if (typeof onJoinCall === 'function') onJoinCall();
    });

    el.querySelector('#btn-empty-test-speaker')?.addEventListener('click', () => {
      if (typeof onTestAudio === 'function') onTestAudio();
    });

    el.querySelector('#btn-empty-perms')?.addEventListener('click', () => {
      if (typeof onOpenPermissions === 'function') onOpenPermissions();
    });

    el.querySelector('#btn-empty-invite-call')?.addEventListener('click', async () => {
      if (vault?.paperCode) {
        await ZeroTraceClipboard.copySensitive(vault.paperCode, 60000);
        Toast.success('Code d\'invitation copié !');
      }
    });

    return el;
  },

  // ================= 5. MEMBRES (ROSTER SANS PAIRS CONNECTÉS) =================
  renderRosterEmptyState(vault, onReconnectClick) {
    const el = document.createElement('div');
    el.className = 'p2p-empty-state-wrapper empty-roster-state';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Recherche de pairs sur le maillage P2P');

    el.innerHTML = `
      <div class="empty-svg-art p2p-anim-float" aria-hidden="true">
        <svg viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="70" cy="70" r="56" stroke="#06b6d4" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.4" class="p2p-anim-orbit"/>
          <circle cx="70" cy="70" r="40" stroke="#8b5cf6" stroke-width="1.5" opacity="0.6"/>
          <circle cx="70" cy="70" r="22" fill="#111726" stroke="#06b6d4" stroke-width="2"/>
          <circle cx="70" cy="70" r="7" fill="#06b6d4" class="p2p-anim-pulse"/>
          <line x1="70" y1="70" x2="110" y2="30" stroke="#06b6d4" stroke-width="2" stroke-linecap="round" class="p2p-anim-orbit"/>
        </svg>
      </div>

      <div class="p2p-zero-server-badge">📡 Découverte DHT / Signalement Souverain</div>
      <h3 class="empty-state-heading">En attente de connexion de vos pairs</h3>
      <p class="empty-state-description">
        L'application fonctionne sans annuaire public ni serveur de stockage. Partagez votre Code Papier secret pour connecter vos collaborateurs en direct.
      </p>

      <div class="empty-state-actions">
        <button type="button" class="btn btn-primary empty-state-primary-btn" id="btn-empty-roster-copy">
          📋 Copier le Code Papier Secret
        </button>

        <div class="empty-state-chips-group">
          <button type="button" class="empty-state-chip" id="btn-empty-roster-reconnect">
            🔄 Relancer la recherche de pairs
          </button>
        </div>
      </div>
    `;

    el.querySelector('#btn-empty-roster-copy')?.addEventListener('click', async () => {
      if (vault?.paperCode) {
        await ZeroTraceClipboard.copySensitive(vault.paperCode, 60000);
        Toast.success('Code papier copié ! Transmettez-le à votre pair.');
      }
    });

    el.querySelector('#btn-empty-roster-reconnect')?.addEventListener('click', () => {
      if (typeof onReconnectClick === 'function') onReconnectClick();
      Toast.info('Recherche réseau P2P réinitialisée.');
    });

    return el;
  }
};
