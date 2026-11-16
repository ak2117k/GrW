/**
 * OI read for the exit judge — PURE (no I/O, no clock).
 *
 * The judge used to see only the top OTM OI strike per side. The owner's rule
 * is richer: put OI marks the support zone, call OI the resistance zone, price
 * rarely defies them without strong news, and OI CHANGE is the supporting
 * factor — is a wall being built or abandoned, and is the change writing or
 * unwinding (which needs the option PRICE change alongside the OI change).
 *
 * Change basis, in order of preference:
 *   1. `baseline` = the last non-stale snapshot of the PREVIOUS session, same
 *      underlying, expiry and source. Change = today's build-up, and the LTP
 *      change is available too, so build-up can be classified.
 *   2. No baseline → the chain's own `oiChange` (NSE: vs previous close; hub:
 *      vs the previous session's last OI, null when unknown). No LTP change is
 *      stored in a chain, so build-up stays null — OI direction only.
 *
 * Units: the number stored in `chainJson.oi` depends on who wrote the row.
 * NSE's option-chain API reports open interest in CONTRACTS (lots). Angel One
 * (`ANGEL_ONE`, `ANGEL_ONE_WS`, and `HUB`, which is built from Angel quotes)
 * reports `opnInterest` as QUANTITY (shares / units) — e.g. MCX CRUDEOIL
 * strikes show ~2.7M (barrels), not lots. They are never mixed: the baseline
 * must come from the same source (the service enforces that; this function
 * drops a baseline whose source differs).
 */

export interface ChainLeg {
  ltp?: number | null;
  oi?: number | null;
  oiChange?: number | null;
  iv?: number | null;
}

export interface ChainStrike {
  strikePrice: number;
  ceData?: ChainLeg | null;
  peData?: ChainLeg | null;
}

export interface ChainSnap {
  capturedAt: Date;
  /** YYYY-MM-DD */
  expiry: string;
  /** option_chain_snapshots.source: HUB | ANGEL_ONE | ANGEL_ONE_WS | NSE | DB_INSTRUMENTS */
  source: string;
  spot?: number | null;
  strikes: ChainStrike[];
}

export type OiUnits = 'contracts' | 'shares' | 'unknown';

/** OI↑ price↑ LONG_BUILDUP · OI↑ price↓ SHORT_BUILDUP (writing) · OI↓ price↑ SHORT_COVERING · OI↓ price↓ LONG_UNWINDING. */
export type BuildUp = 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'FLAT';

export type WallTrend = 'BUILT' | 'ABANDONED' | 'STEADY' | 'UNKNOWN';

export type ChangeBasis = 'baseline' | 'chain' | 'none';

export interface OiStrikeRow {
  strike: number;
  callOi: number;
  /** null = no baseline for this leg (unknown, not zero). */
  callOiChg: number | null;
  /** Premium change vs baseline; null without a baseline or an LTP on either side. */
  callLtpChg: number | null;
  /** null = OI change unknown, or OI moved but the premium change is unknown. */
  callBuildUp: BuildUp | null;
  putOi: number;
  putOiChg: number | null;
  putLtpChg: number | null;
  putBuildUp: BuildUp | null;
}

export interface OiWallRow {
  strike: number;
  oi: number;
  oiChg: number | null;
  trend: WallTrend;
}

export interface OiRead {
  asOf: string;
  baselineAsOf: string | null;
  changeBasis: ChangeBasis;
  spot: number;
  expiry: string;
  source: string;
  units: OiUnits;
  /** Up to 6 strikes each side nearest spot, ascending. */
  strikes: OiStrikeRow[];
  /** Top 2 call-OI strikes ABOVE spot, biggest first. */
  resistance: OiWallRow[];
  /** Top 2 put-OI strikes BELOW spot, biggest first. */
  support: OiWallRow[];
  totals: {
    callOi: number;
    putOi: number;
    /** Whole-chain sum of known changes; null when no leg has a known change. */
    callOiChg: number | null;
    putOiChg: number | null;
    pcr: number | null;
    pcrChange: number | null;
  };
  /** Aggregate build-up over the `strikes` window (net OI change × summed premium change). */
  flow: { calls: BuildUp | null; puts: BuildUp | null };
  zone: {
    support: number | null;
    resistance: number | null;
    widthPct: number | null;
    /** 0 = at support, 100 = at resistance; may fall outside 0–100 if spot left the zone. */
    spotPositionPct: number | null;
  };
  read: string;
}

/** |OI change| below this share of OI is FLAT for build-up classification. */
export const FLAT_PCT = 0.02;
/** |OI change| below this share of OI is a STEADY wall. */
export const WALL_TREND_PCT = 0.05;
export const STRIKES_EACH_SIDE = 6;

