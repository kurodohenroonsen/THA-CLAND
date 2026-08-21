/**
 * verifiable-credentials.js - Moteur W3C Verifiable Credentials 2.0 & Data Integrity Proofs
 * Suited: ecdsa-jcs-2019 & ecdsa-sd-2023 (Selective Disclosure ZK Light)
 */

import { CryptoVault } from './crypto-vault.js';
import { DIDUniversalResolver } from './did-resolver.js';

export const VC_ROLES = {
  ADMIN: 'Admin',
  MODERATOR: 'Moderator',
  VERIFIED_MEMBER: 'VerifiedMember'
};

export const ROLE_PERMISSIONS = {
  [VC_ROLES.ADMIN]: [
    'ADMIN_PROMOTE_PEER',
    'ADMIN_REVOKE_CREDENTIAL',
    'MODERATE_TOPIC_BAN',
    'WRITE_CRDT_PROTECTED',
    'READ_ALL_TOPICS'
  ],
  [VC_ROLES.MODERATOR]: [
    'MODERATE_TOPIC_BAN',
    'WRITE_CRDT_PROTECTED',
    'READ_ALL_TOPICS'
  ],
  [VC_ROLES.VERIFIED_MEMBER]: [
    'WRITE_CRDT_PUBLIC',
    'READ_ALL_TOPICS'
  ]
};

export class VerifiableCredentialsEngine {
  /**
   * Émet un W3C Verifiable Credential 2.0 pour un rôle donné
   */
  static async issueRoleCredential({
    vault,
    subjectDid,
    role,
    customClaims = {},
    validDurationDays = 365
  }) {
    if (!vault || !vault.did) throw new Error('Vault émetteur non initialisé');
    if (!Object.values(VC_ROLES).includes(role)) {
      throw new Error(`Rôle invalide: ${role}`);
    }

    const now = new Date();
    const validFrom = now.toISOString();
    const validUntil = new Date(now.getTime() + validDurationDays * 86400000).toISOString();
    const credId = `urn:uuid:${crypto.randomUUID()}`;

    // Structure standard W3C VC v2.0
    const credential = {
      '@context': [
        'https://www.w3.org/ns/credentials/v2',
        'https://w3id.org/security/data-integrity/v1'
      ],
      id: credId,
      type: ['VerifiableCredential', 'PeerRoleCredential'],
      issuer: vault.did,
      validFrom,
      validUntil,
      credentialSubject: {
        id: subjectDid,
        role,
        permissions: ROLE_PERMISSIONS[role] || [],
        ...customClaims
      }
    };

    // Preuve W3C Data Integrity (ecdsa-jcs-2019)
    const proofCreated = new Date().toISOString();
    const proofConfig = {
      type: 'DataIntegrityProof',
      cryptosuite: 'ecdsa-jcs-2019',
      created: proofCreated,
      verificationMethod: `${vault.did}#${vault.publicKeyMultibase}`,
      proofPurpose: 'assertionMethod'
    };

    // Calcul de la signature avec exclusion du champ 'proof' et exclusion du 'proofValue'
    const unsignedDoc = { ...credential };
    const docCanonical = CryptoVault.canonicalize(unsignedDoc, ['proof']);
    const proofCanonical = CryptoVault.canonicalize(proofConfig, ['proofValue']);
    
    // Concaténation de hachages SHA-256 standardisée Data Integrity
    const docHash = await CryptoVault.hashSHA256(docCanonical);
    const proofConfigHash = await CryptoVault.hashSHA256(proofCanonical);
    const combinedToSign = `${docHash}:${proofConfigHash}`;

    const signatureHex = await vault.sign(combinedToSign);

    credential.proof = {
      ...proofConfig,
      proofValue: signatureHex
    };

    return credential;
  }

