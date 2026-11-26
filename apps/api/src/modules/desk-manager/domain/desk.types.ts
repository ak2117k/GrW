/**
 * Desk manager shared contract (docs/superpowers/specs/2026-11-26-desk-manager-design.md).
 * Every desk-manager workstream codes against these names; change them only with every consumer.
 */
import type { DeskManagerConfig } from '../desk-manager.config';

export type DeskMode = 'off' | 'shadow' | 'live';

/** One packet block: present with a value, or unavailable with the reason (never silently missing). */
export interface Block<T> {
  status: 'present' | 'unavailable';
  value?: T;
  reason?: string;
  source: string;
}

export type TradeOrigin = 'manual' | 'signal' | 'reentry' | 'manager' | 'engine' | 'setup' | 'unknown';

export interface ClosedTrade {
  trackerId: string;
  symbol: string;
  underlying: string | null;
  exitAt: Date;
  pnl: number;
  origin: TradeOrigin;
}

export interface DayPnlPath {
  realised: number;
  open: number;
  total: number;
  peak: number;
  drawdownFromPeak: number;
  lossStreak: number;
  closed: ClosedTrade[];
}

export interface GuardState {
  blocked: boolean;
  reasons: string[];
  path: DayPnlPath;
  pausedUntil: Date | null;
  pauseScope: 'all' | string | null;
}

export interface PositionView {
  trackerId: string;
  symbol: string;
  exchange: string;
  underlying: string | null;
  qty: number;
  entry: number;
  ltp: number | null;
  pnl: number | null;
  ageMin: number;
  origin: TradeOrigin;
  held: boolean;
  sentinel: { verdict: string; thesisStatus: string | null; reason: string; invalidation: number | null; at: string } | null;
  managerStop: number | null;
  managerTargets: number[];
}

export interface RecentExit {
  trackerId: string;
  symbol: string;
  underlying: string | null;
  exitAt: string;
  pnl: number;
  lastSentinel: { verdict: string; thesisStatus: string | null; reason: string } | null;
  underlyingAtExit: number | null;
  underlyingNow: number | null;
}

export interface Proposal {
  ref: string;
  kind: 'reading' | 'setup' | 'signal_decision' | 'engine';
  at: string;
  underlying: string | null;
  text: string;
  detail: Record<string, unknown>;
}

export interface InstrumentView {
  underlying: string;
  ltp: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  vwap: number | null;
  trend15m: string | null;
  levels: number[];
  chainWalls: { call: number | null; put: number | null } | null;
  missing: string[];
}

export interface HealthView {
  notCheckableToday: number;
  notCheckableReasons: Record<string, number>;
  feed: string;
  agents: Record<string, string>;
  failedBlocks: string[];
}

export interface Scorecard {
  sessions: number;
  opens: number;
  netPnl: number;
  winRate: number | null;
  best: string[];
  worst: string[];
}

export interface MemoryView {
  today: Array<{ at: string; action: string; underlying: string | null; status: string; result: string | null }>;
  scorecard: Scorecard | null;
  lessons: string[];
}

export interface DeskPacket {
  at: string;
  mode: DeskMode;
  day: Block<{ ist: string; nseMinToClose: number | null; mcxMinToClose: number | null; liveFromIst: string }>;
  pnl: Block<DayPnlPath>;
  guard: Block<GuardState>;
  positions: Block<PositionView[]>;
  recentExits: Block<RecentExit[]>;
  proposals: Block<Proposal[]>;
  instruments: Block<Record<string, InstrumentView>>;
  health: Block<HealthView>;
  memory: Block<MemoryView>;
}

type Why = { reason: string; evidence: string[] };

export type ManagerDecision =
  | ({
      action: 'OPEN';
      underlying: string;
      side: 'BUY_CE' | 'BUY_PE' | 'BUY_FUT';
      strikePolicy: 'ATM' | 'ITM1' | 'OTM1' | number;
      expiryPolicy: 'NEAREST' | 'NEXT';
      entry: { type: 'NOW' | 'ZONE' | 'BREAKOUT'; low?: number; high?: number; triggerAbove?: number; triggerBelow?: number; validMin: number };
      stop: { underlying: number };
      targets: { underlying: number[] };
      proposalRef?: string;
      confidence: 'low' | 'medium' | 'high';
    } & Why)
  | ({ action: 'EXIT' | 'BOOK'; trackerId: string } & Why)
  | ({ action: 'TIGHTEN'; trackerId: string; underlyingStop: number } & Why)
  | ({ action: 'PAUSE_ENTRIES'; scope: 'all' | string; minutes: number } & Why)
  | ({ action: 'RESUME' } & Why)
  | ({ action: 'WATCH'; underlying: string; note: string; recheckMin: number } & Why)
  | ({ action: 'FLAG_DATA_HOLE'; what: string; impact: string } & Why)
  | ({ action: 'NO_ACTION'; proposalRef?: string } & Why);

export type ManagerAction = ManagerDecision['action'];
export const MANAGER_ACTIONS: readonly ManagerAction[] = ['OPEN', 'EXIT', 'BOOK', 'TIGHTEN', 'PAUSE_ENTRIES', 'RESUME', 'WATCH', 'FLAG_DATA_HOLE', 'NO_ACTION'];

export interface ManagerReply {
  summary: string;
  decisions: ManagerDecision[];
}

export interface ActionResult {
  status: 'DONE' | 'PENDING' | 'REFUSED' | 'FAILED' | 'RECORDED';
  detail: string;
  ref?: string;
}

export interface ActionContext {
  runId: string;
  decisionId: string;
  now: Date;
  packet: DeskPacket;
  cfg: DeskManagerConfig;
}

export interface DeskActionsPort {
  execute(d: ManagerDecision, ctx: ActionContext): Promise<ActionResult>;
}
export const DESK_ACTIONS = Symbol('DESK_ACTIONS');

/** Anything that may wake the manager early (debounced by the runner). */
export interface DeskWakePort {
  wake(reason: WakeReason, now?: Date): void;
}
export const DESK_WAKE = Symbol('DESK_WAKE');

export type WakeReason =
  | 'cadence'
  | 'reading_call'
  | 'claim_on_open'
  | 'tracker_opened'
  | 'tracker_closed'
  | 'sentinel_exit'
  | 'sentinel_hold_loss'
  | 'judge_take_skipped'
  | 'guard_change'
  | 'target_crossed'
  | 'watch_recheck'
  | 'manual';

/** Tags on the manager's paper trades (shadow mode) and signal_orders.source on its live orders. */
export const DESK_MANAGER_SOURCE = 'manager';
export const DESK_MANAGER_TAG = 'desk-manager';
export const deskDecisionTag = (decisionId: string) => `desk-decision:${decisionId}`;
