import { Prisma } from '@prisma/client';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import { hhmmToMinutes, LIMIT_PAIRS, type DailyLossAction, type LimitKey, type LimitPair, type LimitScope } from './limits/limit-keys';
import { istMinutesOf, VEHICLE_EXCHANGES } from './session-open';
import type {
  CoreEntryIntent,
  CoreExitIntent,
  CoreIntent,
  DailyLossDecision,
  Direction,
  LimitInForce,
  RiskContext,
  RiskLiveState,
  RiskReason,
  RiskReasonCode,
  RiskStateSnapshot,
  RiskVerdict,
} from './risk-wall.types';

/**
 * The Risk Wall (spec §5.1): a pure function of the intent, the limits in force and
 * the user's live state. It may only allow, reject or REDUCE quantity; exits are never
 * checked; anything it cannot compute is a REJECT with the reason. It holds no limit
 * value of its own (D4): every number comes from ctx.limits.
 */
const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isVehicle = (v: unknown): v is Vehicle => (VEHICLES as readonly unknown[]).includes(v);

export function exposureOf(vehicle: Vehicle, side: 'BUY' | 'SELL', optionType: 'CE' | 'PE' | null): Direction {
  if (vehicle === 'OPTIONS_BUY') return optionType === 'PE' ? 'SHORT' : 'LONG';
  return side === 'BUY' ? 'LONG' : 'SHORT';
}

/** The limits an entry in this vehicle needs: every ALL-scope pair plus the vehicle's own. */
export function requiredLimitPairs(vehicle: Vehicle): LimitPair[] {
  return LIMIT_PAIRS.filter((p) => p.scope === 'ALL' || p.scope === vehicle);
}

class LimitReader {
  private readonly byPair = new Map<string, string>();

  constructor(limits: readonly LimitInForce[]) {
    for (const l of limits) this.byPair.set(`${l.key}@${l.scope}`, l.value);
  }

  raw(key: LimitKey, scope: LimitScope): string | null {
    return this.byPair.get(`${key}@${scope}`) ?? null;
  }

  /** Throws on a malformed value; checkRisk turns that into a REJECT. */
  dec(key: LimitKey, scope: LimitScope): Dec | null {
    const v = this.raw(key, scope);
    if (v === null) return null;
    const d = new D(v);
    if (!d.isFinite()) throw new Error(`${key}@${scope} is not a number: ${v}`);
    return d;
  }

  minutes(key: LimitKey, scope: LimitScope): number | null {
    const v = this.raw(key, scope);
    if (v === null) return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error(`${key}@${scope} is not HH:MM: ${v}`);
    return hhmmToMinutes(v);
  }
}

/** A real loss (> ₹0) at or beyond the limit: the rule risk-manager.service.ts:204 uses. */
const lossReaches = (loss: Dec, limit: Dec): boolean => loss.gt(0) && loss.gte(limit);

export function decideDailyLoss(limits: readonly LimitInForce[], state: RiskLiveState): DailyLossDecision {
  const lim = new LimitReader(limits);
  const limit = lim.dec('maxDailyLoss', 'ALL');
  const action = lim.raw('dailyLossAction', 'ALL') as DailyLossAction | null;
  const limitRupees = limit ? limit.toFixed(2) : null;
  if (!limit || !action) return { status: 'UNKNOWN', lossRupees: null, limitRupees, action, squareOffCore: false };
  const loss = finite(state.realisedPnlToday) && finite(state.openPnl)
    ? new D(0).minus(state.realisedPnlToday).minus(state.openPnl)
    : null;
  if (state.dailyLossLatched || (loss && lossReaches(loss, limit))) {
    return { status: 'BREACHED', lossRupees: loss ? loss.toFixed(2) : null, limitRupees, action, squareOffCore: action === 'BLOCK_AND_SQUARE_OFF' };
  }
  if (!loss) return { status: 'UNKNOWN', lossRupees: null, limitRupees, action, squareOffCore: false };
  return { status: 'OK', lossRupees: loss.toFixed(2), limitRupees, action, squareOffCore: false };
}

function snapshotState(state: RiskLiveState): RiskStateSnapshot {
  const money = (n: number | null): string | null => (finite(n) ? new D(n).toFixed(2) : null);
  const perVehicle = <T>(f: (v: Vehicle) => T) => Object.fromEntries(VEHICLES.map((v) => [v, f(v)])) as Record<Vehicle, T>;
  return {
    asOf: state.asOf.toISOString(),
    realisedPnlToday: money(state.realisedPnlToday),
    openPnl: money(state.openPnl),
    tradesToday: state.tradesToday,
    openPositions: state.openPositions.length,
    openPositionsByVehicle: perVehicle((v) => state.openPositions.filter((p) => p.vehicle === v).length),
    deployedCapital: perVehicle((v) => money(state.deployedCapital[v])),
    dailyLossLatched: state.dailyLossLatched,
  };
}