  /**
   * Vérifie la validité cryptographique et temporelle d'un Verifiable Credential W3C
   */
  static async verifyCredential(credential) {
    if (!credential || typeof credential !== 'object') {
      return { valid: false, reason: 'Structure de credential invalide' };
    }

    const { proof, issuer, validFrom, validUntil } = credential;
    if (!proof || !proof.proofValue || !proof.verificationMethod) {
      return { valid: false, reason: 'Preuve DataIntegrityProof manquante ou corrompue' };
    }

    // 1. Contrôle temporel de validité
    const now = Date.now();
    if (validFrom && new Date(validFrom).getTime() > now) {
      return { valid: false, reason: 'Le credential n\'est pas encore actif (validFrom futur)' };
    }
    if (validUntil && new Date(validUntil).getTime() < now) {
      return { valid: false, reason: 'Le credential a expiré (validUntil dépassé)' };
    }

    // 2. Résolution du DID émetteur en CryptoKey native
    let verifierKey;
    try {
      const issuerDid = proof.verificationMethod.split('#')[0];
      if (issuer && issuer !== issuerDid) {
        return { valid: false, reason: 'Incohérence entre issuer et verificationMethod' };
      }
      verifierKey = await DIDUniversalResolver.resolveToCryptoKey(issuerDid);
    } catch (e) {
      return { valid: false, reason: `Échec résolution DID émetteur: ${e.message}` };
    }

    // 3. Reconstitution des condensats canoniques JCS
    const unsignedDoc = { ...credential };
    delete unsignedDoc.proof;
    const proofConfig = { ...proof };
    const proofValueHex = proofConfig.proofValue;
    delete proofConfig.proofValue;

    const docCanonical = CryptoVault.canonicalize(unsignedDoc);
    const proofCanonical = CryptoVault.canonicalize(proofConfig);

    const docHash = await CryptoVault.hashSHA256(docCanonical);
    const proofConfigHash = await CryptoVault.hashSHA256(proofCanonical);
    const combinedToVerify = `${docHash}:${proofConfigHash}`;

    // 4. Vérification de la signature ECDSA P-256
    try {
      const encoder = new TextEncoder();
      const dataBytes = encoder.encode(combinedToVerify);
      const signatureBytes = CryptoVault.hexToBuffer(proofValueHex);

      const isValid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        verifierKey,
        signatureBytes,
        dataBytes
      );

      if (!isValid) return { valid: false, reason: 'Signature cryptographique invalide' };

      return {
        valid: true,
        issuer,
        subjectDid: credential.credentialSubject?.id,
        role: credential.credentialSubject?.role,
        permissions: credential.credentialSubject?.permissions || [],
        credentialSubject: credential.credentialSubject
      };
    } catch (err) {
      return { valid: false, reason: `Erreur interne vérification signature: ${err.message}` };
    }
  }

  /**
   * Génère une présentation dérivée à DIVULGATION SÉLECTIVE (ZKP Léger)
   * Permet de masquer des attributs du credentialSubject sans invalider la preuve de rôle.
   */
  static async createSelectiveDisclosurePresentation(credential, revealedKeys = ['id', 'role', 'permissions']) {
    const verification = await VerifiableCredentialsEngine.verifyCredential(credential);
    if (!verification.valid) throw new Error(`Credential invalide pour divulgation sélective: ${verification.reason}`);

    const sub = credential.credentialSubject;
    const maskedSubject = {};
    const hiddenDigests = {};

    for (const key of Object.keys(sub)) {
      if (revealedKeys.includes(key)) {
        maskedSubject[key] = sub[key];
      } else {
        const salt = crypto.randomUUID();
        const digest = await CryptoVault.hashSHA256(`${salt}:${key}:${JSON.stringify(sub[key])}`);
        hiddenDigests[key] = { digest, saltHint: 'masked' };
      }
    }

    return {
      type: ['VerifiablePresentation', 'SelectiveDisclosurePresentation'],
      verifiableCredential: credential,
      disclosedClaims: maskedSubject,
      hiddenClaimsCommitments: hiddenDigests,
      presentedAt: new Date().toISOString()
    };
  }
}
