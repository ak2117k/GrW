export type EvidenceKind =
  // Original sources
  | 'VOLUME' | 'HISTORY' | 'OI_CALL' | 'OI_PUT' | 'ROUND'
  // Volume-profile additions (2026-06-28 S/R accuracy R&D)
  | 'POC' | 'VALUE_AREA'
  // Dynamic S/R
  | 'MA' | 'AVWAP'
  // Structure
  | 'GAP' | 'FIB'
  // Options-flow additions
  | 'MAX_PAIN' | 'OI_CHANGE';

export interface EvidenceLevel {
  price: number;
  side: 'resistance' | 'support';
  score: number;          // 0–100
  kinds: EvidenceKind[];
  soft: boolean;
  distancePct: number;
}

export interface LevelCandidate {
  price: number;
  kind: EvidenceKind;
  score: number; // 0–100 (this source's contribution; clusters sum + cap at 100)
}
