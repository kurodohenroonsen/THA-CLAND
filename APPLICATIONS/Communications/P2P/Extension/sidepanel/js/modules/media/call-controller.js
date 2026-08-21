import { logger } from '../../core/logger.js';
import { MediaStreamManager } from './media-stream.js';
import { AudioProcessor } from './audio-processor.js';
import { AudioVisualizer } from './audio-visualizer.js';
import { SpatialAudioEngine } from './spatial-audio.js';
import { Toast } from '../../ui/toast.js';
import { CONFIG } from '../../core/config.js';

/**
 * Contrôleur des Appels Vocaux & Vidéo Mesh P2P (Standard 2025/2026)
 * - Traitement DSP vocal & AudioWorklet VAD
 * - Spatialisation Sonore 3D (SpatialAudioEngine & PannerNode HRTF)
 * - Synchronisation Labiale A/V (Lip-Sync MSID, Zero Double-Playout & Jitter Buffer)
 * - Partage d'Écran haute fidélité (CaptureController, replaceVideoTrack 'detail')
 * - Gestion matérielle avancée (Énumération, hot-plug devicechange & setSinkId)
 * - Mode Picture-in-Picture (Document PiP API + Video PiP fallback)
 * - Raccourcis clavier universels (Barre d'espace Push-to-Talk, M, V)
 * - Accessibilité WCAG 2.2 (Live region, aria-pressed, aria-keyshortcuts)
 */
export class CallController {
  constructor(meshNetwork, presenceManager, cryptoVault) {
    this.mesh = meshNetwork;
    this.presence = presenceManager;
    this.vault = cryptoVault;

    this.mediaManager = new MediaStreamManager();
    this.audioProcessor = new AudioProcessor();
    this.spatialAudio = new SpatialAudioEngine();
    this.visualizer = null;

    this.isInCall = false;
    this.isVideoActive = false;
    this.isMuted = false;
    this.isScreenSharing = false;
    this.isPushToTalkActive = false;
    this.isSpatialAudioActive = true;
    this.selectedAudioOutputId = '';

    this.remoteVideoStreams = new Map(); // peerId -> MediaStream
    this.pipWindow = null;

    this.initUI();
    this.initListeners();
    this.initKeyboardShortcuts();
    this.initHardwareMonitoring();
  }

  initUI() {
    logger.debug('Media', '🎙️ Initialisation du contrôleur d\'appels audio/vidéo...');
    this.videoGrid = document.getElementById('media-video-grid');
    this.canvasVisualizer = document.getElementById('audio-visualizer-canvas');
    this.visualizerBox = document.querySelector('.audio-visualizer-box');
    this.btnJoinAudio = document.getElementById('btn-join-audio-room');
    this.btnToggleCam = document.getElementById('btn-toggle-camera');
    this.btnToggleMic = document.getElementById('btn-toggle-mic');
    this.btnScreenShare = document.getElementById('btn-share-screen');
    this.btnLeaveCall = document.getElementById('btn-leave-call');
    this.btnTogglePiP = document.getElementById('btn-toggle-pip');
    this.btnToggleSpatial = document.getElementById('btn-toggle-spatial');
    this.callControlBar = document.getElementById('call-control-bar');
    this.callStatusText = document.getElementById('call-status-indicator');
    this.btnPerms = document.getElementById('btn-media-permissions');
    this.a11yAnnouncer = document.getElementById('call-a11y-announcer');

    if (this.canvasVisualizer) {
      this.visualizer = new AudioVisualizer(this.canvasVisualizer, this.audioProcessor);
    }

    if (this.btnPerms) {
      this.btnPerms.addEventListener('click', () => {
        logger.info('Media', '🖱️ Clic sur "Autorisations Micro / Caméra"');
        this.mediaManager.openPermissionHelper();
      });
    }

    if (this.btnJoinAudio) {
      this.btnJoinAudio.addEventListener('click', () => {
        logger.info('Media', '🖱️ Clic sur "Rejoindre le Salon"');
        this.handleJoinVoiceRoom();
      });
    }

    if (this.btnToggleCam) {
      this.btnToggleCam.addEventListener('click', () => {
        logger.info('Media', '🖱️ Clic sur "Activer/Couper Caméra"');
        this.handleToggleCamera();
      });
    }

    if (this.btnToggleMic) {
      this.btnToggleMic.addEventListener('click', () => {
        logger.info('Media', '🖱️ Clic sur "Mute/Unmute Micro"');
        this.handleToggleMute();
      });
    }

    if (this.btnScreenShare) {
      this.btnScreenShare.addEventListener('click', () => {
        logger.debug('Media', '🖱️ Clic sur "Partage d\'écran"');
        this.handleToggleScreenShare();
      });
    }

    if (this.btnTogglePiP) {
      this.btnTogglePiP.addEventListener('click', () => {
        logger.info('Media', '🖱️ Clic sur "Mode PiP"');
        this.handleTogglePiP();
      });
    }

    if (this.btnToggleSpatial) {
      this.btnToggleSpatial.addEventListener('click', () => {
        this.toggleSpatialAudio();
      });
    }

    if (this.btnLeaveCall) {
      this.btnLeaveCall.addEventListener('click', () => {
        logger.info('Media', '🖱️ Clic sur "Quitter le Salon"');
        this.leaveCall();
      });
    }
  }