export function oiUnitsOf(source: string | null | undefined): OiUnits {
  const s = (source ?? '').toUpperCase();
  if (s === 'NSE') return 'contracts';
  if (s === 'HUB' || s === 'ANGEL_ONE' || s === 'ANGEL_ONE_WS') return 'shares';
  return 'unknown';
}

/**
 * A snapshot whose every LTP is 0 is stale: pre-open / early rows carry
 * yesterday's OI with no trades yet, and reading them as "now" would report
 * a dead chain as today's walls. Empty chains are stale too.
 */
export function isStaleChain(strikes: readonly ChainStrike[] | null | undefined): boolean {
  if (!Array.isArray(strikes) || strikes.length === 0) return true;
  for (const s of strikes) {
    if (num(s?.ceData?.ltp) > 0 || num(s?.peData?.ltp) > 0) return false;
  }
  return true;
}

export function classifyBuildUp(oi: number, oiChg: number | null, ltpChg: number | null): BuildUp | null {
  if (oiChg === null) return null;
  const ref = Math.max(oi, oi - oiChg, 0);
  if (Math.abs(oiChg) < FLAT_PCT * ref || oiChg === 0) return 'FLAT';
  if (ltpChg === null || ltpChg === 0) return null;
  if (oiChg > 0) return ltpChg > 0 ? 'LONG_BUILDUP' : 'SHORT_BUILDUP';
  return ltpChg > 0 ? 'SHORT_COVERING' : 'LONG_UNWINDING';
}

