/**
 * The setup AI's reply contract (spec §5.3 + "Settled after the builder check"): from one verified channel
 * claim, either NO_TRADE with a reason, or one intraday option BUY whose levels (entry zone / trigger, SL,
 * targets) are UNDERLYING prices. v1 is option buys only — the schema allows no cash, future or sell.
 */

export type SetupDecision = 'NO_TRADE' | 'SETUP';
/** LIMIT_PULLBACK waits for the underlying to come back into [low, high]; BREAKOUT_TRIGGER waits for a 15m close beyond `trigger`; MARKET_NOW enters at the current price. */
export type SetupEntryType = 'LIMIT_PULLBACK' | 'BREAKOUT_TRIGGER' | 'MARKET_NOW';
/** Row lifecycle in `ai_setups.status`. */
export type AiSetupStatus = 'NO_TRADE' | 'PENDING' | 'EXPIRED' | 'FILLED' | 'EXITED' | 'SKIPPED';

/** One packet number the setup rests on (same rule as the reader: every cited value must be in the packet). */
export interface SetupEvidence {
  fact: string;
  value: string;
  /** Dotted packet path of the block the value came from ("bars15m", "quote"). */
  source: string;
}

export interface SetupInstrument {
  kind: 'OPT';
  /** The underlying, canonical uppercase ("DABUR", "NIFTY", "CRUDEOIL"). */
  symbol: string;
  strike: number;
  /** CE = bullish view on the underlying, PE = bearish. */
  optionType: 'CE' | 'PE';
  /** 'YYYY-MM-DD'. */
  expiry: string;
}

export interface SetupEntry {
  type: SetupEntryType;
  /** Underlying zone; for BREAKOUT_TRIGGER / MARKET_NOW low = high = the expected fill. */
  low: number;
  high: number;
  /** Underlying price a 15m close must pass (BREAKOUT_TRIGGER only; null otherwise). */
  trigger: number | null;
  /** The packet level the entry is anchored to (day high, prior high, 15m swing, VWAP). Required for BREAKOUT_TRIGGER / MARKET_NOW. */
  level: number | null;
}

export interface SetupPlan {
  instrument: SetupInstrument;
  side: 'BUY';
  entry: SetupEntry;
  /** Underlying stop. */
  sl: number;
  /** Underlying targets, nearest first. */
  targets: number[];
  /** IST 'HH:mm' the pending entry / open trade lives until (≤ 15:15 NSE/BSE, ≤ 23:00 MCX). */
  validUntil: string;
  /** 0–100. */
  confidence: number;
  evidence: SetupEvidence[];
}

export interface SetupReply {
  decision: SetupDecision;
  /** Why — for NO_TRADE the reason it is not a trade; for SETUP the thesis with its numbers. */
  reason: string;
  /** Present iff decision = SETUP. */
  setup: SetupPlan | null;
}

export const SETUP_DECISIONS: readonly SetupDecision[] = ['NO_TRADE', 'SETUP'];
export const SETUP_ENTRY_TYPES: readonly SetupEntryType[] = ['LIMIT_PULLBACK', 'BREAKOUT_TRIGGER', 'MARKET_NOW'];
export const AI_SETUP_STATUSES: readonly AiSetupStatus[] = ['NO_TRADE', 'PENDING', 'EXPIRED', 'FILLED', 'EXITED', 'SKIPPED'];

const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] } as const;

/** Strict JSON schema for the setup reply (output_config.format). Vertex rules: no type arrays (nullables are anyOf), closed objects requiring every property, no numeric / length constraints. Mirrors SetupReply. */
export const SETUP_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason', 'setup'],
  properties: {
    decision: { type: 'string', enum: [...SETUP_DECISIONS] },
    reason: { type: 'string' },
    setup: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['instrument', 'side', 'entry', 'sl', 'targets', 'validUntil', 'confidence', 'evidence'],
          properties: {
            instrument: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'symbol', 'strike', 'optionType', 'expiry'],
              properties: {
                kind: { type: 'string', enum: ['OPT'] },
                symbol: { type: 'string' },
                strike: { type: 'number' },
                optionType: { type: 'string', enum: ['CE', 'PE'] },
                expiry: { type: 'string' },
              },
            },
            side: { type: 'string', enum: ['BUY'] },
            entry: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'low', 'high', 'trigger', 'level'],
              properties: {
                type: { type: 'string', enum: [...SETUP_ENTRY_TYPES] },
                low: { type: 'number' },
                high: { type: 'number' },
                trigger: nullableNumber,
                level: nullableNumber,
              },
            },
            sl: { type: 'number' },
            targets: { type: 'array', items: { type: 'number' } },
            validUntil: { type: 'string' },
            confidence: { type: 'number' },
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
      ],
    },
  },
} as const;
