import type { SignalTraderConfig } from './signal-trader.config';
import type { ResolvedContract } from './contract-resolver';
import type { SignalView } from './signal.types';
import { lateBand, lateEntryOf, targetsAhead, type LateEntry } from './late-entry';

/**
 * The deterministic gate (contract §X rule 1). Pure: every input that needs I/O is resolved by the
 * caller into facts first. Every check is recorded — including the ones that could not be evaluated
 * because an earlier one failed (`ok: null`) — so SignalDecision.gate shows the whole picture.
 */
export interface GateCheck {
  name: string;
  /** true pass, false fail, null not evaluated (a dependency failed / not applicable). */
  ok: boolean | null;
  /** A required check that is not `true` blocks the trade. */
  required: boolean;
  detail: string;
}

export interface EntryPlan {
  exchange: string;
  token: string;
  tradingsymbol: string;
  lotSize: number;
  tickSize: number;
  side: 'BUY' | 'SELL';
  ltp: number;
  /** The band we may enter in (no chasing). */
  bandLow: number;
  bandHigh: number;
  /** Always a LIMIT price. */
  limitPrice: number;
  sl: number;
  slSource: 'signal' | 'engine' | 'judge';
  targets: number[];
  lots: number;
  qty: number;
  /** ₹ (limit − SL) × qty — the worst-case planned loss. */
  riskRupees: number;
  /** slSource 'engine': how the engine derived the SL (the channel gave none usable). */
  engineSl?: { method: string; detail: string };
  /** A pending trigger (BUY ABOVE / SELL BELOW not reached yet): the plan is sized at the trigger price. */
  trigger?: TriggerState;
  /** The price had already run past the channel's entry: planned at the current price (domain/late-entry). */
  late?: LateEntry;
}

/** An armed trigger, persisted on SignalDecision.plan.trigger (restart-safe). */
export interface TriggerState {
  /** The price the entry waits for. */
  price: number;
  /** ABOVE: LTP must rise into [price, price·(1+t)]; BELOW: fall into [price·(1−t), price]. No chasing. */
  op: 'ABOVE' | 'BELOW';
  bandLow: number;
  bandHigh: number;
  armedAt: string;
  expiresAt: string;
  /** When the judge's verdict (reused at fire time if fresh) was given. */
  judgedAt: string | null;
  lastLtp: number | null;
  lastCheckAt: string | null;
}

export interface GateResult {
  pass: boolean;
  skipReason: string | null;
  checks: GateCheck[];
}

const check = (name: string, ok: boolean | null, detail: string, required = true): GateCheck => ({ name, ok, required, detail });
const r2 = (n: number) => Math.round(n * 100) / 100;

export function floorToTick(price: number, tick: number): number {
  return Number((Math.floor(price / tick + 1e-9) * tick).toFixed(4));
}
export function ceilToTick(price: number, tick: number): number {
  return Number((Math.ceil(price / tick - 1e-9) * tick).toFixed(4));
}

/** The entry band for a signal: ABOVE x → [x, x·(1+t)], BELOW x → [x·(1−t), x], AT x → x ± t, RANGE → [low, high]. */
export function entryBand(s: Pick<SignalView, 'entryType' | 'entryLow' | 'entryHigh'>, tolPct: number): { low: number; high: number } {
  const t = tolPct / 100;
  const lo = Math.min(s.entryLow, s.entryHigh);
  const hi = Math.max(s.entryLow, s.entryHigh);
  switch (s.entryType) {
    case 'ABOVE':
      return { low: hi, high: hi * (1 + t) };
    case 'BELOW':
      return { low: lo * (1 - t), high: lo };
    case 'RANGE':
      return { low: lo, high: hi };
    case 'AT':
    default: {
      const x = (lo + hi) / 2;
      return { low: x * (1 - t), high: x * (1 + t) };
    }
  }
}

