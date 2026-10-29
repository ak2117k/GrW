import { CLEAR_MARGIN_N, EXPIRY_CLOSE_MIN, INVALIDATION_SCALE_TOLERANCE, type ExitDisciplineConfig } from './config';
import type { ClauseId, ClauseResult, GateFactsSnapshot, Justification } from './types';

export type GateFacts = GateFactsSnapshot;

export interface GateEvaluation {
  justified: boolean;
  justification: Justification | null;
  hardRisk: boolean;
  /** THESIS_INVALIDATION passed by >= CLEAR_MARGIN_N noise units (persistence bypass, spec §7). */
  thesisClearMargin: boolean;
  /** A FLOOR_HARD_* clause passed (FLOOR_HARD_EXIT): skips persistence like hard risk, not the opening guard. */
  floorHard: boolean;
  clauses: ClauseResult[];
}

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const res = (id: ClauseId, pass: boolean | null, measured: ClauseResult['measured'], note: string): ClauseResult =>
  ({ id, pass, measured, note });

/**
 * Spec §6, pure. Never throws; a missing input makes a clause `pass: null`
 * (unmeasurable), which never justifies an exit.
 */
export function evaluateExitGate(f: GateFacts, cfg: ExitDisciplineConfig): GateEvaluation {
  const bull = f.exposure === 'BULLISH';
  const u = fin(f.underlying) ? f.underlying : null;
  const known = f.exposure !== null && u !== null;
  const nU = fin(f.nUnderlying) && f.nUnderlying > 0 ? f.nUnderlying : null;

  // 1a. invalidation
  let inv: ClauseResult;
  let clear = false;
  if (!known || !fin(f.invalidation)) {
    inv = res('THESIS_INVALIDATION', null, { underlying: u, invalidation: f.invalidation ?? null }, 'no underlying, exposure or invalidation to compare');
  } else if (Math.abs(f.invalidation - (u as number)) / (u as number) > INVALIDATION_SCALE_TOLERANCE) {
    inv = res('THESIS_INVALIDATION', null, { underlying: u, invalidation: f.invalidation },
      `invalidation is more than ${INVALIDATION_SCALE_TOLERANCE * 100}% from the underlying — wrong scale, not used`);
  } else {
    const beyond = bull ? (u as number) < f.invalidation : (u as number) > f.invalidation;
    const margin = r2(Math.abs((u as number) - f.invalidation));
    clear = beyond && nU !== null && margin >= CLEAR_MARGIN_N * nU;
    inv = res('THESIS_INVALIDATION', beyond, { underlying: u, invalidation: f.invalidation, margin, nUnderlying: nU, clearMargin: clear },
      beyond ? `underlying beyond the thesis invalidation by ${margin}` : 'underlying on the thesis side of the invalidation');
  }

  // 1b. the level the trade was HELD against (last HOLD's packet)
  const held = f.holdRef ? (bull ? f.holdRef.support : f.holdRef.resistance) : null;
  const lvl = !known || !fin(held)
    ? res('THESIS_LEVEL', null, { underlying: u, heldLevel: held ?? null }, 'no HOLD-time support/resistance to compare')
    : res('THESIS_LEVEL', bull ? (u as number) < held : (u as number) > held, { underlying: u, heldLevel: held, holdId: f.holdRef!.id },
      bull ? 'underlying vs the support held at the last HOLD' : 'underlying vs the resistance held at the last HOLD');

  // 2. hard risk
  const maxLoss = fin(f.maxLossPerTrade) && f.maxLossPerTrade > 0 ? f.maxLossPerTrade : null;
  const loss = maxLoss === null || !fin(f.netPnlNow)
    ? res('HARD_MAX_LOSS', null, { netPnlNow: f.netPnlNow ?? null, maxLossPerTrade: maxLoss }, 'no per-trade max loss or P&L')
    : res('HARD_MAX_LOSS', f.netPnlNow <= -maxLoss, { netPnlNow: r2(f.netPnlNow), maxLossPerTrade: maxLoss }, 'net loss vs maxRiskPerTrade');
  const mtc = fin(f.minutesToClose) ? f.minutesToClose : null;
  const close = res('HARD_SESSION_CLOSE', mtc === null ? null : f.productType === 'INTRADAY' && mtc <= cfg.gateCloseMin,
    { productType: f.productType, minutesToClose: mtc, gateCloseMin: cfg.gateCloseMin }, 'intraday product near the close (E3)');
  const expiry = res('HARD_EXPIRY', mtc === null ? null : f.isExpiryDay && mtc <= EXPIRY_CLOSE_MIN,
    { isExpiryDay: f.isExpiryDay, minutesToClose: mtc }, `expiry day, <= ${EXPIRY_CLOSE_MIN} min to close`);
  const daily = res('HARD_DAILY_LOSS', f.dailyLossLatched, { dailyLossLatched: f.dailyLossLatched }, 'core daily-loss latch for today');

  // 3. confirmed floor breach
  const fp = f.floor.price;
  const breached = f.floor.armed && fin(fp) && fin(f.ltpNow)
    ? (f.positionSide === 'LONG' ? f.ltpNow < fp : f.ltpNow > fp) : false;
  const holdU = f.holdRef && fin(f.holdRef.underlying) ? f.holdRef.underlying : null;
  // FLOOR_HARD_EXIT: a packet with money.anchors measures the move from a FIXED point — where the floor
  // armed (else the best point) — never from the last HOLD, which re-anchors on every verdict and let a
  // slow sub-1-N grind hold through a broken floor (prod 2026-10-29). Pre-anchor packets: the HOLD frame.
  const a = cfg.floorHardExit && f.anchors ? f.anchors : null;
  const fixedRef = a ? (fin(a.armUnderlying) ? { from: 'FLOOR_ARM', u: a.armUnderlying } : fin(a.bestUnderlying) ? { from: 'BEST', u: a.bestUnderlying } : null) : null;
  let move: ClauseResult;
  if (fixedRef && known && nU !== null) {
    const adverse = r2(bull ? fixedRef.u - (u as number) : (u as number) - fixedRef.u);
    move = res('FLOOR_BREACH_UNDERLYING_MOVE', breached && adverse >= cfg.gateUnderlyingN * nU,
      { floorBreached: breached, floor: fp ?? null, ltpNow: f.ltpNow, underlying: u, from: fixedRef.from, refUnderlying: fixedRef.u, adverseMove: adverse, nUnderlying: nU, needN: cfg.gateUnderlyingN },
      `armed floor breached AND the underlying moved against the position from the ${fixedRef.from === 'FLOOR_ARM' ? "floor's arm point" : 'best point'}`);
  } else if (!known || holdU === null || nU === null) {
    move = res('FLOOR_BREACH_UNDERLYING_MOVE', null, { floorBreached: breached, underlying: u, holdUnderlying: holdU, nUnderlying: nU },
      'no HOLD-time underlying or no underlying noise unit');
  } else {
    const adverse = r2(bull ? holdU - (u as number) : (u as number) - holdU);
    move = res('FLOOR_BREACH_UNDERLYING_MOVE', breached && adverse >= cfg.gateUnderlyingN * nU,
      { floorBreached: breached, floor: fp ?? null, ltpNow: f.ltpNow, underlying: u, holdUnderlying: holdU, adverseMove: adverse, nUnderlying: nU, needN: cfg.gateUnderlyingN },
      'armed floor breached AND the underlying moved against the position since the last HOLD');
  }
  const vw = !known || !fin(f.vwap)
    ? res('FLOOR_BREACH_VWAP', null, { floorBreached: breached, underlying: u, vwap: f.vwap ?? null }, 'no underlying VWAP')
    : res('FLOOR_BREACH_VWAP', breached && (bull ? (u as number) < f.vwap : (u as number) > f.vwap),
      { floorBreached: breached, floor: fp ?? null, ltpNow: f.ltpNow, underlying: u, vwap: f.vwap },
      'armed floor breached AND the underlying is on the wrong side of VWAP');

  // 4. hard floor (hard-floor.ts), anchored packets only: the armed floor broken on BOTH reads — the
  // packet's premium and the executor's fresh one — AND net red on every net P&L read, or the
  // underlying K·N against the position from the best point.
  const hard: ClauseResult[] = [];
  if (a) {
    const lt = [a.packetLtp, f.ltpNow].filter(fin);
    const bothBelow = f.floor.armed && fin(fp) && lt.length === 2 && lt.every((x) => (f.positionSide === 'LONG' ? x < fp : x > fp));
    const nets = [a.packetNetPnl, a.freshNetPnl].filter(fin);
    hard.push(nets.length === 0
      ? res('FLOOR_HARD_GREEN_TO_RED', null, { floorBroken: bothBelow, packetNetPnl: a.packetNetPnl, freshNetPnl: a.freshNetPnl }, 'no net P&L to compare')
      : res('FLOOR_HARD_GREEN_TO_RED', bothBelow && nets.every((x) => x < 0),
        { floorBroken: bothBelow, floor: fp ?? null, packetLtp: a.packetLtp, ltpNow: f.ltpNow, packetNetPnl: a.packetNetPnl, freshNetPnl: a.freshNetPnl },
        'armed floor broken on both reads AND the position is net red after charges'));
    const fromBest = known && fin(a.bestUnderlying) ? r2(bull ? a.bestUnderlying - (u as number) : (u as number) - a.bestUnderlying) : null;
    hard.push(fromBest === null || nU === null
      ? res('FLOOR_HARD_UNDERLYING_MOVE', null, { floorBroken: bothBelow, underlying: u, bestUnderlying: a.bestUnderlying, nUnderlying: nU },
        'no best-point underlying or no underlying noise unit')
      : res('FLOOR_HARD_UNDERLYING_MOVE', bothBelow && fromBest >= cfg.floorHardExitN * nU - 1e-9,
        { floorBroken: bothBelow, floor: fp ?? null, ltpNow: f.ltpNow, underlying: u, bestUnderlying: a.bestUnderlying, adverseMove: fromBest, nUnderlying: nU, needN: cfg.floorHardExitN },
        'armed floor broken on both reads AND the underlying moved K noise units against the position from the best point'));
  }

  const clauses = [inv, lvl, loss, close, expiry, daily, move, vw, ...hard];
  const ok = (c: ClauseResult) => c.pass === true;
  const hardRisk = [loss, close, expiry, daily].some(ok);
  const floorHard = hard.some(ok);
  const thesis = [inv, lvl].some(ok);
  const floorOk = [move, vw].some(ok);
  const justification: Justification | null = hardRisk ? 'HARD_RISK' : floorHard ? 'FLOOR_HARD_EXIT'
    : thesis ? 'THESIS_BROKEN' : floorOk ? 'CONFIRMED_FLOOR_BREACH' : null;
  return { justified: justification !== null, justification, hardRisk, thesisClearMargin: clear, floorHard, clauses };
}
