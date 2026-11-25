/** The AI reader's reply contract: what one Telegram post says, and whether live data backs each claim. */

export type ReadKind = 'CALL' | 'UPDATE' | 'INFO' | 'RECAP' | 'NOISE';
export type ReadScope = 'MARKET' | 'SECTOR' | 'INSTRUMENT';
export type ClaimBias = 'BULL' | 'BEAR' | 'NEUTRAL' | 'CAUTION';
export type ClaimVerdict = 'CONFIRMED' | 'CONTRADICTED' | 'UNCLEAR' | 'NOT_CHECKABLE';
export type ClaimHorizon = 'INTRADAY' | 'DAYS' | 'WEEKS';
export type ClaimType = 'DIRECTION' | 'CAUTION' | 'RELATIVE_BREADTH' | 'SECTOR' | 'FLOW' | 'GAP' | 'OTHER';

/** One packet number a verdict rests on. */
export interface Evidence {
  fact: string;
  value: string;
  source: string;
}

export interface Claim {
  /** The claim in plain words ("stocks weak, index strong"). */
  text: string;
  /** MARKET | an uppercase sector name | the canonical uppercase underlying (validation trims + uppercases). */
  subject: string;
  bias: ClaimBias;
  horizon: ClaimHorizon;
  verdict: ClaimVerdict;
  /** Must cite packet numbers for CONFIRMED / CONTRADICTED. */
  evidence: Evidence[];
  /** Set by validation when the model gave CONFIRMED/CONTRADICTED with no evidence (downgraded to UNCLEAR). */
  evidenceMissing?: boolean;
  claimType: ClaimType;
}

export interface ReaderCall {
  underlying: string;
  side: 'BUY' | 'SELL';
  optionType: 'CE' | 'PE' | null;
  strike: number | null;
  entryLow: number | null;
  entryHigh: number | null;
  stopLoss: number | null;
  targets: number[];
}

export interface ReaderReply {
  kind: ReadKind;
  scope: ReadScope;
  claims: Claim[];
  call: ReaderCall | null;
  summary: string;
}

export const READ_KINDS: readonly ReadKind[] = ['CALL', 'UPDATE', 'INFO', 'RECAP', 'NOISE'];
export const READ_SCOPES: readonly ReadScope[] = ['MARKET', 'SECTOR', 'INSTRUMENT'];
export const CLAIM_BIASES: readonly ClaimBias[] = ['BULL', 'BEAR', 'NEUTRAL', 'CAUTION'];
export const CLAIM_VERDICTS: readonly ClaimVerdict[] = ['CONFIRMED', 'CONTRADICTED', 'UNCLEAR', 'NOT_CHECKABLE'];
export const CLAIM_HORIZONS: readonly ClaimHorizon[] = ['INTRADAY', 'DAYS', 'WEEKS'];
export const CLAIM_TYPES: readonly ClaimType[] = ['DIRECTION', 'CAUTION', 'RELATIVE_BREADTH', 'SECTOR', 'FLOW', 'GAP', 'OTHER'];

const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] } as const;

/** Strict JSON schema for the reader's reply (output_config.format). Mirrors ReaderReply. */
export const READER_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'scope', 'claims', 'call', 'summary'],
  properties: {
    kind: { type: 'string', enum: [...READ_KINDS] },
    scope: { type: 'string', enum: [...READ_SCOPES] },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'subject', 'bias', 'horizon', 'claimType', 'verdict', 'evidence'],
        properties: {
          text: { type: 'string' },
          subject: { type: 'string' },
          bias: { type: 'string', enum: [...CLAIM_BIASES] },
          horizon: { type: 'string', enum: [...CLAIM_HORIZONS] },
          claimType: { type: 'string', enum: [...CLAIM_TYPES] },
          verdict: { type: 'string', enum: [...CLAIM_VERDICTS] },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['fact', 'value', 'source'],
              properties: {
                fact: { type: 'string' },
                value: { type: 'string' },
                source: { type: 'string' },
              },
            },
          },
        },
      },
    },
    call: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['underlying', 'side', 'optionType', 'strike', 'entryLow', 'entryHigh', 'stopLoss', 'targets'],
          properties: {
            underlying: { type: 'string' },
            side: { type: 'string', enum: ['BUY', 'SELL'] },
            optionType: { anyOf: [{ type: 'string', enum: ['CE', 'PE'] }, { type: 'null' }] },
            strike: nullableNumber,
            entryLow: nullableNumber,
            entryHigh: nullableNumber,
            stopLoss: nullableNumber,
            targets: { type: 'array', items: { type: 'number' } },
          },
        },
      ],
    },
    summary: { type: 'string' },
  },
} as const;
