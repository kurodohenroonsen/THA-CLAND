/**
 * Contrôleur des Appels Vocaux & Vidéo Mesh P2P
 * Mosaïque vidéo dynamique, détection vocale temps réel (VAD), renégociation fluide de la caméra et affichage de tous les pairs connectés.
 */

import { MediaStreamManager } from './media-stream.js';
import { AudioProcessor } from './audio-processor.js';
import { AudioVisualizer } from './audio-visualizer.js';
import { Toast } from '../../ui/toast.js';
import { CONFIG } from '../../core/config.js';

export class CallController {
  constructor(meshNetwork, presenceManager, cryptoVault) {
    this.mesh = meshNetwork;
    this.presence = presenceManager;
    this.vault = cryptoVault;
    
    this.mediaManager = new MediaStreamManager();
    this.audioProcessor = new AudioProcessor();
    this.visualizer = null;

    this.isInCall = false;
    this.isVideoActive = false;
    this.isMuted = false;
    this.isScreenSharing = false;
    
    this.remoteVideoStreams = new Map(); // peerId -> MediaStream

    this.initUI();
    this.initListeners();
  }

  initUI() {
    console.log('[Media] 🎙️ Initialisation du contrôleur d\'appels audio/vidéo...');
    this.videoGrid = document.getElementById('media-video-grid');
    this.canvasVisualizer = document.getElementById('audio-visualizer-canvas');
    this.visualizerBox = document.querySelector('.audio-visualizer-box');
    this.btnJoinAudio = document.getElementById('btn-join-audio-room');
    this.btnToggleCam = document.getElementById('btn-toggle-camera');
    this.btnToggleMic = document.getElementById('btn-toggle-mic');
    this.btnScreenShare = document.getElementById('btn-share-screen');
    this.btnLeaveCall = document.getElementById('btn-leave-call');
    this.callControlBar = document.getElementById('call-control-bar');
    this.callStatusText = document.getElementById('call-status-indicator');
    this.btnPerms = document.getElementById('btn-media-permissions');

    if (this.canvasVisualizer) {
      this.visualizer = new AudioVisualizer(this.canvasVisualizer, this.audioProcessor);
    }

    if (this.btnPerms) {
      this.btnPerms.addEventListener('click', () => {
        console.log('[Media] 🖱️ Clic sur "Autorisations Micro / Caméra"');
        this.mediaManager.openPermissionHelper();
      });
    }

    if (this.btnJoinAudio) {
      this.btnJoinAudio.addEventListener('click', () => {
        console.log('[Media] 🖱️ Clic sur "Rejoindre le Salon"');
        this.handleJoinVoiceRoom();
      });
    }

    if (this.btnToggleCam) {
      this.btnToggleCam.addEventListener('click', () => {
        console.log('[Media] 🖱️ Clic sur "Activer/Couper Caméra"');
        this.handleToggleCamera();
      });
    }

    if (this.btnToggleMic) {
      this.btnToggleMic.addEventListener('click', () => {
        console.log('[Media] 🖱️ Clic sur "Mute/Unmute Micro"');
        this.handleToggleMute();
      });
    }

    if (this.btnScreenShare) {
      this.btnScreenShare.addEventListener('click', () => {
        console.log('[Media] 🖱️ Clic sur "Partage d\'écran"');
        this.handleToggleScreenShare();
      });
    }

    if (this.btnLeaveCall) {
      this.btnLeaveCall.addEventListener('click', () => {
        console.log('[Media] 🖱️ Clic sur "Quitter le Salon"');
        this.leaveCall();
      });
    }
  }

  initListeners() {
    // 1. Réception d'un flux média WebRTC distant
    this.mesh.on('track-received', ({ peerId, track, streams }) => {
      console.log(`%c[Media] 🎥 Piste distante [Kind: ${track.kind}, ID: ${track.id}] reçue du pair ${peerId}`, 'color: #ec4899; font-weight: bold;');
      
      let stream = streams[0];
      if (!stream) {
        if (this.remoteVideoStreams.has(peerId)) {
          stream = this.remoteVideoStreams.get(peerId);
          stream.addTrack(track);
        } else {
          stream = new MediaStream([track]);
        }
      }

      this.remoteVideoStreams.set(peerId, stream);
      this.updateVideoGrid();
    });

    // 2. Départ d'un pair
    this.mesh.on('peer-left', ({ peerId }) => {
      if (this.remoteVideoStreams.has(peerId)) {
        console.log(`[Media] ➖ Retrait du flux média pour le pair déconnecté ${peerId}`);
        this.remoteVideoStreams.delete(peerId);
      }
      this.updateVideoGrid();
    });

    // 3. Mise à jour de la présence (nouveaux membres, statut micro/caméra)
    this.presence.onPresenceUpdate(() => {
      this.updateVideoGrid();
    });
  }

