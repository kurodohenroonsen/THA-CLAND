/**
 * Types & Contrats de Données P2P Mesh Workspace (2025/2026)
 */

export interface P2PPeer {
  id: string;
  name: string;
  pubkey: string;
  pc?: RTCPeerConnection;
  controlChannel?: RTCDataChannel;
  latencyMs: number;
  lastSeen: number;
  isSelf?: boolean;
}

export interface CRDTMessage {
  id: string;
  channelId: string;
  content: string;
  authorId: string;
  authorName: string;
  authorPubkey: string;
  timestamp: number;
  lamport: number;
  signature?: string;
  attachments?: Array<{
    fileId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    merkleRoot: string;
  }>;
}

export interface DriveCommit {
  commitId: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  chunks: string[];
  merkleRoot: string;
  parents: string[];
  authorId: string;
  timestamp: number;
  signature?: string;
}

export interface MerkleProofStep {
  position: 'left' | 'right';
  hash: string;
}

export interface TelemetryReport {
  rtt: number;
  packetsLost: number;
  jitter: number;
  bitrateKbps: number;
  timestamp: number;
}