  initListeners() {
    // 1. Réception d'une piste média WebRTC distante
    this.mesh.on('track-received', ({ peerId, track, streams }) => {
      logger.info('Media', `🎥 Piste distante [Kind: ${track.kind}, ID: ${track.id}] reçue de ${peerId}`);

      let stream = this.remoteVideoStreams.get(peerId);
      if (!stream) {
        stream = streams[0] || new MediaStream();
        this.remoteVideoStreams.set(peerId, stream);
      }

      const existingTracks = track.kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
      if (!existingTracks.some(t => t.id === track.id)) {
        stream.addTrack(track);
      }

      track.onended = () => {
        try { stream.removeTrack(track); } catch (_) {}
        this.updateVideoGrid();
      };

      // Attachement au moteur de spatialisation 3D
      if (track.kind === 'audio') {
        this.spatialAudio.attachRemoteStream(peerId, stream);
      }

      this.updateVideoGrid();
    });

    // 2. Départ d'un pair
    this.mesh.on('peer-left', ({ peerId }) => {
      if (this.remoteVideoStreams.has(peerId)) {
        logger.info('Media', `➖ Retrait du flux média pour le pair déconnecté ${peerId}`);
        this.spatialAudio.detachRemoteStream(peerId);
        this.remoteVideoStreams.delete(peerId);
      }
      this.updateVideoGrid();
    });

    // 3. Mise à jour de la présence (nouveaux membres, statut micro/caméra)
    this.presence.onPresenceUpdate(() => {
      this.updateVideoGrid();
    });

    // 4. Réception du signal VAD distant (SPEAKER_STATE)
    this.mesh.on('control-message', ({ peerId, data }) => {
      if (data?.type === 'SPEAKER_STATE') {
        const isSpeaking = !!data.isSpeaking;
        const tile = document.getElementById(`video-tile-${peerId}`);
        if (tile) {
          if (isSpeaking) tile.classList.add('is-speaking');
          else tile.classList.remove('is-speaking');
        }
      }
    });

    // 5. Télémétrie réactive & Réalignement Lip-Sync (Personas 4.8 & 5.9)
    if (this.mesh.telemetry) {
      this.mesh.telemetry.on('congestion-alert', ({ peerId, severity, metrics }) => {
        if (this.isInCall) {
          const peer = this.presence.roster.get(peerId);
          const name = peer ? peer.name : (peerId.substring(0, 8) + '...');
          if (severity === 'critical') {
            Toast.warning(`Liaison réseau instable avec ${name} (Perte: ${metrics.audio?.lossPct || 0}%, RTT: ${metrics.rttMs}ms)`);
          }
        }
      });

      this.mesh.telemetry.on('av-desync-detected', ({ peerId, offsetMs }) => {
        logger.warn('Media', `⚠️ Dérive Lip-Sync détectée avec ${peerId}: ${offsetMs}ms`);
        const peer = this.mesh.peers.get(peerId);
        if (peer && peer.connection) {
          this.mesh.resyncPeerJitterBuffers(peer.connection, offsetMs);
        }
      });
    }
  }