  async handleJoinVoiceRoom() {
    if (this.isInCall) return;

    try {
      console.log('[Media] 🎙️ Demande d\'accès au microphone...');
      Toast.info('Activation du microphone...');
      const audioStream = await this.mediaManager.getAudioStream();

      // Injection dans le réseau P2P maillé avec renégociation automatique
      console.log('[Media] 🌐 Injection du flux audio dans le maillage WebRTC...');
      await this.mesh.attachLocalMediaStream(audioStream);

      // Démarrage de l'analyse spectrale et de la détection vocale VAD
      console.log('[Media] 📊 Démarrage de l\'analyseur Web Audio et du VAD...');
      this.audioProcessor.start(audioStream, (isSpeaking, level) => {
        const localTile = document.getElementById('video-tile-self');
        if (localTile) {
          if (isSpeaking) {
            localTile.classList.add('is-speaking');
          } else {
            localTile.classList.remove('is-speaking');
          }
        }
      });

      if (this.visualizer) this.visualizer.start();

      this.isInCall = true;
      this.presence.broadcastMediaStatus(true, true, false);

      // Démarre l'adaptation dynamique du bitrate vidéo selon la latence RTT.
      this.startBitrateAdaptation();

      this.updateCallUI();
      this.updateVideoGrid();
      console.log('%c[Media] ✅ SALON VOCAL P2P REJOINT AVEC SUCCÈS !', 'color: #10b981; font-weight: bold;');
      Toast.success('Vous avez rejoint le salon vocal P2P !');
    } catch (err) {
      console.error('[Media] ❌ Erreur accès audio:', err);
      Toast.error(err.message || 'Impossible de rejoindre le salon vocal.');
    }
  }

  async handleToggleCamera() {
    if (!this.isInCall) {
      await this.handleJoinVoiceRoom();
      if (!this.isInCall) return;
    }

    if (this.isVideoActive) {
      console.log('[Media] 📷 Désactivation de la caméra (arrêt réel du périphérique)');
      // Coupe VRAIMENT la caméra (voyant éteint) et retire la piste des pairs.
      this.mediaManager.stopVideoTrack();
      await this.mesh.detachVideoTracks();
      this.isVideoActive = false;
      this.btnToggleCam.classList.remove('active');
      this.btnToggleCam.innerHTML = '📷 Caméra';
    } else {
      try {
        console.log('[Media] 📷 Demande d\'accès à la caméra...');
        Toast.info('Activation de la caméra...');
        const videoStream = await this.mediaManager.getVideoStream();
        await this.mesh.attachLocalMediaStream(videoStream);
        this.isVideoActive = true;
        this.btnToggleCam.classList.add('active');
        this.btnToggleCam.innerHTML = '📷 Couper Cam';
        console.log('%c[Media] ✅ Caméra active et injectée dans le maillage !', 'color: #10b981;');
        Toast.success('Caméra activée !');
      } catch (err) {
        console.error('[Media] ❌ Erreur caméra:', err);
        Toast.error(err.message || 'Impossible d\'activer la caméra.');
      }
    }

    this.presence.broadcastMediaStatus(this.isInCall, !this.isMuted, this.isVideoActive);
    this.updateVideoGrid();
  }

  handleToggleMute() {
    if (!this.isInCall) return;
    this.isMuted = this.mediaManager.toggleAudioMute();
    console.log(`[Media] 🔇 Statut micro basculé: ${this.isMuted ? 'MUET' : 'ACTIF'}`);

    if (this.isMuted) {
      this.btnToggleMic.classList.add('muted');
      this.btnToggleMic.innerHTML = '🔇 Muet';
      Toast.warning('Microphone coupé');
    } else {
      this.btnToggleMic.classList.remove('muted');
      this.btnToggleMic.innerHTML = '🎙️ Micro';
      Toast.info('Microphone actif');
    }

    this.presence.broadcastMediaStatus(this.isInCall, !this.isMuted, this.isVideoActive);
    this.updateVideoGrid();
  }