function intentProblems(i: CoreEntryIntent): string[] {
  if (!isVehicle(i.vehicle)) return [`unknown vehicle ${String(i.vehicle)}`];
  const out: string[] = [];
  for (const f of ['intentId', 'userId', 'strategyId', 'strategyVersionId', 'symbol', 'underlying'] as const) {
    if (typeof i[f] !== 'string' || i[f].trim() === '') out.push(`${f} is required`);
  }
  const venues = VEHICLE_EXCHANGES[i.vehicle];
  if (!venues.includes(String(i.exchange).toUpperCase())) out.push(`${i.vehicle} trades on ${venues.join('/')}, not ${String(i.exchange)}`);
  if (i.side !== 'BUY' && i.side !== 'SELL') out.push('side must be BUY or SELL');
  if (!Number.isSafeInteger(i.lotSize) || i.lotSize < 1) out.push('lotSize must be a whole number of 1 or more');
  else if (!Number.isSafeInteger(i.qty) || i.qty < 1 || i.qty % i.lotSize !== 0) out.push(`qty must be a positive whole multiple of the lot size ${i.lotSize}`);
  if (!finite(i.refPrice) || i.refPrice <= 0) out.push('refPrice must be a price above 0');
  if (!finite(i.capitalPerUnit) || i.capitalPerUnit <= 0) out.push('capitalPerUnit must be above 0');
  if (i.stopPrice !== null) {
    if (!finite(i.stopPrice) || i.stopPrice <= 0) out.push('stopPrice must be a price above 0, or null');
    else if (finite(i.refPrice) && (i.side === 'BUY' ? i.stopPrice >= i.refPrice : i.stopPrice <= i.refPrice)) {
      out.push(`a ${i.side} stop must be on the losing side of refPrice`);
    }
  }
  if (i.vehicle === 'OPTIONS_BUY') {
    if (i.optionType !== 'CE' && i.optionType !== 'PE') out.push('an option entry needs optionType CE or PE');
  } else if (i.optionType !== null) {
    out.push('optionType is only for OPTIONS_BUY');
  }
  if (i.vehicle === 'MTF') {
    if (!finite(i.mtfLeverage) || i.mtfLeverage < 1) out.push('an MTF entry needs mtfLeverage of 1 or more');
  } else if (i.mtfLeverage !== null) {
    out.push('mtfLeverage is only for MTF');
  }
  return out;
}

interface Cap {
  code: RiskReasonCode;
  qty: number;
  message: string;
}

function sizeCaps(i: CoreEntryIntent, vehicle: Vehicle, lim: LimitReader, deployedNow: number): Cap[] {
  const toLots = (units: Dec): number => {
    const whole = units.isNegative() ? new D(0) : units.floor();
    return whole.div(i.lotSize).floor().mul(i.lotSize).toNumber();
  };
  const caps: Cap[] = [];
  const maxRisk = lim.dec('maxRiskPerTrade', 'ALL') as Dec;
  const riskPerUnit = new D(i.refPrice).minus(i.stopPrice as number).abs();
  const byRisk = toLots(maxRisk.div(riskPerUnit));
  caps.push({ code: 'CAP_RISK_PER_TRADE', qty: byRisk, message: `risk ₹${riskPerUnit.toFixed(2)} per unit allows ${byRisk} units within ₹${maxRisk.toFixed(2)} per trade` });
  const maxCapital = lim.dec('maxCapitalDeployed', vehicle) as Dec;
  const headroom = maxCapital.minus(deployedNow);
  const byCapital = toLots(headroom.div(i.capitalPerUnit));
  caps.push({ code: 'CAP_CAPITAL_DEPLOYED', qty: byCapital, message: `₹${headroom.isNegative() ? '0.00' : headroom.toFixed(2)} of ${vehicle} capital left (limit ₹${maxCapital.toFixed(2)}) allows ${byCapital} units` });
  if (vehicle === 'OPTIONS_BUY') {
    const maxPremium = lim.dec('optionsMaxPremiumPerTrade', 'OPTIONS_BUY') as Dec;
    const byPremium = toLots(maxPremium.div(i.refPrice));
    caps.push({ code: 'CAP_OPTIONS_PREMIUM', qty: byPremium, message: `premium ₹${new D(i.refPrice).toFixed(2)} per unit allows ${byPremium} units within ₹${maxPremium.toFixed(2)} per trade` });
  }
  return caps;
}

