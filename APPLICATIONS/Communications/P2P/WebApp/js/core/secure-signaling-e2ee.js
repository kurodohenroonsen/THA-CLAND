/**
 * @file secure-signaling-e2ee.js
 * @description Moteur de Signalisation Sécurisée E2EE, Anti-MitM & Bootstrap Hors-Bande (Pass 4)
 * Conforme : RFC 8827, RFC 5763, RFC 6189, Matrix MSC3917, BCR-2020-005.
 */

export class SDPSecureSignaling {
  static SAS_EMOJIS = [
    { emoji: '🐶', name: 'Chien' },      { emoji: '🐱', name: 'Chat' },
    { emoji: '🦁', name: 'Lion' },       { emoji: '🐴', name: 'Cheval' },
    { emoji: '🦄', name: 'Licorne' },    { emoji: '🐷', name: 'Cochon' },
    { emoji: '🐘', name: 'Éléphant' },   { emoji: '🐼', name: 'Panda' },
    { emoji: '🐓', name: 'Coq' },        { emoji: '🦉', name: 'Chouette' },
    { emoji: '🐸', name: 'Grenouille' }, { emoji: '🐙', name: 'Pieuvre' },
    { emoji: '🦋', name: 'Papillon' },   { emoji: '🌸', name: 'Fleur' },
    { emoji: '🌲', name: 'Arbre' },      { emoji: '🌵', name: 'Cactus' },
    { emoji: '🍄', name: 'Champignon' }, { emoji: '🌍', name: 'Terre' },
    { emoji: '🌙', name: 'Lune' },       { emoji: '⭐', name: 'Étoile' },
    { emoji: '🔥', name: 'Feu' },        { emoji: '⚡', name: 'Éclair' },
    { emoji: '🌈', name: 'Arc-en-ciel' },{ emoji: '🎈', name: 'Ballon' },
    { emoji: '🎉', name: 'Fête' },       { emoji: '🎨', name: 'Palette' },
    { emoji: '🎸', name: 'Guitare' },    { emoji: '🚀', name: 'Fusée' },
    { emoji: '⚓', name: 'Ancre' },      { emoji: '💎', name: 'Diamant' },
    { emoji: '🔑', name: 'Clé' },        { emoji: '🔔', name: 'Cloche' },
    { emoji: '👑', name: 'Couronne' },   { emoji: '🎩', name: 'Chapeau' },
    { emoji: '👓', name: 'Lunettes' },   { emoji: '🏆', name: 'Trophée' },
    { emoji: '⚽', name: 'Ballon-foot' },{ emoji: '🍎', name: 'Pomme' },
    { emoji: '🍓', name: 'Fraise' },     { emoji: '🍕', name: 'Pizza' },
    { emoji: '🍰', name: 'Gâteau' },     { emoji: '☕', name: 'Café' },
    { emoji: '🚗', name: 'Voiture' },    { emoji: '✈️', name: 'Avion' },
    { emoji: '⛵', name: 'Bateau' },     { emoji: '🚲', name: 'Vélo' },
    { emoji: '🏠', name: 'Maison' },     { emoji: '🏰', name: 'Château' },
    { emoji: '📱', name: 'Téléphone' },  { emoji: '💻', name: 'Ordinateur' },
    { emoji: '📷', name: 'Appareil-photo'},{ emoji: '📺', name: 'Télévision' },
    { emoji: '📻', name: 'Radio' },      { emoji: '⏰', name: 'Horloge' },
    { emoji: '🕯️', name: 'Bougie' },     { emoji: '💡', name: 'Ampoule' },
    { emoji: '📖', name: 'Livre' },      { emoji: '✉️', name: 'Lettre' },
    { emoji: '🎁', name: 'Cadeau' },     { emoji: '🛡️', name: 'Bouclier' },
    { emoji: '⚔️', name: 'Épée' },       { emoji: '🏹', name: 'Arc' },
    { emoji: '🛸', name: 'Soucoupe' },   { emoji: '🤖', name: 'Robot' }
  ];

  static extractDtlsFingerprint(sdp) {
    if (!sdp || typeof sdp !== 'string') {
      throw new Error('Description SDP invalide ou manquante');
    }
    const match = sdp.match(/^a=fingerprint:\s*([a-zA-Z0-9_-]+)\s+([0-9A-Fa-f:]+)/m);
    if (!match) {
      throw new Error('Aucun attribut a=fingerprint valide détecté dans le SDP');
    }
    const algorithm = match[1].toLowerCase();
    const fingerprint = match[2].toUpperCase().trim();
    return {
      algorithm,
      fingerprint,
      rawAttribute: `a=fingerprint:${algorithm} ${fingerprint}`
    };
  }

  static async createSignedBinding(vault, sdp, sdpType, targetPeerId = null) {
    const { algorithm, fingerprint } = SDPSecureSignaling.extractDtlsFingerprint(sdp);
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const timestamp = Date.now();

    const bindingPayload = {
      type: 'SDP_IDENTITY_BINDING_V1',
      authorPubkey: vault.publicKeyHex,
      authorDid: vault.did,
      signalingPeerId: vault.peerIdHex,
      targetPeerId: targetPeerId || 'broadcast',
      sdpType: sdpType,
      dtlsFingerprint: `${algorithm}:${fingerprint}`,
      timestamp,
      nonce
    };

    const signature = await vault.sign(bindingPayload);
    return {
      ...bindingPayload,
      signature
    };
  }

