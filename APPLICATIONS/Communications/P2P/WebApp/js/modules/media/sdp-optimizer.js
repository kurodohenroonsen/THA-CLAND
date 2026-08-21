/**
 * sdp-optimizer.js - Optimiseur & Négociateur SDP Média Avancé (Pass 4 Hardened)
 * P2P Mesh Workspace (2025/2026)
 * - RFC 7587 : Optimisation Opus Fullband 48 kHz Stéréo, FEC in-band & VBR
 * - RFC 2198 : Support Redondance Audio (RED)
 * - RFC 6184 / AOMedia / VP9 : Négociation & Tri Codecs Vidéo (AV1, VP9 Profile 0/2, H.264 Constrained Baseline)
 * - RFC 9429 (JSEP) : Munging déterministe Offer/Answer pré-setLocalDescription
 */

import { logger } from '../../core/logger.js';
import { CONFIG } from '../../core/config.js';

export class SDPOptimizer {
  static optimizeSDP(sdp, options = {}) {
    if (!sdp || typeof sdp !== 'string') return sdp;

    let modifiedSdp = sdp;
    try {
      modifiedSdp = this.optimizeOpusFmtp(modifiedSdp, options.audio);
      modifiedSdp = this.optimizeVideoCodecs(modifiedSdp, options.video);
      modifiedSdp = this.applySessionBandwidth(modifiedSdp, options.bandwidth);
    } catch (err) {
      logger.warn('SDPOptimizer', 'Erreur pendant l\'optimisation SDP:', err.message);
      return sdp;
    }
    return modifiedSdp;
  }

  static optimizeOpusFmtp(sdp, audioConfig = {}) {
    const lines = sdp.split('\r\n');
    let opusPayloadType = null;

    for (const line of lines) {
      const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?/i);
      if (match) {
        opusPayloadType = match[1];
        break;
      }
    }

    if (!opusPayloadType) {
      return sdp;
    }

    const cfg = {
      stereo: audioConfig.stereo ?? (CONFIG.MEDIA?.AUDIO?.STEREO ?? 1),
      spropStereo: audioConfig.spropStereo ?? (CONFIG.MEDIA?.AUDIO?.SPROP_STEREO ?? 1),
      useInbandFec: audioConfig.useInbandFec ?? (CONFIG.MEDIA?.AUDIO?.USE_INBAND_FEC ?? 1),
      usedtx: audioConfig.usedtx ?? (CONFIG.MEDIA?.AUDIO?.USE_DTX ?? 1),
      maxBitrate: audioConfig.maxBitrate ?? (CONFIG.MEDIA?.AUDIO?.MAX_BITRATE ?? 128000),
      minptime: audioConfig.minptime ?? 10,
      ptime: audioConfig.ptime ?? 20,
      cbr: audioConfig.cbr ?? 0,
      maxplaybackrate: 48000,
      spropMaxcapturerate: 48000
    };

    const targetFmtpParams = [
      `minptime=${cfg.minptime}`,
      `useinbandfec=${cfg.useInbandFec}`,
      `usedtx=${cfg.usedtx}`,
      `stereo=${cfg.stereo}`,
      `sprop-stereo=${cfg.spropStereo}`,
      `maxplaybackrate=${cfg.maxplaybackrate}`,
      `sprop-maxcapturerate=${cfg.spropMaxcapturerate}`,
      `maxaveragebitrate=${cfg.maxBitrate}`,
      `cbr=${cfg.cbr}`
    ].join(';');

    let fmtpFound = false;
    const newLines = lines.map(line => {
      if (line.startsWith(`a=fmtp:${opusPayloadType} `) || line.startsWith(`a=fmtp:${opusPayloadType};`)) {
        fmtpFound = true;
        const existingParams = line.substring(line.indexOf(' ') + 1).split(';');
        const paramMap = new Map();

        existingParams.forEach(p => {
          const [k, v] = p.trim().split('=');
          if (k) paramMap.set(k.trim().toLowerCase(), v ? v.trim() : '');
        });

        paramMap.set('minptime', String(cfg.minptime));
        paramMap.set('useinbandfec', String(cfg.useInbandFec));
        paramMap.set('usedtx', String(cfg.usedtx));
        paramMap.set('stereo', String(cfg.stereo));
        paramMap.set('sprop-stereo', String(cfg.spropStereo));
        paramMap.set('maxplaybackrate', String(cfg.maxplaybackrate));
        paramMap.set('sprop-maxcapturerate', String(cfg.spropMaxcapturerate));
        paramMap.set('maxaveragebitrate', String(cfg.maxBitrate));
        paramMap.set('cbr', String(cfg.cbr));

        const merged = Array.from(paramMap.entries())
          .map(([k, v]) => (v !== '' ? `${k}=${v}` : k))
          .join(';');

        return `a=fmtp:${opusPayloadType} ${merged}`;
      }
      return line;
    });