function evaluateEntry(intent: CoreEntryIntent, ctx: RiskContext): RiskVerdict {
  const reasons: RiskReason[] = [];
  const add = (code: RiskReasonCode, message: string) => reasons.push({ code, message });
  const lim = new LimitReader(ctx.limits);
  const { state } = ctx;
  const vehicle = isVehicle(intent.vehicle) ? intent.vehicle : null;
  const problems = intentProblems(intent);
  for (const m of problems) add('INVALID_INTENT', m);

  if (ctx.killSwitchActive) add('KILL_SWITCH', 'the kill switch is on: no new entries');
  if (vehicle) {
    for (const p of requiredLimitPairs(vehicle)) {
      if (lim.raw(p.key, p.scope) === null) add('LIMIT_MISSING', `no ${p.key} limit is in force for ${p.scope}`);
    }
  }
  if (!ctx.sessionOpen) add('SESSION_CLOSED', `${String(intent.exchange)} is not in session`);
  if (intent.refPriceFresh !== true) add('STALE_PRICE', `no fresh price for ${String(intent.symbol)}`);
  const unpriced = state.openPositions.filter((p) => p.priced !== true);
  if (unpriced.length > 0) add('UNPRICED_POSITION', `open position(s) without a fresh price: ${unpriced.map((p) => p.symbol).join(', ')}`);

  const dailyLoss = decideDailyLoss(ctx.limits, state);
  if (dailyLoss.status === 'BREACHED') {
    add('DAILY_LOSS', `today's loss${dailyLoss.lossRupees ? ` ₹${dailyLoss.lossRupees}` : ''} has reached the ₹${dailyLoss.limitRupees} daily limit${state.dailyLossLatched ? ' (blocked for the rest of the session)' : ''}`);
  } else if (dailyLoss.status === 'UNKNOWN' && dailyLoss.limitRupees !== null && dailyLoss.action !== null) {
    add('PNL_UNKNOWN', "today's P&L cannot be computed");
  }

  const perStrategy = lim.dec('maxDailyLossPerStrategy', 'ALL');
  const byStrategy = state.pnlTodayByStrategy;
  const strategyPnl = Object.prototype.hasOwnProperty.call(byStrategy, intent.strategyId) ? byStrategy[intent.strategyId] : 0;
  if (!finite(strategyPnl)) {
    add('PNL_UNKNOWN', `today's P&L for strategy ${intent.strategyId} cannot be computed`);
  } else if (perStrategy) {
    const loss = new D(0).minus(strategyPnl);
    if (lossReaches(loss, perStrategy)) add('STRATEGY_DAILY_LOSS', `this strategy's loss today ₹${loss.toFixed(2)} has reached the ₹${perStrategy.toFixed(2)} per-strategy limit`);
  }

  const maxTrades = lim.dec('maxTradesPerDay', 'ALL');
  if (!Number.isSafeInteger(state.tradesToday) || state.tradesToday < 0) add('STATE_UNKNOWN', "today's entry count is unknown");
  else if (maxTrades && maxTrades.lte(state.tradesToday)) add('MAX_TRADES', `${state.tradesToday} entries today; the limit is ${maxTrades.toFixed(0)}`);

  const maxOpen = lim.dec('maxOpenPositions', 'ALL');
  if (maxOpen && maxOpen.lte(state.openPositions.length)) add('MAX_OPEN_POSITIONS', `${state.openPositions.length} open or pending positions; the limit is ${maxOpen.toFixed(0)}`);
  if (vehicle) {
    const maxOpenVehicle = lim.dec('maxOpenPositions', vehicle);
    const inVehicle = state.openPositions.filter((p) => p.vehicle === vehicle).length;
    if (maxOpenVehicle && maxOpenVehicle.lte(inVehicle)) add('MAX_OPEN_POSITIONS_VEHICLE', `${inVehicle} open or pending ${vehicle} positions; the limit is ${maxOpenVehicle.toFixed(0)}`);
  }

  // Conflict rule (parent §6.3).
  const symbol = String(intent.symbol).toUpperCase();
  const underlying = String(intent.underlying).toUpperCase();
  const sameSymbol = state.openPositions.find((p) => p.symbol.toUpperCase() === symbol);
  if (sameSymbol) add('CONFLICT_SAME_SYMBOL', `a core position in ${intent.symbol} is already ${sameSymbol.state}`);
  const direction = vehicle ? exposureOf(vehicle, intent.side, intent.optionType) : null;
  const opposite = direction
    ? state.openPositions.find((p) => p.underlying.toUpperCase() === underlying && p.direction !== direction)
    : undefined;
  if (opposite) add('CONFLICT_OPPOSITE_DIRECTION', `already ${opposite.direction} on ${intent.underlying} (${opposite.symbol}): never long and short on one underlying`);

  if (vehicle) {
    const nowMin = istMinutesOf(ctx.now);
    const lastEntry = lim.minutes('lastEntryTime', vehicle);
    if (lastEntry !== null && nowMin >= lastEntry) add('AFTER_LAST_ENTRY', `${vehicle} entries stop at ${lim.raw('lastEntryTime', vehicle)} IST`);
    const squareOff = lim.minutes('squareOffTime', vehicle);
    if (squareOff !== null && nowMin >= squareOff) add('AFTER_SQUARE_OFF', `${vehicle} squares off at ${lim.raw('squareOffTime', vehicle)} IST`);
  }
  if (vehicle === 'MTF' && intent.side !== 'BUY') add('VEHICLE_SIDE', 'MTF is long only');
  if (vehicle === 'OPTIONS_BUY' && intent.side !== 'BUY') add('VEHICLE_SIDE', 'options are buy only (OPTIONS_BUY)');
  const maxLeverage = lim.dec('mtfMaxLeverage', 'MTF');
  if (vehicle === 'MTF' && maxLeverage && finite(intent.mtfLeverage) && maxLeverage.lt(intent.mtfLeverage)) {
    add('MTF_LEVERAGE', `leverage ${intent.mtfLeverage} is above the ${maxLeverage.toFixed(2)} MTF limit`);
  }
  if (intent.stopPrice === null) add('RISK_UNKNOWN', 'the intent has no stop, so its risk cannot be computed');
  const deployedNow = vehicle ? state.deployedCapital[vehicle] : null;
  if (vehicle && !finite(deployedNow)) add('STATE_UNKNOWN', `capital deployed in ${vehicle} is unknown`);

  const base = {
    intentId: intent.intentId,
    userId: intent.userId,
    intentKind: 'ENTRY' as const,
    requestedQty: intent.qty,
    limits: [...ctx.limits],
    state: snapshotState(state),
    dailyLoss,
    killSwitchActive: ctx.killSwitchActive,
    checkedAt: ctx.now.toISOString(),
  };
  if (reasons.length > 0 || !vehicle || !finite(deployedNow)) return { ...base, verdict: 'REJECT', qty: 0, reasons };

  const caps = sizeCaps(intent, vehicle, lim, deployedNow);
  const qty = Math.min(intent.qty, ...caps.map((c) => c.qty));
  if (qty >= intent.qty) {
    return { ...base, verdict: 'ALLOW', qty: intent.qty, reasons: [{ code: 'WITHIN_LIMITS', message: 'within every limit' }] };
  }
  const binding = caps.filter((c) => c.qty === qty).map(({ code, message }) => ({ code, message }));
  return qty <= 0 ? { ...base, verdict: 'REJECT', qty: 0, reasons: binding } : { ...base, verdict: 'RESIZE', qty, reasons: binding };
}