  /**
   * Surveillance des périphériques matériels (Hot-Plug & Failover) (Persona 5.6)
   */
  initHardwareMonitoring() {
    this.mediaManager.initDeviceChangeListener();
    this.mediaManager.onDeviceChange((devices) => {
      logger.info('Media', `🔌 Appareils audio/vidéo mis à jour (${devices.audioInputs.length} micros, ${devices.audioOutputs.length} sorties, ${devices.videoInputs.length} caméras)`);
      this.updateDeviceSelectors(devices);
    });

    this.mediaManager.onTrackEndedCallback = (kind) => {
      Toast.warning(`Périphérique ${kind === 'audio' ? 'micro' : 'caméra'} débranché.`);
      if (kind === 'audio') {
        this.handleToggleMute();
      } else if (kind === 'video') {
        this.handleToggleCamera();
      }
    };
  }

  /**
   * Raccourcis Clavier Universels WCAG 2.2 (Persona 5.10)
   * - Espace : Push-to-Talk (maintenir pour parler)
   * - M : Couper/Activer Micro
   * - V : Couper/Activer Caméra
   */
  initKeyboardShortcuts() {
    const isEditable = (el) => {
      if (!el) return false;
      const tag = el.tagName ? el.tagName.toUpperCase() : '';
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    window.addEventListener('keydown', (e) => {
      if (isEditable(e.target) || !this.isInCall) return;

      if (e.code === 'Space' && !e.repeat && this.isMuted) {
        e.preventDefault();
        this.isPushToTalkActive = true;
        this.handleToggleMute(false); // Unmute temporaire
        this.announceA11y('Push-to-talk activé : vous parlez');
      } else if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.handleToggleMute();
      } else if (e.code === 'KeyV' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.handleToggleCamera();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (isEditable(e.target) || !this.isInCall) return;

      if (e.code === 'Space' && this.isPushToTalkActive) {
        e.preventDefault();
        this.isPushToTalkActive = false;
        this.handleToggleMute(true); // Re-mute
        this.announceA11y('Push-to-talk relâché : micro coupé');
      }
    });
  }

  announceA11y(message) {
    if (this.a11yAnnouncer) {
      this.a11yAnnouncer.textContent = message;
    }
  }

  async handleJoinVoiceRoom() {
    if (this.isInCall) return;

    try {
      logger.debug('Media', '🎙️ Demande d\'accès au microphone...');
      Toast.info('Activation du microphone...');
      const rawAudioStream = await this.mediaManager.getAudioStream();

      // Démarrage du DSP AudioProcessor & AudioWorklet VAD
      const processedStream = await this.audioProcessor.start(rawAudioStream, (isSpeaking, level) => {
        const localTile = document.getElementById('video-tile-self');
        if (localTile) {
          if (isSpeaking) localTile.classList.add('is-speaking');
          else localTile.classList.remove('is-speaking');
        }

        // Diffusion du statut de parole aux pairs distants
        this.mesh.sendControlMessage('SPEAKER_STATE', { isSpeaking, level });
      });

      // Injection dans le réseau P2P maillé
      logger.info('Media', '🌐 Injection du flux audio DSP dans le maillage WebRTC...');
      await this.mesh.attachLocalMediaStream(processedStream || rawAudioStream);

      if (this.visualizer) this.visualizer.start();

      this.isInCall = true;
      this.isMuted = false;
      this.presence.broadcastMediaStatus(true, true, false);

      this.startBitrateAdaptation();
      this.updateCallUI();
      this.updateVideoGrid();

      this.announceA11y('Vous avez rejoint le salon vocal');
      logger.info('Media', '✅ SALON VOCAL P2P REJOINT AVEC SUCCÈS !');
      Toast.success('Vous avez rejoint le salon vocal P2P !');
    } catch (err) {
      logger.error('Media', 'Erreur accès audio:', err);
      Toast.error(err.message || 'Impossible de rejoindre le salon vocal.');
    }
  }

  async handleToggleCamera() {
    if (!this.isInCall) {
      await this.handleJoinVoiceRoom();
      if (!this.isInCall) return;
    }

    if (this.isVideoActive) {
      logger.info('Media', '📷 Désactivation de la caméra (arrêt réel du matériel)');
      if (this.mediaManager.localStream) {
        this.mediaManager.localStream.getVideoTracks().forEach(t => t.stop());
      }
      await this.mesh.detachVideoTracks();
      this.isVideoActive = false;
      if (this.btnToggleCam) {
        this.btnToggleCam.classList.remove('active');
        this.btnToggleCam.setAttribute('aria-pressed', 'false');
        this.btnToggleCam.innerHTML = '📷 Caméra';
      }
      this.announceA11y('Caméra désactivée');
    } else {
      try {
        logger.debug('Media', '📷 Demande d\'accès à la caméra...');
        Toast.info('Activation de la caméra...');
        const videoStream = await this.mediaManager.getVideoStream();
        const videoTrack = videoStream.getVideoTracks()[0];

        if (videoTrack) {
          await this.mesh.replaceVideoTrack(videoTrack, 'motion');
        }
        await this.mesh.attachLocalMediaStream(this.mediaManager.localStream);

        this.isVideoActive = true;
        if (this.btnToggleCam) {
          this.btnToggleCam.classList.add('active');
          this.btnToggleCam.setAttribute('aria-pressed', 'true');
          this.btnToggleCam.innerHTML = '📷 Couper Cam';
        }
        this.announceA11y('Caméra activée');
        logger.info('Media', '✅ Caméra active et injectée dans le maillage !');
        Toast.success('Caméra activée !');
      } catch (err) {
        logger.error('Media', 'Erreur caméra:', err);
        Toast.error(err.message || 'Impossible d\'activer la caméra.');
      }
    }

    this.presence.broadcastMediaStatus(this.isInCall, !this.isMuted, this.isVideoActive);
    this.updateVideoGrid();
  }

  handleToggleMute(forceState = null) {
    if (!this.isInCall) return;

    if (forceState !== null) {
      this.isMuted = forceState;
      if (this.mediaManager.localStream) {
        this.mediaManager.localStream.getAudioTracks().forEach(t => t.enabled = !this.isMuted);
      }
    } else {
      this.isMuted = this.mediaManager.toggleAudioMute();
    }

    this.audioProcessor.setMuted(this.isMuted);
    logger.info('Media', `🔇 Statut micro: ${this.isMuted ? 'MUET' : 'ACTIF'}`);

    if (this.btnToggleMic) {
      if (this.isMuted) {
        this.btnToggleMic.classList.add('muted');
        this.btnToggleMic.setAttribute('aria-pressed', 'true');
        this.btnToggleMic.innerHTML = '🔇 Muet';
        this.announceA11y('Microphone coupé');
      } else {
        this.btnToggleMic.classList.remove('muted');
        this.btnToggleMic.setAttribute('aria-pressed', 'false');
        this.btnToggleMic.innerHTML = '🎙️ Micro';
        this.announceA11y('Microphone actif');
      }
    }

    this.presence.broadcastMediaStatus(this.isInCall, !this.isMuted, this.isVideoActive);
    this.updateVideoGrid();
  }

  async handleToggleScreenShare() {
    if (!this.isInCall) return;

    if (this.isScreenSharing) {
      logger.info('Media', '🖥️ Arrêt du partage d\'écran');
      this.stopScreenSharing();
    } else {
      try {
        logger.debug('Media', '🖥️ Demande de capture d\'écran (getDisplayMedia 2026)...');
        const screenStream = await this.mediaManager.getScreenStream({ withAudio: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        if (screenTrack) {
          await this.mesh.replaceVideoTrack(screenTrack, 'detail');

          screenTrack.onended = () => {
            logger.info('Media', '🖥️ Fin du partage d\'écran déclenché nativement par le navigateur');
            this.stopScreenSharing();
          };

          this.isScreenSharing = true;
          if (this.btnScreenShare) {
            this.btnScreenShare.classList.add('active');
            this.btnScreenShare.setAttribute('aria-pressed', 'true');
          }
          this.announceA11y('Partage d\'écran actif');
          this.updateVideoGrid();
          Toast.success('Partage d\'écran actif.');
        }
      } catch (err) {
        logger.warn('Media', 'Partage écran annulé:', err);
      }
    }
  }

  async stopScreenSharing() {
    if (this.mediaManager.screenStream) {
      this.mediaManager.screenStream.getTracks().forEach(t => t.stop());
      this.mediaManager.screenStream = null;
    }
    this.isScreenSharing = false;

    if (this.btnScreenShare) {
      this.btnScreenShare.classList.remove('active');
      this.btnScreenShare.setAttribute('aria-pressed', 'false');
    }

    // Restaure la caméra locale si elle était active
    const camTrack = this.isVideoActive && this.mediaManager.localStream
      ? this.mediaManager.localStream.getVideoTracks()[0]
      : null;

    await this.mesh.replaceVideoTrack(camTrack, 'motion');
    this.announceA11y('Partage d\'écran arrêté');
    this.updateVideoGrid();
  }

  /**
   * Mode Picture-in-Picture (Document PiP API standard 2025/2026 & fallback vidéo)
   */
  async handleTogglePiP() {
    if (!this.isInCall) return;

    if (this.pipWindow) {
      this.pipWindow.close();
      this.pipWindow = null;
      return;
    }

    // 1. API Document Picture-in-Picture (permet d'embarquer toute la mosaïque vidéo)
    if ('documentPictureInPicture' in window) {
      try {
        this.pipWindow = await window.documentPictureInPicture.requestWindow({
          width: 360,
          height: 280
        });

        // Copie des styles CSS dans la fenêtre flottante PiP
        Array.from(document.styleSheets).forEach(styleSheet => {
          try {
            const cssRules = Array.from(styleSheet.cssRules).map(rule => rule.cssText).join('');
            const style = document.createElement('style');
            style.textContent = cssRules;
            this.pipWindow.document.head.appendChild(style);
          } catch (e) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = styleSheet.href;
            this.pipWindow.document.head.appendChild(link);
          }
        });

        const pipContainer = document.createElement('div');
        pipContainer.id = 'pip-media-root';
        pipContainer.className = 'pip-container';
        this.pipWindow.document.body.appendChild(pipContainer);

        this.pipWindow.addEventListener('pagehide', () => {
          this.pipWindow = null;
          this.updateVideoGrid();
        });

        this.updateVideoGrid();
        Toast.info('Mode Picture-in-Picture activé.');
        return;
      } catch (err) {
        logger.warn('Media', 'Document PiP non disponible, tentative fallback HTMLVideoElement:', err);
      }
    }

    // 2. Fallback HTMLVideoElement.requestPictureInPicture
    const firstVideo = this.videoGrid?.querySelector('video');
    if (firstVideo && document.pictureInPictureEnabled) {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await firstVideo.requestPictureInPicture();
        }
      } catch (e) {
        logger.warn('Media', 'Échec Video PiP:', e);
      }
    }
  }