  async handleToggleScreenShare() {
    if (!this.isInCall) return;

    if (this.isScreenSharing) {
      console.log('[Media] 🖥️ Arrêt du partage d\'écran');
      if (this.mediaManager.screenStream) {
        this.mediaManager.screenStream.getTracks().forEach(t => t.stop());
      }
      this.isScreenSharing = false;
      this.btnScreenShare.classList.remove('active');
      this.updateVideoGrid();
    } else {
      try {
        console.log('[Media] 🖥️ Demande de capture d\'écran (getDisplayMedia)...');
        const screenStream = await this.mediaManager.getScreenStream();
        await this.mesh.attachLocalMediaStream(screenStream);
        this.isScreenSharing = true;
        this.btnScreenShare.classList.add('active');

        screenStream.getVideoTracks()[0].onended = () => {
          console.log('[Media] 🖥️ Fin du partage d\'écran déclenché par l\'OS');
          this.isScreenSharing = false;
          this.btnScreenShare.classList.remove('active');
          this.updateVideoGrid();
        };

        this.updateVideoGrid();
        Toast.success('Partage d\'écran actif.');
      } catch (err) {
        console.warn('[Media] ⚠️ Partage écran annulé:', err);
      }
    }
  }

  leaveCall() {
    if (!this.isInCall) return;

    console.log('[Media] ⏹️ Quitter le salon : Libération des pistes audio/vidéo et arrêt de l\'analyseur');
    this.audioProcessor.stop();
    if (this.visualizer) this.visualizer.stop();
    this.stopBitrateAdaptation();
    this.mediaManager.stopAll();
    this.mesh.removeLocalMediaStream();

    this.isInCall = false;
    this.isVideoActive = false;
    this.isMuted = false;
    this.isScreenSharing = false;

    if (this.btnToggleCam) {
      this.btnToggleCam.classList.remove('active');
      this.btnToggleCam.innerHTML = '📷 Caméra';
    }
    if (this.btnToggleMic) {
      this.btnToggleMic.classList.remove('muted');
      this.btnToggleMic.innerHTML = '🎙️ Micro';
    }
    if (this.btnScreenShare) {
      this.btnScreenShare.classList.remove('active');
    }

    this.presence.broadcastMediaStatus(false, false, false);
    this.updateCallUI();
    this.updateVideoGrid();

    Toast.info('Vous avez quitté le salon.');
  }

  updateCallUI() {
    if (this.callControlBar) {
      if (this.isInCall) this.callControlBar.classList.remove('hidden');
      else this.callControlBar.classList.add('hidden');
    }

    if (this.btnJoinAudio) {
      if (this.isInCall) this.btnJoinAudio.classList.add('hidden');
      else this.btnJoinAudio.classList.remove('hidden');
    }

    if (this.callStatusText) {
      this.callStatusText.textContent = this.isInCall ? '🟢 En direct dans le salon vocal/vidéo' : '⚪ Salon inactif';
    }
  }

  renderSelfVideoTile() {
    const selfTile = document.createElement('div');
    selfTile.id = 'video-tile-self';
    selfTile.className = 'video-tile';

    const stream = this.isScreenSharing ? this.mediaManager.screenStream : this.mediaManager.localStream;
    const hasVideoTrack = stream && stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].enabled && this.isVideoActive;