/** Marketable LIMIT inside the band: BUY at most bandHigh, SELL at least bandLow. Never MARKET. */
export function marketableLimit(side: 'BUY' | 'SELL', ltp: number, band: { low: number; high: number }, bufferPct: number, tick: number): number {
  const b = bufferPct / 100;
  if (side === 'BUY') {
    let p = floorToTick(Math.min(ltp * (1 + b), band.high), tick);
    const atLtp = ceilToTick(ltp, tick);
    if (p < ltp && atLtp <= band.high) p = atLtp;
    return p;
  }
  let p = ceilToTick(Math.max(ltp * (1 - b), band.low), tick);
  const atLtp = floorToTick(ltp, tick);
  if (p > ltp && atLtp >= band.low) p = atLtp;
  return p;
}

/** Lots the signal asks for: a quantity ≥ one lot is read as units, a smaller one as lots. */
export function signalLots(qty: number | null, lotSize: number, defaultLots: number): number {
  if (qty === null || !Number.isFinite(qty) || qty <= 0) return defaultLots;
  if (lotSize > 1 && qty >= lotSize) return Math.max(1, Math.floor(qty / lotSize));
  return Math.max(1, Math.round(qty));
}

export type Sizing = { ok: true; lots: number; qty: number; riskRupees: number; detail: string } | { ok: false; reason: string; detail: string };

/**
 * Quantity under the caps: min(signal, SIGNAL_MAX_LOTS), then resized DOWN so (entry − SL) × qty ≤
 * SIGNAL_MAX_LOSS_PER_TRADE. Never up. One lot already over the cap → refused.
 */
export function sizeEntry(
  input: { kind: SignalView['instrumentKind']; qty: number | null; lotSize: number; limitPrice: number; sl: number },
  cfg: Pick<SignalTraderConfig, 'maxLots' | 'maxLossPerTrade' | 'maxNotional' | 'defaultLots'>,
): Sizing {
  const perUnit = Math.abs(input.limitPrice - input.sl);
  if (!(perUnit > 0)) return { ok: false, reason: 'sl_equals_entry', detail: 'SL equals the entry price' };
  if (input.kind === 'EQ') {
    const byNotional = Math.floor(cfg.maxNotional / input.limitPrice);
    if (byNotional < 1) return { ok: false, reason: 'notional_cap', detail: `one share ₹${input.limitPrice} exceeds SIGNAL_MAX_NOTIONAL ₹${cfg.maxNotional}` };
    const wanted = input.qty !== null && input.qty > 0 ? Math.floor(input.qty) : byNotional;
    const byRisk = Math.floor(cfg.maxLossPerTrade / perUnit);
    if (byRisk < 1) return { ok: false, reason: 'one_lot_exceeds_risk_cap', detail: `1 share risks ₹${r2(perUnit)} > cap ₹${cfg.maxLossPerTrade}` };
    const qty = Math.min(wanted, byNotional, byRisk);
    return { ok: true, lots: qty, qty, riskRupees: r2(perUnit * qty), detail: `qty ${qty} (signal ${input.qty ?? 'none'}, notional cap ${byNotional}, risk cap ${byRisk})` };
  }
  const lot = input.lotSize;
  const asked = signalLots(input.qty, lot, cfg.defaultLots);
  const capped = Math.min(asked, cfg.maxLots);
  const perLot = perUnit * lot;
  if (perLot > cfg.maxLossPerTrade) {
    return { ok: false, reason: 'one_lot_exceeds_risk_cap', detail: `1 lot (${lot}) risks ₹${r2(perLot)} > cap ₹${cfg.maxLossPerTrade}` };
  }
  const byRisk = Math.floor(cfg.maxLossPerTrade / perLot);
  const lots = Math.min(capped, byRisk);
  return {
    ok: true,
    lots,
    qty: lots * lot,
    riskRupees: r2(perUnit * lots * lot),
    detail: `${lots} lot(s) × ${lot} (signal ${asked}, lot cap ${cfg.maxLots}, risk cap ${byRisk})`,
  };
}