    if (!fmtpFound) {
      const rtpmapIndex = newLines.findIndex(l => l.startsWith(`a=rtpmap:${opusPayloadType} `));
      if (rtpmapIndex !== -1) {
        newLines.splice(rtpmapIndex + 1, 0, `a=fmtp:${opusPayloadType} ${targetFmtpParams}`);
      }
    }

    return newLines.join('\r\n');
  }

  static optimizeVideoCodecs(sdp, videoConfig = {}) {
    const lines = sdp.split('\r\n');
    const mVideoIndex = lines.findIndex(l => l.startsWith('m=video '));
    if (mVideoIndex === -1) return sdp;

    const mVideoLine = lines[mVideoIndex];
    const mParts = mVideoLine.split(' ');
    const header = mParts.slice(0, 3);
    const currentPayloads = mParts.slice(3);

    const payloadInfo = new Map();
    lines.forEach(l => {
      const rtpMatch = l.match(/^a=rtpmap:(\d+)\s+([^/]+)\/(\d+)/i);
      if (rtpMatch) {
        const pt = rtpMatch[1];
        const mime = rtpMatch[2].toUpperCase();
        if (!payloadInfo.has(pt)) payloadInfo.set(pt, { mime, fmtp: '' });
        else payloadInfo.get(pt).mime = mime;
      }
      const fmtpMatch = l.match(/^a=fmtp:(\d+)\s+(.+)/i);
      if (fmtpMatch) {
        const pt = fmtpMatch[1];
        const fmtp = fmtpMatch[2];
        if (!payloadInfo.has(pt)) payloadInfo.set(pt, { mime: '', fmtp });
        else payloadInfo.get(pt).fmtp = fmtp;
      }
    });

    const getCodecScore = (pt) => {
      const info = payloadInfo.get(pt);
      if (!info) return 999;
      const mime = info.mime;
      const fmtp = info.fmtp.toLowerCase();

      if (mime === 'AV1') return 10;
      if (mime === 'VP9') {
        if (fmtp.includes('profile-id=2')) return 20;
        if (fmtp.includes('profile-id=0') || !fmtp.includes('profile-id=')) return 21;
        return 22;
      }
      if (mime === 'H264') {
        if (fmtp.includes('profile-level-id=42e01f') || fmtp.includes('profile-level-id=42001f')) return 30;
        if (fmtp.includes('profile-level-id=4d001f')) return 31;
        if (fmtp.includes('profile-level-id=6400')) return 32;
        return 33;
      }
      if (mime === 'VP8') return 40;
      if (mime === 'RTX' || mime === 'ULPFEC' || mime === 'RED') return 900;
      return 50;
    };

    const sortedPayloads = currentPayloads.slice().sort((a, b) => getCodecScore(a) - getCodecScore(b));
    lines[mVideoIndex] = `${header.join(' ')} ${sortedPayloads.join(' ')}`;

    return lines.join('\r\n');
  }

  static applySessionBandwidth(sdp, bandwidthConfig = {}) {
    if (!bandwidthConfig || !bandwidthConfig.videoKbps) return sdp;

    const lines = sdp.split('\r\n');
    const newLines = [];

    for (let i = 0; i < lines.length; i++) {
      newLines.push(lines[i]);
      if (lines[i].startsWith('m=video ')) {
        if (i + 1 < lines.length && !lines[i + 1].startsWith('b=')) {
          newLines.push(`b=AS:${bandwidthConfig.videoKbps}`);
          newLines.push(`b=TIAS:${bandwidthConfig.videoKbps * 1000}`);
        }
      }
    }

    return newLines.join('\r\n');
  }

  static applyCodecPreferences(transceiver, kind) {
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
    const getCaps = typeof RTCRtpSender !== 'undefined' ? (RTCRtpSender.getCapabilities || RTCRtpReceiver.getCapabilities) : null;
    if (!getCaps) return;

    const caps = getCaps(kind);
    if (!caps || !caps.codecs || caps.codecs.length === 0) return;

    if (kind === 'audio') {
      const ordered = [];
      const red = caps.codecs.filter(c => c.mimeType.toLowerCase() === 'audio/red');
      const opus = caps.codecs.filter(c => c.mimeType.toLowerCase() === 'audio/opus');
      const others = caps.codecs.filter(c => c.mimeType.toLowerCase() !== 'audio/opus' && c.mimeType.toLowerCase() !== 'audio/red');

      ordered.push(...red, ...opus, ...others);
      try {
        transceiver.setCodecPreferences(ordered);
      } catch (e) {
        logger.debug('SDPOptimizer', 'setCodecPreferences audio:', e.message);
      }
    } else if (kind === 'video') {
      const preferredMimes = ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];
      const sorted = caps.codecs.slice().sort((a, b) => {
        const idxA = preferredMimes.findIndex(m => a.mimeType.toLowerCase() === m.toLowerCase());
        const idxB = preferredMimes.findIndex(m => b.mimeType.toLowerCase() === m.toLowerCase());
        return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
      });
      try {
        transceiver.setCodecPreferences(sorted);
      } catch (e) {
        logger.debug('SDPOptimizer', 'setCodecPreferences vidéo:', e.message);
      }
    }
  }
}
