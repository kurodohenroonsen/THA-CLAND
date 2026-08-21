/**
 * did-resolver.js - Résolveur Universel W3C DID Core 1.0 & Import Web Crypto API
 * Supporte : did:key (P-256, Ed25519, X25519, secp256k1), did:peer:0, did:peer:2
 */

import { Multibase, Multicodec } from './did-codec.js';

export class DIDUniversalResolver {
  /**
   * Résout tout DID souverain local en Document DID W3C conforme
   */
  static resolve(did) {
    if (!did || typeof did !== 'string') {
      throw new TypeError('DID invalide');
    }

    if (did.startsWith('did:key:')) {
      return DIDUniversalResolver.resolveDidKey(did);
    }
    if (did.startsWith('did:peer:0')) {
      return DIDUniversalResolver.resolveDidPeer0(did);
    }
    if (did.startsWith('did:peer:2')) {
      return DIDUniversalResolver.resolveDidPeer2(did);
    }

    throw new Error(`Méthode DID non prise en charge: ${did}`);
  }

  /**
   * Résout un did:key et extrait ses métadonnées cryptographiques
   */
  static resolveDidKey(did) {
    const multibaseKey = did.replace('did:key:', '');
    const decodedBytes = Multibase.decodeBase58Btc(multibaseKey);
    const { code, rawKey } = Multicodec.decodeVarint(decodedBytes);

    let curve = '';
    let keyType = 'Multikey';
    let isSigning = true;
    let isAgreement = false;

    switch (code) {
      case Multicodec.CODE_P256:
        curve = 'P-256';
        break;
      case Multicodec.CODE_ED25519:
        curve = 'Ed25519';
        break;
      case Multicodec.CODE_X25519:
        curve = 'X25519';
        isSigning = false;
        isAgreement = true;
        break;
      case Multicodec.CODE_SECP256K1:
        curve = 'secp256k1';
        break;
      default:
        throw new Error(`Type de clé multicodec inconnu: 0x${code.toString(16)}`);
    }

    const keyId = `${did}#${multibaseKey}`;

    const didDocument = {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1'
      ],
      id: did,
      verificationMethod: [
        {
          id: keyId,
          type: keyType,
          controller: did,
          publicKeyMultibase: multibaseKey
        }
      ],
      authentication: isSigning ? [keyId] : [],
      assertionMethod: isSigning ? [keyId] : [],
      capabilityInvocation: isSigning ? [keyId] : [],
      capabilityDelegation: isSigning ? [keyId] : [],
      keyAgreement: isAgreement ? [keyId] : []
    };

    return {
      didDocument,
      keyDetails: { curve, code, rawKey, isSigning, isAgreement },
      didDocumentMetadata: { deactivated: false, canonicalId: did },
      didResolutionMetadata: { contentType: 'application/did+ld+json' }
    };
  }

  /**
   * Importe directement la clé publique d'un DID en objet CryptoKey Web Crypto API
   */
  static async resolveToCryptoKey(did) {
    const { keyDetails } = DIDUniversalResolver.resolve(did);

    if (keyDetails.curve === 'P-256') {
      const uncompressed65 = Multicodec.decompressP256(keyDetails.rawKey);
      const jwk = Multicodec.p256UncompressedToJWK(uncompressed65);
      return await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );
    }

    if (keyDetails.curve === 'Ed25519') {
      try {
        return await crypto.subtle.importKey(
          'raw',
          keyDetails.rawKey,
          { name: 'Ed25519' },
          false,
          ['verify']
        );
      } catch {
        throw new Error('Ed25519 Web Crypto API non disponible sur cet environnement');
      }
    }

    throw new Error(`Import CryptoKey non supporté pour la courbe: ${keyDetails.curve}`);
  }

  static resolveDidPeer0(did) {
    const multibaseKey = did.replace('did:peer:0', '');
    return DIDUniversalResolver.resolveDidKey(`did:key:${multibaseKey}`);
  }

  static resolveDidPeer2(did) {
    const parts = did.split('.');
    if (parts[0] !== 'did:peer:2') throw new Error('Préfixe did:peer:2 invalide');

    const verificationMethods = [];
    const authentication = [];
    const assertionMethod = [];
    const keyAgreement = [];
    const services = [];

    let keyCounter = 1;

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const prefix = part[0];
      const value = part.slice(1);

      if (prefix === 'V') {
        const keyId = `${did}#key-${keyCounter++}`;
        verificationMethods.push({
          id: keyId,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: value
        });
        authentication.push(keyId);
        assertionMethod.push(keyId);
      } else if (prefix === 'E') {
        const keyId = `${did}#key-${keyCounter++}`;
        verificationMethods.push({
          id: keyId,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: value
        });
        keyAgreement.push(keyId);
      } else if (prefix === 'S') {
        try {
          const rawJson = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
          const parsed = JSON.parse(rawJson);
          services.push({
            id: `${did}#service-${services.length + 1}`,
            type: parsed.t || 'P2PMeshSignalingService',
            serviceEndpoint: parsed.s || parsed
          });
        } catch {
          // Ignorer erreur de décodage service
        }
      }
    }

    return {
      didDocument: {
        '@context': [
          'https://www.w3.org/ns/did/v1',
          'https://w3id.org/security/multikey/v1'
        ],
        id: did,
        verificationMethod: verificationMethods,
        authentication,
        assertionMethod,
        keyAgreement,
        service: services.length > 0 ? services : undefined
      }
    };
  }

  static createDidPeer2({ signingMultibase, encryptionMultibase = null, signalingEndpoint = null }) {
    let did = `did:peer:2.V${signingMultibase}`;
    if (encryptionMultibase) did += `.E${encryptionMultibase}`;
    if (signalingEndpoint) {
      const serviceObj = { t: 'dm', s: signalingEndpoint };
      const b64Url = btoa(JSON.stringify(serviceObj))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      did += `.S${b64Url}`;
    }
    return did;
  }
}

// Alias pour compatibilité descendante
export const DIDDocumentResolver = DIDUniversalResolver;
