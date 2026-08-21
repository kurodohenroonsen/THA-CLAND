/**
 * did-resolver.js - Résolveur Déterministe Local de Documents DID (W3C DID Core 1.0)
 * P2P Mesh Workspace (Pass 2 - 2026)
 */

import { Multibase, Multicodec } from './did-codec.js';

export class DIDDocumentResolver {
  /**
   * Résolution déterministe d'un DID en Document DID W3C conforme sans appel réseau
   * @param {string} did
   * @returns {{ didDocument: object, didDocumentMetadata?: object, didResolutionMetadata?: object }}
   */
  static resolve(did) {
    if (!did || typeof did !== 'string') {
      throw new TypeError('DID invalide');
    }

    if (did.startsWith('did:key:')) {
      return DIDDocumentResolver.resolveDidKey(did);
    }
    if (did.startsWith('did:peer:0')) {
      return DIDDocumentResolver.resolveDidPeer0(did);
    }
    if (did.startsWith('did:peer:2')) {
      return DIDDocumentResolver.resolveDidPeer2(did);
    }

    throw new Error(`Méthode DID non prise en charge: ${did}`);
  }

  /**
   * Résout un did:key (Support P-256 et Ed25519)
   */
  static resolveDidKey(did) {
    const multibaseKey = did.replace('did:key:', '');
    const decoded = Multibase.decodeBase58Btc(multibaseKey);

    let keyType = 'Multikey';
    let curve = '';
    let rawKey = null;

    // Détection P-256 (0x1200 -> [0x80, 0x24])
    if (decoded[0] === 0x80 && decoded[1] === 0x24) {
      curve = 'P-256';
      rawKey = decoded.slice(2);
    } 
    // Détection Ed25519 (0xed01 -> [0xed, 0x01])
    else if (decoded[0] === 0xed && decoded[1] === 0x01) {
      curve = 'Ed25519';
      rawKey = decoded.slice(2);
    } else {
      throw new Error('Type de clé multicodec inconnu dans did:key');
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
      authentication: [keyId],
      assertionMethod: [keyId],
      capabilityInvocation: [keyId],
      capabilityDelegation: [keyId]
    };

    return {
      didDocument,
      didDocumentMetadata: {
        deactivated: false,
        canonicalId: did
      },
      didResolutionMetadata: {
        contentType: 'application/did+ld+json'
      }
    };
  }

  /**
   * Résout un did:peer:0 (identique à did:key)
   */
  static resolveDidPeer0(did) {
    const multibaseKey = did.replace('did:peer:0', '');
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
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: multibaseKey
        }
      ],
      authentication: [keyId],
      assertionMethod: [keyId]
    };

    return { didDocument };
  }

  /**
   * Résout un did:peer:2 (Multi-clés Signing + Encryption + Service Endpoint)
   * Format : did:peer:2 .V<mbKey> .E<mbEncKey> .S<b64Service>
   */
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

    const didDocument = {
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
    };

    return { didDocument };
  }

  /**
   * Construit un did:peer:2 à partir des clés publiques et du salon WebRTC
   */
  static createDidPeer2({ signingMultibase, encryptionMultibase = null, signalingEndpoint = null }) {
    let did = `did:peer:2.V${signingMultibase}`;
    if (encryptionMultibase) {
      did += `.E${encryptionMultibase}`;
    }
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