  static async verifySignedBinding(binding, sdp, maxAgeMs = 35000) {
    if (!binding || !binding.signature || !binding.authorPubkey || !binding.dtlsFingerprint) {
      return { valid: false, reason: 'Structure de binding incomplète ou corrompue' };
    }

    const now = Date.now();
    if (Math.abs(now - binding.timestamp) > maxAgeMs) {
      return { valid: false, reason: `Timestamp expiré (${Math.round(Math.abs(now - binding.timestamp) / 1000)}s)` };
    }

    try {
      const extracted = SDPSecureSignaling.extractDtlsFingerprint(sdp);
      const expectedNormalized = `${extracted.algorithm}:${extracted.fingerprint}`;
      if (binding.dtlsFingerprint.toUpperCase() !== expectedNormalized.toUpperCase()) {
        return { valid: false, reason: 'L\'empreinte DTLS du SDP ne correspond pas au Binding signé' };
      }
    } catch (err) {
      return { valid: false, reason: `Échec extraction empreinte SDP: ${err.message}` };
    }

    const { CryptoVault } = await import('./crypto-vault.js');
    const isSigValid = await CryptoVault.verify(binding, binding.signature, binding.authorPubkey);
    if (!isSigValid) {
      return { valid: false, reason: 'Signature ECDSA invalide (altération suspectée)' };
    }

    return { valid: true, authorDid: binding.authorDid, authorPubkey: binding.authorPubkey };
  }

  static async computeSessionSAS({
    localPubkeyHex,
    remotePubkeyHex,
    localDtlsFingerprint,
    remoteDtlsFingerprint,
    topicHex
  }) {
    if (!localPubkeyHex || !remotePubkeyHex || !localDtlsFingerprint || !remoteDtlsFingerprint) {
      throw new Error('Paramètres cryptographiques insuffisants pour le calcul SAS');
    }

    const sortedPubkeys = [localPubkeyHex.toLowerCase(), remotePubkeyHex.toLowerCase()].sort();
    const sortedFingerprints = [localDtlsFingerprint.toLowerCase(), remoteDtlsFingerprint.toLowerCase()].sort();
    const topic = (topicHex || '').toLowerCase();

    const ikmString = `${sortedPubkeys[0]}|${sortedPubkeys[1]}|${sortedFingerprints[0]}|${sortedFingerprints[1]}|${topic}`;
    const encoder = new TextEncoder();
    const ikmBytes = encoder.encode(ikmString);

    const baseKey = await crypto.subtle.importKey(
      'raw',
      ikmBytes,
      { name: 'HKDF' },
      false,
      ['deriveBits']
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode('PMESH_WEBRTC_SAS_V1'),
        info: encoder.encode('session-short-authentication-string')
      },
      baseKey,
      256
    );

    const hashBytes = new Uint8Array(derivedBits);

    const blocks = [];
    for (let b = 0; b < 12; b++) {
      const offset = b * 2;
      const val = ((hashBytes[offset] << 8) | hashBytes[offset + 1]) >>> 0;
      blocks.push((val % 100000).toString().padStart(5, '0'));
    }
    const numericCode = `${blocks.slice(0, 6).join(' ')}\n${blocks.slice(6, 12).join(' ')}`;

    const emojis = [];
    for (let i = 0; i < 7; i++) {
      const rawByte = hashBytes[24 + i];
      const emojiIdx = rawByte % SDPSecureSignaling.SAS_EMOJIS.length;
      emojis.push(SDPSecureSignaling.SAS_EMOJIS[emojiIdx]);
    }

    return {
      numericCode,
      emojis,
      emojiString: emojis.map(e => e.emoji).join(' '),
      emojiLabels: emojis.map(e => e.name).join(' - '),
      sessionKeyFingerprint: Array.from(hashBytes.slice(0, 8))
        .map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
    };
  }

  static compactSDP(sdp) {
    if (!sdp) return '';
    return sdp
      .split('\r\n')
      .filter(line => {
        if (!line) return false;
        if (line.startsWith('a=extmap:')) return false;
        if (line.startsWith('a=rtcp-fb:')) return false;
        if (line.startsWith('a=fmtp:') && !line.includes('opus')) return false;
        if (line.startsWith('a=ssrc:')) return false;
        return true;
      })
      .join('\n');
  }

  static createMultipartQR(payload, maxChunkSize = 180) {
    const jsonStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const totalChunks = Math.ceil(jsonStr.length / maxChunkSize);
    const sessionId = Math.random().toString(36).substring(2, 8);
    const frames = [];

    for (let i = 0; i < totalChunks; i++) {
      const chunk = jsonStr.substring(i * maxChunkSize, (i + 1) * maxChunkSize);
      frames.push(`ur:pmesh-sdp/${sessionId}/${i + 1}-${totalChunks}/${chunk}`);
    }

    return {
      sessionId,
      totalChunks,
      frames
    };
  }

  static assembleMultipartQR(scannedFramesCollector, newFrame) {
    const match = newFrame.match(/^ur:pmesh-sdp\/([a-zA-Z0-9]+)\/(\d+)-(\d+)\/(.*)$/);
    if (!match) return null;

    const [, sessionId, partStr, totalStr, data] = match;
    const part = parseInt(partStr, 10);
    const total = parseInt(totalStr, 10);

    if (!scannedFramesCollector.has(sessionId)) {
      scannedFramesCollector.set(sessionId, { total, parts: new Map() });
    }

    const session = scannedFramesCollector.get(sessionId);
    session.parts.set(part, data);

    if (session.parts.size === session.total) {
      let assembled = '';
      for (let i = 1; i <= session.total; i++) {
        assembled += session.parts.get(i) || '';
      }
      scannedFramesCollector.delete(sessionId);
      try {
        return JSON.parse(assembled);
      } catch {
        return assembled;
      }
    }

    return {
      progress: Math.round((session.parts.size / session.total) * 100),
      received: session.parts.size,
      total: session.total
    };
  }
}
