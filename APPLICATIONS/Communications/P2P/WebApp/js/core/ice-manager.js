/**
 * Gestionnaire Avancé de Candidats ICE & File d'Attente (RFC 8838, RFC 8445, W3C WebRTC 1.0)
 * G3.P2 : Spécialiste Trickle ICE, STUN/TURN & Candidate Queuing
 */

import { logger } from './logger.js';
import { CONFIG } from './config.js';

export class IceCandidateManager {
  constructor(pc, peerId = 'unknown') {
    this.pc = pc;
    this.peerId = peerId;
    this.earlyQueue = [];
    this.isRemoteDescriptionSet = false;
    this.hasHostCandidate = false;
    this.hasSrflxCandidate = false;
    this.hasRelayCandidate = false;
    this.activeUfrag = null;
  }

  /**
   * Trie les candidats par ordre de priorité selon la spécification RFC 8445
   * (host -> srflx -> relay)
   */
  static getCandidatePriority(candidateStr) {
    if (!candidateStr) return 0;
    if (candidateStr.includes('typ host')) return 300;
    if (candidateStr.includes('typ prflx')) return 200;
    if (candidateStr.includes('typ srflx')) return 100;
    if (candidateStr.includes('typ relay')) return 10;
    return 1;
  }

  /**
   * Ajoute un candidat distant : l'applique immédiatement si remoteDescription est prêt,
   * sinon l'empile dans earlyQueue en garantissant l'ordre de priorité.
   */
  async addRemoteCandidate(candidateInit) {
    if (!candidateInit || !candidateInit.candidate) return;

    if (this.pc.signalingState === 'closed') return;

    if (!this.isRemoteDescriptionSet || !this.pc.remoteDescription) {
      logger.debug('ICE Manager', `📥 Mise en file d'attente du candidat précoce pour ${this.peerId}`);
      this.earlyQueue.push(candidateInit);
      this.earlyQueue.sort((a, b) => 
        IceCandidateManager.getCandidatePriority(b.candidate) - IceCandidateManager.getCandidatePriority(a.candidate)
      );
      return;
    }

    try {
      const candidateObj = (typeof RTCIceCandidate !== 'undefined') ? new RTCIceCandidate(candidateInit) : candidateInit;
      await this.pc.addIceCandidate(candidateObj);
      logger.debug('ICE Manager', `✅ Candidat ICE appliqué avec succès pour ${this.peerId}`);
    } catch (err) {
      logger.warn('ICE Manager', `⚠️ Erreur application candidat pour ${this.peerId}:`, err.message);
    }
  }

  /**
   * Déverrouille la file d'attente dès que setRemoteDescription a réussi
   */
  async onRemoteDescriptionSet(ufrag = null) {
    this.isRemoteDescriptionSet = true;
    this.activeUfrag = ufrag;

    if (this.earlyQueue.length === 0) return;

    logger.info('ICE Manager', `🚀 Vidage de ${this.earlyQueue.length} candidat(s) précoce(s) pour ${this.peerId}...`);
    const queueToDrain = [...this.earlyQueue];
    this.earlyQueue = [];

    for (const candidateInit of queueToDrain) {
      try {
        if (this.pc.signalingState === 'closed') break;
        const candidateObj = (typeof RTCIceCandidate !== 'undefined') ? new RTCIceCandidate(candidateInit) : candidateInit;
        await this.pc.addIceCandidate(candidateObj);
      } catch (err) {
        logger.warn('ICE Manager', `Échec application candidat précoce (${this.peerId}):`, err.message);
      }
    }
  }

  /**
   * Réinitialise l'état lors d'un ICE Restart
   */
  resetForIceRestart() {
    this.earlyQueue = [];
    this.isRemoteDescriptionSet = false;
    this.hasHostCandidate = false;
    this.hasSrflxCandidate = false;
    this.hasRelayCandidate = false;
    this.activeUfrag = null;
  }
}