/** Facts the orchestrator resolved before the gate (null = could not be read → the check fails). */
export interface GateFacts {
  signal: SignalView;
  ownerUserId: string | null;
  marketOpen: boolean | null;
  minutesToClose: number | null;
  contract: { ok: true; contract: ResolvedContract } | { ok: false; reason: string } | null;
  ltp: number | null;
  /** Engine-derived SL when the signal has none (null otherwise). */
  engineSl: number | null;
  /** How the engine SL was derived, or why it could not be. */
  engineSlInfo?: { method: string | null; detail: string } | null;
  tradesToday: number | null;
  /** ₹ loss (positive) of today's signal trades, realised + open. */
  signalLossToday: number | null;
  clusterTaken: boolean | null;
  holding: boolean | null;
  coreKillSwitchOff: boolean | null;
  /** The account risk manager (legacy kill switch + max daily loss + caps). */
  riskManager: { allowed: boolean; reason?: string } | null;
  /** Live-only facts. */
  liveTradingEnabled: boolean;
  slEnforceable: { ok: boolean; detail: string };
}

/** Phase 1 (pure): tolerance, SL and sizing → the plan the risk manager is asked about. */
export function planEntry(
  f: Pick<GateFacts, 'signal' | 'contract' | 'ltp' | 'engineSl' | 'engineSlInfo'>,
  cfg: SignalTraderConfig,
): { checks: GateCheck[]; plan: EntryPlan | null } {
  const s = f.signal;
  const checks: GateCheck[] = [];
  const c = f.contract && f.contract.ok ? f.contract.contract : null;
  checks.push(
    c && c.lotSize >= 1 && c.token && c.tickSize > 0
      ? check('instrument_resolved', true, `${c.tradingsymbol} (${c.exchange}:${c.token}) lot ${c.lotSize} tick ${c.tickSize}${c.expiry ? ` exp ${c.expiry}` : ''}`)
      : check('instrument_resolved', false, f.contract && !f.contract.ok ? f.contract.reason : c ? 'contract has no lot size / tick / token' : 'instrument master unavailable'),
  );
  const ltp = f.ltp;
  checks.push(ltp !== null && ltp > 0 ? check('ltp_available', true, `LTP ${ltp}`) : check('ltp_available', c ? false : null, 'no fresh quote'));

  let band: { low: number; high: number } | null = null;
  let late: LateEntry | null = null;
  if (c && ltp !== null && ltp > 0) {
    band = entryBand(s, cfg.entryTolerancePct);
    const inside = ltp >= band.low - 1e-9 && ltp <= band.high + 1e-9;
    const past = inside ? null : lateEntryOf(s, ltp, band);
    if (past && cfg.lateEntry && past.chasePct <= cfg.lateMaxPct) {
      // Past the entry on the trade's side: plan from here and let the judge weigh the room left.
      late = past;
      checks.push(check('entry_tolerance', false, `late: LTP ${ltp} is ${past.chasePct}% past the channel's ${past.channelEntry} — planned at the current price, the judge weighs the room left`, false));
      band = lateBand(s.side, ltp, cfg.entryTolerancePct);
    } else {
      const why = inside
        ? `LTP ${ltp} inside [${r2(band.low)}, ${r2(band.high)}]`
        : (s.entryType === 'ABOVE' && ltp < band.low) || (s.entryType === 'BELOW' && ltp > band.high)
          ? `entry not reached: LTP ${ltp} vs ${s.entryType} band [${r2(band.low)}, ${r2(band.high)}]`
          : past && cfg.lateEntry
            ? `chasing: LTP ${ltp} is ${past.chasePct}% past the channel's ${past.channelEntry} (> ${cfg.lateMaxPct}% — the move is done, or the contract is wrong)`
            : `chasing: LTP ${ltp} outside [${r2(band.low)}, ${r2(band.high)}]`;
      checks.push(check('entry_tolerance', inside, why));
      if (!inside) band = null;
    }
  } else {
    checks.push(check('entry_tolerance', null, 'needs a contract and LTP'));
  }

  const sl = s.sl ?? f.engineSl;
  const slSource: EntryPlan['slSource'] = s.sl !== null ? 'signal' : 'engine';
  if (sl === null || !(sl > 0)) {
    const why = f.engineSlInfo?.detail ? ` (engine: ${f.engineSlInfo.detail})` : '';
    checks.push(check('sl_present', false, `no SL in the signal and no engine-derived SL${why}`));
  } else {
    const how = slSource === 'engine' && f.engineSlInfo?.method ? ` — engine_sl ${f.engineSlInfo.method}: ${f.engineSlInfo.detail}` : '';
    checks.push(check('sl_present', true, `SL ${sl} (${slSource})${how}`));
  }

  let plan: EntryPlan | null = null;
  if (c && band && ltp !== null && sl !== null && sl > 0) {
    const limit = marketableLimit(s.side, ltp, band, cfg.limitBufferPct, c.tickSize);
    const sideOk = s.side === 'BUY' ? sl < ltp && sl < limit : sl > ltp && sl > limit;
    checks.push(check('sl_side', sideOk, sideOk ? `SL ${sl} on the protective side of LTP ${ltp} / limit ${limit}` : `SL ${sl} is not ${s.side === 'BUY' ? 'below' : 'above'} LTP ${ltp} / limit ${limit} (already hit or wrong side)`));
    if (sideOk) {
      let size = sizeEntry({ kind: s.instrumentKind, qty: s.qty, lotSize: c.lotSize, limitPrice: limit, sl }, cfg);
      if (!size.ok && size.reason === 'one_lot_exceeds_risk_cap' && cfg.mode === 'paper') {
        // Paper tests the call itself: the smallest tradable size, its risk recorded as a warning.
        const unit = s.instrumentKind === 'EQ' ? 1 : c.lotSize;
        const risk = r2(Math.abs(limit - sl) * unit);
        checks.push(check('risk_cap', false, `${size.reason}: ${size.detail} — paper: 1 ${s.instrumentKind === 'EQ' ? 'share' : 'lot'} anyway`, false));
        size = { ok: true, lots: 1, qty: unit, riskRupees: risk, detail: `paper 1 ${s.instrumentKind === 'EQ' ? 'share' : `lot × ${unit}`} (over the ₹${cfg.maxLossPerTrade} cap)` };
      } else if (size.ok) {
        checks.push(check('risk_cap', true, `${size.detail}; risk ₹${size.riskRupees} ≤ ₹${cfg.maxLossPerTrade}`));
      }
      if (size.ok) {
        plan = {
          exchange: c.exchange,
          token: c.token,
          tradingsymbol: c.tradingsymbol,
          lotSize: c.lotSize,
          tickSize: c.tickSize,
          side: s.side,
          ltp,
          bandLow: r2(band.low),
          bandHigh: r2(band.high),
          limitPrice: limit,
          sl,
          slSource,
          targets: late ? targetsAhead(s.side, ltp, s.targets) : s.targets.filter((t) => Number.isFinite(t) && t > 0),
          ...(late ? { late } : {}),
          lots: size.lots,
          qty: size.qty,
          riskRupees: size.riskRupees,
          ...(slSource === 'engine' && f.engineSlInfo?.method ? { engineSl: { method: f.engineSlInfo.method, detail: f.engineSlInfo.detail } } : {}),
        };
      } else {
        checks.push(check('risk_cap', false, `${size.reason}: ${size.detail}`));
      }
    } else {
      checks.push(check('risk_cap', null, 'needs a valid SL'));
    }
  } else {
    checks.push(check('sl_side', null, 'needs a contract, an in-band LTP and an SL'));
    checks.push(check('risk_cap', null, 'needs a contract, an in-band LTP and an SL'));
  }
  return { checks, plan };
}