  toggleSpatialAudio() {
    this.isSpatialAudioActive = !this.isSpatialAudioActive;
    this.spatialAudio.setSpatialConfig(this.isSpatialAudioActive);
    if (this.btnToggleSpatial) {
      this.btnToggleSpatial.classList.toggle('active', this.isSpatialAudioActive);
      this.btnToggleSpatial.setAttribute('aria-pressed', String(this.isSpatialAudioActive));
    }
    Toast.info(`Audio 3D spatialisé : ${this.isSpatialAudioActive ? 'Activé' : 'Désactivé'}`);
  }

  /**
   * Routage de la sortie audio vers le périphérique sélectionné (Persona 5.6)
   */
  async setAudioOutputSink(sinkId) {
    this.selectedAudioOutputId = sinkId || '';
    if (!('setSinkId' in HTMLMediaElement.prototype)) {
      logger.debug('Media', 'setSinkId non supporté sur ce navigateur.');
      return;
    }

    const audioElements = document.querySelectorAll('audio, video');
    for (const el of audioElements) {
      try {
        await el.setSinkId(this.selectedAudioOutputId);
      } catch (e) {
        logger.warn('Media', 'Erreur application setSinkId:', e);
      }
    }
  }

  /**
   * Test sonore carillon synthétique Web Audio (Persona 5.6)
   */
  async playSpeakerTestTone(sinkId = null) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      if (sinkId && 'setSinkId' in ctx) {
        await ctx.setSinkId(sinkId);
      }