export function wallTrend(oi: number, oiChg: number | null): WallTrend {
  if (oiChg === null) return 'UNKNOWN';
  const ref = Math.max(oi, oi - oiChg, 0);
  if (Math.abs(oiChg) < WALL_TREND_PCT * ref || oiChg === 0) return 'STEADY';
  return oiChg > 0 ? 'BUILT' : 'ABANDONED';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

interface LegCalc {
  oi: number;
  chg: number | null;
  ltpChg: number | null;
}

function legCalc(now: ChainLeg | null | undefined, base: ChainLeg | null | undefined, mode: ChangeBasis): LegCalc {
  const oi = num(now?.oi);
  if (mode === 'baseline') {
    if (!base) return { oi, chg: null, ltpChg: null };
    const ltpNow = num(now?.ltp);
    const ltpBase = num(base.ltp);
    return {
      oi,
      chg: oi - num(base.oi),
      ltpChg: ltpNow > 0 && ltpBase > 0 ? round2(ltpNow - ltpBase) : null,
    };
  }
  if (mode === 'chain') return { oi, chg: finiteOrNull(now?.oiChange), ltpChg: null };
  return { oi, chg: null, ltpChg: null };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
function fmt(n: number): string {
  return nf.format(Math.round(n));
}
function signed(n: number): string {
  if (n > 0) return `+${fmt(n)}`;
  if (n < 0) return `−${fmt(-n)}`;
  return '0';
}
function strikeStr(k: number): string {
  return Number.isInteger(k) ? String(k) : String(round2(k));
}

function trendPhrase(w: OiWallRow): string {
  switch (w.trend) {
    case 'BUILT':
      return `built ${signed(w.oiChg as number)}`;
    case 'ABANDONED':
      return `being abandoned ${signed(w.oiChg as number)}`;
    case 'STEADY':
      return 'steady';
    default:
      return 'change unknown';
  }
}

function wallsSentence(label: string, walls: OiWallRow[]): string | null {
  if (walls.length === 0) return null;
  const parts = walls.map((w) => `${strikeStr(w.strike)} (${fmt(w.oi)}, ${trendPhrase(w)})`);
  return `${label} ${parts.join(', then ')}.`;
}

const FLOW_PHRASE: Record<'calls' | 'puts', Record<BuildUp, string>> = {
  calls: {
    SHORT_BUILDUP: 'fresh call writing (resistance being built)',
    LONG_BUILDUP: 'call buying',
    SHORT_COVERING: 'call writers covering (resistance weakening)',
    LONG_UNWINDING: 'long unwinding, not fresh writing',
    FLAT: 'little change',
  },
  puts: {
    SHORT_BUILDUP: 'fresh put writing (support being built)',
    LONG_BUILDUP: 'put buying',
    SHORT_COVERING: 'put writers covering (support weakening)',
    LONG_UNWINDING: 'long unwinding, not fresh writing',
    FLAT: 'little change',
  },
};

function flowSentence(side: 'calls' | 'puts', totalChg: number | null, priceDir: number | null, flow: BuildUp | null): string | null {
  if (totalChg === null) return null;
  const word = side === 'calls' ? 'call' : 'put';
  if (flow === null || priceDir === null) return `Total ${word} OI ${signed(totalChg)}.`;
  const dir = priceDir > 0 ? 'up' : priceDir < 0 ? 'down' : 'flat';
  return `Total ${word} OI ${signed(totalChg)} with near-spot ${word} prices ${dir} = ${FLOW_PHRASE[side][flow]}.`;
}

/**
 * Build the OI read. Returns null when the latest chain is stale/empty or no
 * spot is known (an unsided read would put ITM strikes on the wrong side).
 */
export function oiRead(latest: ChainSnap, baseline: ChainSnap | null, spot: number): OiRead | null {
  if (!latest || isStaleChain(latest.strikes)) return null;
  const s = spot > 0 ? spot : num(latest.spot);
  if (!(s > 0)) return null;

  // A baseline is only usable if it is a different (earlier), live chain of
  // the SAME source — different sources report OI in different units.
  const base =
    baseline &&
    !isStaleChain(baseline.strikes) &&
    baseline.source === latest.source &&
    baseline.expiry === latest.expiry &&
    baseline.capturedAt.getTime() < latest.capturedAt.getTime()
      ? baseline
      : null;

  const strikesSorted = latest.strikes
    .filter((r) => r && Number.isFinite(r.strikePrice))
    .slice()
    .sort((a, b) => a.strikePrice - b.strikePrice);

  let mode: ChangeBasis = base ? 'baseline' : 'chain';
  if (mode === 'chain') {
    const anyChange = strikesSorted.some(
      (r) => finiteOrNull(r.ceData?.oiChange) !== null || finiteOrNull(r.peData?.oiChange) !== null,
    );
    if (!anyChange) mode = 'none';
  }
  const baseByStrike = new Map<number, ChainStrike>();
  if (base) for (const r of base.strikes) if (r) baseByStrike.set(r.strikePrice, r);

  const rows = strikesSorted.map((r) => {
    const b = baseByStrike.get(r.strikePrice);
    const ce = legCalc(r.ceData, b?.ceData, mode);
    const pe = legCalc(r.peData, b?.peData, mode);
    return { strike: r.strikePrice, ce, pe };
  });

  // ── totals (whole chain) ──
  let callOi = 0;
  let putOi = 0;
  let callChg: number | null = null;
  let putChg: number | null = null;
  for (const r of rows) {
    callOi += r.ce.oi;
    putOi += r.pe.oi;
    if (r.ce.chg !== null) callChg = (callChg ?? 0) + r.ce.chg;
    if (r.pe.chg !== null) putChg = (putChg ?? 0) + r.pe.chg;
  }
  const pcr = callOi > 0 ? round2(putOi / callOi) : null;
  let prevPcr: number | null = null;
  if (base) {
    let bc = 0;
    let bp = 0;
    for (const r of base.strikes) {
      bc += num(r?.ceData?.oi);
      bp += num(r?.peData?.oi);
    }
    prevPcr = bc > 0 ? bp / bc : null;
  } else if (callChg !== null && putChg !== null && callOi - callChg > 0) {
    prevPcr = (putOi - putChg) / (callOi - callChg);
  }
  const pcrChange = pcr !== null && prevPcr !== null ? round2(pcr - prevPcr) : null;

  // ── strikes window: up to 6 at/below spot and 6 above ──
  const below = rows.filter((r) => r.strike <= s).slice(-STRIKES_EACH_SIDE);
  const above = rows.filter((r) => r.strike > s).slice(0, STRIKES_EACH_SIDE);
  const windowRows = [...below, ...above];
  const strikes: OiStrikeRow[] = windowRows.map((r) => ({
    strike: r.strike,
    callOi: r.ce.oi,
    callOiChg: r.ce.chg,
    callLtpChg: r.ce.ltpChg,
    callBuildUp: classifyBuildUp(r.ce.oi, r.ce.chg, r.ce.ltpChg),
    putOi: r.pe.oi,
    putOiChg: r.pe.chg,
    putLtpChg: r.pe.ltpChg,
    putBuildUp: classifyBuildUp(r.pe.oi, r.pe.chg, r.pe.ltpChg),
  }));

  // ── walls (whole chain, OTM only) ──
  const resistance: OiWallRow[] = rows
    .filter((r) => r.strike > s && r.ce.oi > 0)
    .sort((a, b) => b.ce.oi - a.ce.oi || a.strike - b.strike)
    .slice(0, 2)
    .map((r) => ({ strike: r.strike, oi: r.ce.oi, oiChg: r.ce.chg, trend: wallTrend(r.ce.oi, r.ce.chg) }));
  const support: OiWallRow[] = rows
    .filter((r) => r.strike < s && r.pe.oi > 0)
    .sort((a, b) => b.pe.oi - a.pe.oi || b.strike - a.strike)
    .slice(0, 2)
    .map((r) => ({ strike: r.strike, oi: r.pe.oi, oiChg: r.pe.chg, trend: wallTrend(r.pe.oi, r.pe.chg) }));

  // ── aggregate flow over the window ──
  const flowOf = (pick: (r: (typeof windowRows)[number]) => LegCalc): { flow: BuildUp | null; priceDir: number | null } => {
    let oi = 0;
    let chg: number | null = null;
    let ltp: number | null = null;
    for (const r of windowRows) {
      const l = pick(r);
      oi += l.oi;
      if (l.chg !== null) chg = (chg ?? 0) + l.chg;
      if (l.ltpChg !== null) ltp = (ltp ?? 0) + l.ltpChg;
    }
    return { flow: classifyBuildUp(oi, chg, ltp), priceDir: ltp };
  };
  const callFlow = flowOf((r) => r.ce);
  const putFlow = flowOf((r) => r.pe);

  // ── zone ──
  const zs = support[0]?.strike ?? null;
  const zr = resistance[0]?.strike ?? null;
  const zone = {
    support: zs,
    resistance: zr,
    widthPct: zs !== null && zr !== null ? round2(((zr - zs) / s) * 100) : null,
    spotPositionPct: zs !== null && zr !== null && zr > zs ? Math.round(((s - zs) / (zr - zs)) * 100) : null,
  };

  // ── read ──
  const units = oiUnitsOf(latest.source);
  const sentences: string[] = [];
  const res = wallsSentence('Resistance', resistance);
  if (res) sentences.push(res);
  const flip = flipSentence(windowRows, s);
  if (flip) sentences.push(flip);
  const sup = wallsSentence('Support', support);
  if (sup) sentences.push(sup);
  const cf = flowSentence('calls', callChg, callFlow.priceDir, callFlow.flow);
  if (cf) sentences.push(cf);
  const pf = flowSentence('puts', putChg, putFlow.priceDir, putFlow.flow);
  if (pf) sentences.push(pf);
  if (pcr !== null) {
    sentences.push(
      pcrChange !== null && prevPcr !== null ? `PCR ${pcr.toFixed(2)} (was ${prevPcr.toFixed(2)}).` : `PCR ${pcr.toFixed(2)}.`,
    );
  }
  if (zone.spotPositionPct !== null) sentences.push(`Spot at ${zone.spotPositionPct}% of the ${zs}–${zr} zone.`);
  const basisNote =
    mode === 'baseline'
      ? `changes vs last session close (${base!.capturedAt.toISOString()})`
      : mode === 'chain'
        ? "changes from the chain's own OI change (no previous-session snapshot; premium change unknown)"
        : 'no OI change available';
  sentences.push(`OI in ${units}; ${basisNote}.`);

  return {
    asOf: latest.capturedAt.toISOString(),
    baselineAsOf: base ? base.capturedAt.toISOString() : null,
    changeBasis: mode,
    spot: s,
    expiry: latest.expiry,
    source: latest.source,
    units,
    strikes,
    resistance,
    support,
    totals: { callOi, putOi, callOiChg: callChg, putOiChg: putChg, pcr, pcrChange },
    flow: { calls: callFlow.flow, puts: putFlow.flow },
    zone,
    read: sentences.join(' '),
  };
}

/**
 * A near-spot strike changing sides: calls built while puts left = turning
 * into resistance; puts built while calls left = turning into support. Both
 * legs must move ≥ WALL_TREND_PCT of their OI. Nearest-to-spot wins.
 */
function flipSentence(rows: Array<{ strike: number; ce: LegCalc; pe: LegCalc }>, spot: number): string | null {
  const moved = (l: LegCalc, sign: 1 | -1) =>
    l.chg !== null && Math.sign(l.chg) === sign && Math.abs(l.chg) >= WALL_TREND_PCT * Math.max(l.oi, l.oi - l.chg, 1);
  const byDist = rows.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  for (const r of byDist) {
    if (moved(r.ce, 1) && moved(r.pe, -1)) {
      return `${strikeStr(r.strike)} turning into resistance (calls ${signed(r.ce.chg as number)}, puts ${signed(r.pe.chg as number)} — put writers left).`;
    }
    if (moved(r.pe, 1) && moved(r.ce, -1)) {
      return `${strikeStr(r.strike)} turning into support (puts ${signed(r.pe.chg as number)}, calls ${signed(r.ce.chg as number)} — call writers left).`;
    }
  }
  return null;
}