/** Phase 2 (pure): every hard check, in contract order, plus the phase-1 checks. */
export function evaluateGate(f: GateFacts, planChecks: GateCheck[], cfg: SignalTraderConfig): GateResult {
  const s = f.signal;
  const live = cfg.mode === 'live';
  const checks: GateCheck[] = [];
  checks.push(check('mode', cfg.mode !== 'off', `SIGNAL_TRADING=${cfg.mode}`));
  checks.push(check('owner', f.ownerUserId !== null, f.ownerUserId ? 'owner account configured' : 'HUB_OWNER_USER_ID is not set'));
  const optionSell = (s.instrumentKind === 'CE' || s.instrumentKind === 'PE') && s.side === 'SELL';
  checks.push(check('side_allowed', !optionSell || cfg.allowOptionSell, optionSell ? (cfg.allowOptionSell ? 'option writing allowed by SIGNAL_ALLOW_OPTION_SELL' : 'option writing (SELL CE/PE) is refused') : `${s.side} ${s.instrumentKind}`));
  checks.push(
    f.marketOpen === null
      ? check('market_hours', false, 'session clock unreadable')
      : !f.marketOpen
        ? check('market_hours', false, 'market closed (holiday-aware session clock)')
        : f.minutesToClose !== null && f.minutesToClose < cfg.minMinutesToClose
          ? check('market_hours', false, `only ${f.minutesToClose} min to close (< ${cfg.minMinutesToClose})`)
          : check('market_hours', true, `open${f.minutesToClose !== null ? `, ${f.minutesToClose} min to close` : ''}`),
  );
  checks.push(...planChecks);
  // Paper tests every call, so the daily count / loss stop are recorded but never block there.
  const paper = cfg.mode === 'paper';
  checks.push(
    f.tradesToday === null
      ? check('trades_today', false, 'could not count today\'s signal trades', !paper)
      : check('trades_today', f.tradesToday < cfg.maxTradesPerDay, `${f.tradesToday} of ${cfg.maxTradesPerDay} today`, !paper),
  );
  checks.push(
    f.signalLossToday === null
      ? check('daily_signal_loss', false, 'could not read today\'s signal P&L', !paper)
      : check('daily_signal_loss', f.signalLossToday < cfg.dailyLossStop, `loss today ₹${r2(f.signalLossToday)} vs stop ₹${cfg.dailyLossStop}`, !paper),
  );
  checks.push(f.clusterTaken === null ? check('cluster_not_taken', false, 'could not read the cluster') : check('cluster_not_taken', !f.clusterTaken, f.clusterTaken ? 'this cluster already produced a TAKE' : 'no TAKE in this cluster yet'));
  checks.push(f.holding === null ? check('not_holding', null, 'needs a resolved contract') : check('not_holding', !f.holding, f.holding ? 'already holding / ordering this contract' : 'not holding this contract'));
  checks.push(f.coreKillSwitchOff === null ? check('kill_switch', false, 'kill switch unreadable (fails closed)') : check('kill_switch', f.coreKillSwitchOff, f.coreKillSwitchOff ? 'core kill switch off' : 'core kill switch ON'));
  checks.push(
    f.riskManager === null
      ? check('risk_manager', null, 'needs a plan')
      : check('risk_manager', f.riskManager.allowed, f.riskManager.allowed ? 'account risk manager allows' : `account risk manager: ${f.riskManager.reason ?? 'blocked'}`),
  );
  checks.push(check('live_trading_enabled', f.liveTradingEnabled, f.liveTradingEnabled ? 'LIVE_TRADING_ENABLED=true' : 'LIVE_TRADING_ENABLED is not "true"', live));
  checks.push(check('sl_enforceable', f.slEnforceable.ok, f.slEnforceable.detail, live));

  const first = checks.find((c) => c.required && c.ok !== true);
  return { pass: !first, skipReason: first ? first.name : null, checks };
}