/** RiskWall.check (spec §5.1). Never throws. */
export function checkRisk(intent: CoreIntent, ctx: RiskContext): RiskVerdict {
  if (intent.kind === 'EXIT') return exitVerdict(intent, ctx.now);
  try {
    return evaluateEntry(intent, ctx);
  } catch (err) {
    return rejectVerdict(intent, ctx.now, 'CONTEXT_UNAVAILABLE', `the risk check could not evaluate its inputs: ${errorText(err)}`, {
      limits: [...ctx.limits],
      killSwitchActive: ctx.killSwitchActive,
    });
  }
}

/** Exits are never checked or blocked (spec §5.1). */
export function exitVerdict(intent: CoreExitIntent, now: Date): RiskVerdict {
  return {
    intentId: intent.intentId,
    userId: intent.userId,
    intentKind: 'EXIT',
    verdict: 'ALLOW',
    requestedQty: intent.qty,
    qty: intent.qty,
    reasons: [{ code: 'EXIT_NOT_CHECKED', message: 'exits are never checked or blocked' }],
    limits: [],
    state: null,
    dailyLoss: null,
    killSwitchActive: null,
    checkedAt: now.toISOString(),
  };
}

/** A fail-closed REJECT, keeping whatever snapshot was already known. */
export function rejectVerdict(
  intent: CoreEntryIntent,
  now: Date,
  code: RiskReasonCode,
  message: string,
  prior: Partial<Pick<RiskVerdict, 'limits' | 'state' | 'dailyLoss' | 'killSwitchActive'>> = {},
): RiskVerdict {
  return {
    intentId: intent.intentId,
    userId: intent.userId,
    intentKind: 'ENTRY',
    verdict: 'REJECT',
    requestedQty: intent.qty,
    qty: 0,
    reasons: [{ code, message }],
    limits: prior.limits ? [...prior.limits] : [],
    state: prior.state ?? null,
    dailyLoss: prior.dailyLoss ?? null,
    killSwitchActive: prior.killSwitchActive ?? null,
    checkedAt: now.toISOString(),
  };
}