      const notes = [523.25, 659.25, 783.99]; // Accord C5-E5-G5
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.12);

        gain.gain.setValueAtTime(0, ctx.currentTime + idx * 0.12);
        gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + idx * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.12 + 0.4);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime + idx * 0.12);
        osc.stop(ctx.currentTime + idx * 0.12 + 0.45);
      });

      setTimeout(() => ctx.close(), 1000);
      Toast.info('Carillon de test émis sur la sortie sélectionnée.');
    } catch (e) {
      logger.warn('Media', 'Erreur test carillon:', e);
    }
  }

  updateDeviceSelectors(devices) {
    const micSelect = document.getElementById('select-audio-input');
    const speakerSelect = document.getElementById('select-audio-output');
    const camSelect = document.getElementById('select-video-input');

    if (micSelect && devices.audioInputs.length > 0) {
      micSelect.innerHTML = devices.audioInputs.map(d =>
        `<option value="${d.deviceId}">${d.label || `Microphone ${d.deviceId.slice(0, 5)}`}</option>`
      ).join('');
    }
    if (speakerSelect && devices.audioOutputs.length > 0) {
      speakerSelect.innerHTML = devices.audioOutputs.map(d =>
        `<option value="${d.deviceId}">${d.label || `Haut-parleur ${d.deviceId.slice(0, 5)}`}</option>`
      ).join('');
    }
    if (camSelect && devices.videoInputs.length > 0) {
      camSelect.innerHTML = devices.videoInputs.map(d =>
        `<option value="${d.deviceId}">${d.label || `Caméra ${d.deviceId.slice(0, 5)}`}</option>`
      ).join('');
    }
  }

  leaveCall() {
    if (!this.isInCall) return;

    logger.info('Media', '⏹️ Quitter le salon : Libération des pistes audio/vidéo, spatialisation et visualiseur');
    this.audioProcessor.stop();
    if (this.visualizer) this.visualizer.stop();
    this.spatialAudio.destroy();
    this.stopBitrateAdaptation();
    this.mediaManager.stopAllStreams();
    this.mesh.removeLocalMediaStream();

    this.isInCall = false;
    this.isVideoActive = false;
    this.isMuted = false;
    this.isScreenSharing = false;

    if (this.pipWindow) {
      try { this.pipWindow.close(); } catch (_) {}
      this.pipWindow = null;
    }

    if (this.btnToggleCam) {
      this.btnToggleCam.classList.remove('active');
      this.btnToggleCam.setAttribute('aria-pressed', 'false');
      this.btnToggleCam.innerHTML = '📷 Caméra';
    }
    if (this.btnToggleMic) {
      this.btnToggleMic.classList.remove('muted');
      this.btnToggleMic.setAttribute('aria-pressed', 'false');
      this.btnToggleMic.innerHTML = '🎙️ Micro';
    }
    if (this.btnScreenShare) {
      this.btnScreenShare.classList.remove('active');
      this.btnScreenShare.setAttribute('aria-pressed', 'false');
    }

    this.presence.broadcastMediaStatus(false, false, false);
    this.announceA11y('Vous avez quitté le salon');
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
    const hasVideoTrack = stream && stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].enabled && (this.isVideoActive || this.isScreenSharing);

    if (hasVideoTrack) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true; // Mute local pour éviter tout effet Larsen
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
    tag.textContent = this.isMuted ? '🔇 Muet' : (this.isScreenSharing ? '🖥️ Écran' : (this.isVideoActive ? '📷 Caméra' : '🎙️ En direct'));
    selfTile.appendChild(tag);

    return selfTile;
  }

  updateVideoGrid() {
    const targetRoot = (this.pipWindow && this.pipWindow.document.getElementById('pip-media-root')) || this.videoGrid;
    if (!targetRoot) return;

    if (!this.isInCall) {
      if (this.visualizerBox) this.visualizerBox.classList.add('hidden');
      this._renderLobby();
      return;
    }
    if (this.visualizerBox) this.visualizerBox.classList.remove('hidden');

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

    targetRoot.classList.remove('lobby-mode');
    targetRoot.setAttribute('data-peer-count', String(inCallPeers.length + 1));
    targetRoot.innerHTML = '';
    targetRoot.appendChild(this.renderSelfVideoTile());

    inCallPeers.forEach(([peerId, peer]) => {
      const tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = `video-tile-${peerId}`;

      const stream = this.remoteVideoStreams.get(peerId);
      const hasVideo = stream && stream.getVideoTracks().length > 0 && peer.isVideoActive;

      // UNIFICATION LIP-SYNC : Si vidéo présente, <video> diffuse son et image synchronisés.
      // <audio> n'est instancié QUE si la vidéo est absente (Persona 5.9).
      if (hasVideo) {
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;
        if (this.selectedAudioOutputId && 'setSinkId' in video) {
          video.setSinkId(this.selectedAudioOutputId).catch(() => {});
        }
        tile.appendChild(video);
      } else {
        tile.innerHTML = `
          <div class="video-tile-avatar">
            <div class="avatar-placeholder">👤</div>
            <span class="tile-user-name">${this.escape(peer.name || 'Membre')}</span>
          </div>
        `;
        if (stream && stream.getAudioTracks().length > 0) {
          const audio = document.createElement('audio');
          audio.autoplay = true;
          audio.srcObject = stream;
          if (this.selectedAudioOutputId && 'setSinkId' in audio) {
            audio.setSinkId(this.selectedAudioOutputId).catch(() => {});
          }
          tile.appendChild(audio);
        }
      }

      const tag = document.createElement('span');
      tag.className = 'tile-badge';
      tag.textContent = peer.isVideoActive ? `📷 ${peer.name}` : (peer.isAudioActive ? `🎙️ ${peer.name}` : `🔇 ${peer.name}`);
      tile.appendChild(tag);

      targetRoot.appendChild(tile);
    });

    // Mise à jour de la projection géométrique 3D pour l'audio spatial
    if (this.isSpatialAudioActive) {
      setTimeout(() => {
        this.spatialAudio.updatePositionsFromGrid(targetRoot, inCallPeers.map(p => p[0]));
      }, 50);
    }
  }

  _renderLobby() {
    this._gridSig = null;
    const members = Array.from(this.presence.roster.values());
    const inCallCount = members.filter(p => p.inCall).length;

    const sig = 'lobby|' + members.map(p => `${p.id}:${p.inCall?1:0}:${this.escape(p.name)}`).join(',');
    if (sig === this._lobbySig) return;
    this._lobbySig = sig;

    this.videoGrid.classList.add('lobby-mode');
    this.videoGrid.removeAttribute('data-peer-count');

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

  startBitrateAdaptation() {
    this.stopBitrateAdaptation();
    this.bitrateInterval = setInterval(() => {
      if (!this.isVideoActive && !this.isScreenSharing) return;
      this.presence.roster.forEach((peer, peerId) => {
        const rtt = peer.latencyMs || 40;
        this.mesh.applyVideoBitrate(peerId, rtt, this.isScreenSharing);
      });
    }, CONFIG.VIDEO_BITRATE?.ADAPT_INTERVAL || 2000);
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