/** What the judge may change: a tighter SL and/or fewer lots. Never looser, never larger. */
export function applyJudgeTightening(
  plan: EntryPlan,
  judge: { sl: number | null; lots: number | null },
  kind: SignalView['instrumentKind'],
): { plan: EntryPlan; changed: string[] } {
  const changed: string[] = [];
  let sl = plan.sl;
  let slSource = plan.slSource;
  if (judge.sl !== null && Number.isFinite(judge.sl) && judge.sl > 0) {
    const tighter = plan.side === 'BUY' ? judge.sl > plan.sl && judge.sl < plan.ltp : judge.sl < plan.sl && judge.sl > plan.ltp;
    if (tighter) {
      sl = judge.sl;
      slSource = 'judge';
      changed.push(`SL ${plan.sl} → ${judge.sl}`);
    }
  }
  let lots = plan.lots;
  if (judge.lots !== null && Number.isInteger(judge.lots) && judge.lots >= 1 && judge.lots < plan.lots) {
    lots = judge.lots;
    changed.push(`lots ${plan.lots} → ${judge.lots}`);
  }
  const unit = kind === 'EQ' ? 1 : plan.lotSize;
  const qty = lots * unit;
  return { plan: { ...plan, sl, slSource, lots, qty, riskRupees: r2(Math.abs(plan.limitPrice - sl) * qty) }, changed };
}