    if (hasVideoTrack) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      selfTile.appendChild(video);
    } else {
      selfTile.innerHTML = `
        <div class="video-tile-avatar">
          <div class="avatar-placeholder">🎙️</div>
          <span class="tile-user-name">${this.escape(this.vault.userName)} (Vous)</span>
        </div>
      `;
    }

    const tag = document.createElement('span');
    tag.className = 'tile-badge';
    tag.textContent = this.isMuted ? '🔇 Muet' : (this.isVideoActive ? '📷 Caméra' : '🎙️ En direct');
    selfTile.appendChild(tag);

    return selfTile;
  }

  updateVideoGrid() {
    if (!this.videoGrid) return;

    // Deux modes bien distincts :
    //  - HORS appel  → LOBBY : simple liste des membres présents (aucun flux média
    //    n'est lu ni affiché ; on ne diffuse rien).
    //  - EN appel    → mosaïque des tuiles (soi + pairs réellement en appel).
    if (!this.isInCall) {
      if (this.visualizerBox) this.visualizerBox.classList.add('hidden');
      this._renderLobby();
      return;
    }
    if (this.visualizerBox) this.visualizerBox.classList.remove('hidden');

    // Signature de l'état rendu : on ne reconstruit la mosaïque QUE si la
    // composition change réellement. Sinon les <video>/<audio> seraient détruits
    // et recréés à chaque tick de présence (mesure de latence), coupant le flux.
    const inCallPeers = [];
    this.presence.roster.forEach((peer, peerId) => {
      if (peer.inCall || this.remoteVideoStreams.has(peerId)) inCallPeers.push([peerId, peer]);
    });
    const sig = 'call|' + `self:${this.isVideoActive}:${this.isMuted}:${this.isScreenSharing}|` +
      inCallPeers.map(([pid, p]) => {
        const s = this.remoteVideoStreams.get(pid);
        const hasV = !!(s && s.getVideoTracks().length > 0 && p.isVideoActive);
        return `${pid}:${p.isVideoActive?1:0}:${p.isAudioActive?1:0}:${hasV?1:0}`;
      }).join(',');
    if (sig === this._gridSig) return;
    this._gridSig = sig;

    this.videoGrid.classList.remove('lobby-mode');
    this.videoGrid.innerHTML = '';
    this.videoGrid.appendChild(this.renderSelfVideoTile());

    inCallPeers.forEach(([peerId, peer]) => {
      const tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = `video-tile-${peerId}`;

      const stream = this.remoteVideoStreams.get(peerId);
      const hasVideo = stream && stream.getVideoTracks().length > 0 && peer.isVideoActive;

      if (hasVideo) {
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;
        tile.appendChild(video);
      } else {
        tile.innerHTML = `
          <div class="video-tile-avatar">
            <div class="avatar-placeholder">👤</div>
            <span class="tile-user-name">${this.escape(peer.name || 'Membre')}</span>
          </div>
        `;
      }

      // Audio distant lu uniquement quand on est soi-même dans l'appel.
      if (stream && stream.getAudioTracks().length > 0) {
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.srcObject = stream;
        tile.appendChild(audio);
      }

      const tag = document.createElement('span');
      tag.className = 'tile-badge';
      tag.textContent = peer.isVideoActive ? `📷 ${peer.name}` : (peer.isAudioActive ? `🎙️ ${peer.name}` : `🔇 ${peer.name}`);
      tile.appendChild(tag);

      this.videoGrid.appendChild(tile);
    });
  }

  /** Rendu du LOBBY (hors appel) : liste des membres, sans aucun flux média. */
  _renderLobby() {
    this._gridSig = null; // force la reconstruction au prochain passage en appel
    const members = Array.from(this.presence.roster.values());
    const inCallCount = members.filter(p => p.inCall).length;

    const sig = 'lobby|' + members.map(p => `${p.id}:${p.inCall?1:0}:${this.escape(p.name)}`).join(',');
    if (sig === this._lobbySig) return;
    this._lobbySig = sig;

    this.videoGrid.classList.add('lobby-mode');

    const rows = members.map(p => {
      const badge = p.inCall
        ? `<span class="lobby-badge in-call">🔴 En appel</span>`
        : `<span class="lobby-badge">⚪ Dans le lobby</span>`;
      return `
        <div class="lobby-member">
          <img class="lobby-avatar" src="${p.avatar || this.presence.generateAvatar(p.id)}" alt=""/>
          <span class="lobby-name">${this.escape(p.name || 'Membre')}</span>
          ${badge}
        </div>`;
    }).join('');

    const header = members.length === 0
      ? `<div class="empty-state" style="padding:18px 10px;"><div class="empty-icon">🕸️</div><p>Aucun autre membre connecté pour l'instant.</p><small>Les membres du groupe apparaîtront ici.</small></div>`
      : `<div class="lobby-head">
           <span>👥 ${members.length} membre(s) dans l'espace</span>
           ${inCallCount > 0 ? `<span class="lobby-incall-count">🔴 ${inCallCount} en appel</span>` : ''}
         </div>
         <div class="lobby-list">${rows}</div>`;

    this.videoGrid.innerHTML = `
      <div class="voice-lobby">
        ${header}
        <div class="lobby-hint">🎧 Vous n'êtes pas encore dans le salon — votre micro et votre caméra restent éteints. Cliquez sur « Rejoindre le Salon » pour participer.</div>
      </div>`;
  }

  /**
   * Boucle d'adaptation du bitrate vidéo : lit la latence RTT de chaque pair
   * (mesurée par PresenceManager) et ajuste le débit sortant en conséquence.
   */
  startBitrateAdaptation() {
    this.stopBitrateAdaptation();
    this.bitrateInterval = setInterval(() => {
      if (!this.isVideoActive && !this.isScreenSharing) return;
      this.presence.roster.forEach((peer, peerId) => {
        const rtt = (peer.latencyMs || 40) * 2; // latencyMs ≈ RTT/2
        this.mesh.applyVideoBitrate(peerId, rtt);
      });
    }, CONFIG.VIDEO_BITRATE.ADAPT_INTERVAL);
  }

  stopBitrateAdaptation() {
    if (this.bitrateInterval) {
      clearInterval(this.bitrateInterval);
      this.bitrateInterval = null;
    }
  }

  escape(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  }
}
