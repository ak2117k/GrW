import type { ActionContext, ActionResult, GuardState } from '../domain/desk.types';

/**
 * The ports the desk manager's actions (OPEN / pending entries) read through. Each is wired in the module
 * (Task 8); a spec passes fakes. Nothing here places an order.
 */

/** An instrument the actions price (the underlying's line, or the contract). */
export interface DeskRef {
  exchange: string;
  token: string;
  symbol: string;
}

/**
 * Market reads over the owner's session (quotes, master, venue clock; never an order). Shaped as a subset of
 * ai-setups SetupWatchMarket so the live LiveSetupWatchMarket can serve it.
 */
export const DESK_MARKET = Symbol('DESK_MARKET');
export interface DeskMarket {
  /** The underlying's priced line (index / NSE cash / MCX front future); null = none. May throw (not loaded yet). */
  underlyingRef(underlying: string, now: Date): Promise<DeskRef | null>;
  /** Fresh LTPs keyed EXCHANGE:token; absent = no fresh price. */
  ltps(refs: readonly DeskRef[], now: Date): Promise<Map<string, number>>;
  /** The Angel instrument master rows. */
  master(): Promise<readonly unknown[] | null>;
  isOpen(exchange: string, now: Date): boolean;
  minutesToClose(exchange: string, now: Date): number | null;
}

/** Optional: the option's delta from the captured chain / greeks; null = not captured (policy default used). */
export const DESK_OPTION_DELTA = Symbol('DESK_OPTION_DELTA');
export interface DeskOptionDelta {
  delta(c: { exchange: string; token: string; tradingsymbol: string; underlying: string }, now: Date): Promise<number | null>;
}

/** The desk guard (Task 1 DeskGuardService satisfies it). */
export const DESK_OPEN_GUARD = Symbol('DESK_OPEN_GUARD');
export interface DeskGuardPort {
  check(userId: string, source: 'signal' | 'reentry' | 'manager', underlying: string | null, now: Date): Promise<GuardState>;
  pause(userId: string, scope: 'all' | string, minutes: number, now: Date): Promise<unknown>;
  resume(userId: string, now: Date): Promise<unknown>;
}

/**
 * The runner's health (Task 4 ManagerRunnerService.opensBlocked). Resolved lazily through the ModuleRef — the
 * runner injects DESK_ACTIONS, so a constructor injection back would be a cycle.
 */
export const DESK_RUNNER_HEALTH = Symbol('DESK_RUNNER_HEALTH');
export interface DeskRunnerHealth {
  opensBlocked(): boolean;
}

/** EXIT / BOOK / TIGHTEN (Task 7 DeskExitActions satisfies it). */
export const DESK_EXIT_ACTIONS = Symbol('DESK_EXIT_ACTIONS');
export interface DeskExitActionsPort {
  exit(trackerId: string, kind: 'EXIT' | 'BOOK', reason: string, ctx: ActionContext): Promise<ActionResult>;
  tighten(trackerId: string, underlyingStop: number, reason: string, ctx: ActionContext): Promise<ActionResult>;
}

/** The env the actions read (AI_AUTO_EXIT_HOLD, the SL-enforceability settings). Default process.env. */
export const DESK_ACTIONS_ENV = Symbol('DESK_ACTIONS_ENV');
