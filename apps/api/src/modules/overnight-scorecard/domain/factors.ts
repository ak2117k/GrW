/**
 * The seven factor computers of the overnight scorecard (design §2). Pure functions: inputs are
 * already-read data, output is one FactorScore. Missing data ⇒ `available:false`, 0 points, and a
 * reason naming what was missing — never a guessed zero dressed as a reading.
 *
 * Every computer first forms a MARKET-direction vote (+ = bullish for the underlying), then
 * `orient`s it to the position's side — except expiry and mood, which are direction-free by design
 * (§9: expiry only ever penalises long options; mood is volatility context, never a direction vote).
 */
import type { ChainSnapshotRow } from '../../mbm/domain/chain-snapshot';
import type { CueRecord, FiiDerivatives, FiiDiiCash } from '../../market-cues/market-cues.types';
import type { FactorScore } from '../scorecard.types';
import { lastEma, macdHistogram, median, rsi } from './indicators';
import { factor, orient, unavailable, type Side } from './scoring';

const f1 = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1));
const f2 = (n: number) => n.toFixed(2);
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(0)}%`;

// ─── OI / option chain ───────────────────────────────────────────────────────

/** PCR this far above (below) its own 5-session median is a bullish (bearish) put-writing tilt. */
export const PCR_TILT = 0.15;
/** Absolute PCR fallback when there is no history yet. */
export const PCR_HIGH = 1.3;
export const PCR_LOW = 0.7;
/** Strikes either side of ATM summed for the build-up read. */
export const BUILD_STRIKES = 3;
/** One side's ΔOI must beat the other's by this fraction to vote. */
export const BUILD_EDGE = 0.2;

export interface OiInput {
  /** The newest snapshot (today's EOD, or the latest intraday one). */
  latest: ChainSnapshotRow | null;
  /** Earlier snapshots, one per prior session (for the PCR median). */
  history: readonly ChainSnapshotRow[];
}

export function scoreOi(input: OiInput, side: Side): FactorScore {
  const c = input.latest;
  if (!c) return unavailable('oi', 'no option-chain snapshot for this symbol yet');
  if (c.pcr == null || !Number.isFinite(c.spot) || c.spot <= 0) return unavailable('oi', 'chain snapshot has no PCR/spot');

  const parts: string[] = [];
  const reasons: string[] = [];
  let vote = 0;

  // 1) PCR vs its own 5-session median (absolute bands until there is history).
  const med = median(input.history.slice(-5).map((h) => h.pcr ?? NaN));
  if (med != null && med > 0) {
    parts.push(`PCR ${f2(c.pcr)} (5d med ${f2(med)})`);
    if (c.pcr >= med * (1 + PCR_TILT)) { vote += 1; reasons.push('PCR above its median (put writing)'); }
    else if (c.pcr <= med * (1 - PCR_TILT)) { vote -= 1; reasons.push('PCR below its median (call writing)'); }
  } else {
    parts.push(`PCR ${f2(c.pcr)}`);
    if (c.pcr >= PCR_HIGH) { vote += 1; reasons.push('high PCR'); }
    else if (c.pcr <= PCR_LOW) { vote -= 1; reasons.push('low PCR'); }
  }

  // 2) ΔOI build-up at ±3 strikes around spot: put writing bullish, call writing bearish.
  const near = nearStrikes(c, BUILD_STRIKES);
  const ceChg = sum(near.map((s) => s.ce?.oi_chg));
  const peChg = sum(near.map((s) => s.pe?.oi_chg));
  const ceOi = sum(near.map((s) => s.ce?.oi));
  const peOi = sum(near.map((s) => s.pe?.oi));
  if (ceChg != null && peChg != null) {
    const atm = near.length ? near[Math.floor(near.length / 2)].strike : null;
    const base = Math.max(Math.abs(ceChg), Math.abs(peChg), 1);
    if (peChg > 0 && peChg - ceChg > BUILD_EDGE * base) {
      vote += 1;
      parts.push(`put build ${pctOf(peChg, peOi)}${atm ? ` @${atm}` : ''}`);
      reasons.push('puts written near spot');
    } else if (ceChg > 0 && ceChg - peChg > BUILD_EDGE * base) {
      vote -= 1;
      parts.push(`call build ${pctOf(ceChg, ceOi)}${atm ? ` @${atm}` : ''}`);
      reasons.push('calls written near spot');
    }
  }

  // 3) Spot vs the walls: through the call wall is bullish, under the put wall bearish.
  if (c.callWall != null && c.putWall != null) {
    parts.push(`walls ${c.putWall}/${c.callWall}`);
    if (c.spot > c.callWall) { vote += 1; reasons.push('spot above the call wall'); }
    else if (c.spot < c.putWall) { vote -= 1; reasons.push('spot below the put wall'); }
  }
  if (c.maxPain != null) parts.push(`max pain ${c.maxPain}`);

  const tilt = vote > 0 ? 'bullish' : vote < 0 ? 'bearish' : 'neutral';
  return factor('oi', orient(vote, side), parts.join(', '), `${tilt} positioning${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
}

function nearStrikes(c: ChainSnapshotRow, n: number) {
  const rows = [...c.strikes].sort((a, b) => a.strike - b.strike);
  if (rows.length === 0) return [];
  let atm = 0;
  for (let i = 1; i < rows.length; i++) if (Math.abs(rows[i].strike - c.spot) < Math.abs(rows[atm].strike - c.spot)) atm = i;
  return rows.slice(Math.max(0, atm - n), atm + n + 1);
}

function sum(xs: ReadonlyArray<number | null | undefined>): number | null {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) : null;
}

function pctOf(chg: number, oi: number | null): string {
  const prior = oi != null ? oi - chg : 0;
  return prior > 0 ? pct((chg / prior) * 100) : `+${f1(chg)}`;
}

// ─── FII / DII ───────────────────────────────────────────────────────────────

/** ₹ crore of FII cash net that counts as a vote. */
export const FII_CASH_MIN_CR = 1000;
/** Change of FII index-futures long share (percentage points) that counts as a vote. */
export const FII_LONG_SHARE_MIN_PP = 1;

export interface FiiInput {
  fiiDii: CueRecord<FiiDiiCash> | null;
  fiiOi: CueRecord<FiiDerivatives> | null;
}

export function scoreFiiDii(input: FiiInput, side: Side): FactorScore {
  const cash = input.fiiDii?.status !== 'unavailable' ? input.fiiDii?.values ?? null : null;
  const fo = input.fiiOi?.status !== 'unavailable' ? input.fiiOi?.values ?? null : null;
  if (!cash && !fo) return unavailable('fii_dii', 'no FII/DII cash or FII index-OI reading (market cues off or not fetched)');

  const parts: string[] = [];
  const reasons: string[] = [];
  let vote = 0;
  if (cash) {
    const fii = cash.fii.net;
    const dii = cash.dii?.net ?? null;
    parts.push(`FII ${fii >= 0 ? '+' : ''}${f1(fii)}cr${dii != null ? `, DII ${dii >= 0 ? '+' : ''}${f1(dii)}cr` : ''} (${cash.date})`);
    if (fii >= FII_CASH_MIN_CR) { vote += 1; reasons.push('FII net buyers'); }
    else if (fii <= -FII_CASH_MIN_CR) {
      // DII as a cushion: FII selling fully absorbed by DII buying is not a bearish vote.
      if (dii != null && dii >= -fii) reasons.push('FII selling absorbed by DII');
      else { vote -= 1; reasons.push('FII net sellers'); }
    }
  }
  if (fo) {
    const share = longShare(fo.indexFutures);
    if (share != null) {
      let s = `FII idx-fut long ${share.toFixed(0)}%`;
      if (fo.change) {
        const prev = longShare({
          long: fo.indexFutures.long - fo.change.indexFutures.long,
          short: fo.indexFutures.short - fo.change.indexFutures.short,
        });
        if (prev != null) {
          const d = share - prev;
          s += ` (${d >= 0 ? '+' : ''}${d.toFixed(1)}pp)`;
          if (d >= FII_LONG_SHARE_MIN_PP) { vote += 1; reasons.push('FII adding index longs'); }
          else if (d <= -FII_LONG_SHARE_MIN_PP) { vote -= 1; reasons.push('FII adding index shorts'); }
        }
      }
      parts.push(s);
    }
  }
  const tilt = vote > 0 ? 'supportive flows' : vote < 0 ? 'adverse flows' : 'flows neutral';
  return factor('fii_dii', orient(vote, side), parts.join(', ') || 'n/a', `${tilt}${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
}

function longShare(ls: { long: number; short: number }): number | null {
  const t = ls.long + ls.short;
  return t > 0 ? (ls.long / t) * 100 : null;
}

// ─── India VIX ───────────────────────────────────────────────────────────────

/** Fewest daily VIX closes the factor needs. */
export const VIX_MIN_DAYS = 5;
/** VIX this far above its 20-day mean is "elevated". */
export const VIX_ELEVATED = 0.1;
/** Day-on-day change that counts as rising / falling. */
export const VIX_MOVE = 0.05;

export interface VixInput {
  /** Daily India VIX closes, oldest first; the last is the latest session. */
  closes: readonly number[] | null;
  isLongOption: boolean;
  isIndex: boolean;
}

export function scoreVix(input: VixInput, side: Side): FactorScore {
  const c = (input.closes ?? []).filter((x) => Number.isFinite(x) && x > 0);
  if (c.length < VIX_MIN_DAYS) return unavailable('vix', `fewer than ${VIX_MIN_DAYS} daily India VIX closes`);
  const last = c[c.length - 1];
  const prev = c[c.length - 2];
  const window = c.slice(-21, -1);
  const avg = window.reduce((s, x) => s + x, 0) / window.length;
  const chg = (last - prev) / prev;
  const elevated = last >= avg * (1 + VIX_ELEVATED);
  const rising = chg >= VIX_MOVE;
  const falling = chg <= -VIX_MOVE;
  const value = `VIX ${f2(last)} (${window.length}d avg ${f2(avg)}, ${pct(chg * 100)} d/d)`;

  let points = 0;
  const reasons: string[] = [];
  if (input.isLongOption) {
    // A HELD long option (either side): the crush risk is a RICH VIX mean-reverting; a rising VIX
    // lifts the premium (vega tailwind); an elevated VIX already falling is the crush under way.
    if (elevated) { points -= 1; reasons.push('rich VIX: crush risk if it mean-reverts'); }
    if (rising) { points += 1; reasons.push('rising VIX: vega tailwind for a long option'); }
    else if (falling && elevated) { points -= 1; reasons.push('VIX deflating'); }
  }
  if (input.isIndex && (rising || falling)) {
    // Directional for the index: rising VIX is bearish, falling bullish.
    points += orient(rising ? -1 : 1, side);
    reasons.push(rising ? 'rising VIX leans bearish for the index' : 'falling VIX leans bullish for the index');
  }
  // factor() clamps to −2…+2 (a rich, deflating VIX on an index long option can sum past it).
  return factor('vix', points, value, reasons.length ? reasons.join('; ') : 'VIX context only (no vote for this position)');
}

// ─── Expiry ──────────────────────────────────────────────────────────────────

export interface ExpiryInput {
  /** A long CE/PE: the only kind the factor scores (it never "supports" anything). */
  isLongOption: boolean;
  isOption: boolean;
  expiry: string | null;
  /** From `daysToExpiry` (null when the expiry is unknown). */
  dte: { calendarDays: number; tradingSessionsLeft: number } | null;
  /** Calendar days from now to the next session open (a weekend/holiday gap is ≥ 2). */
  gapDays: number | null;
}

export function scoreExpiry(input: ExpiryInput): FactorScore {
  if (!input.isOption) return factor('expiry', 0, 'no option expiry', 'not an option: no theta decay to score');
  if (!input.dte) return unavailable('expiry', 'option expiry unknown');
  const { calendarDays, tradingSessionsLeft } = input.dte;
  const gap = input.gapDays ?? 1;
  const value = `${tradingSessionsLeft} sessions / ${calendarDays}d to ${input.expiry}${gap >= 2 ? `, ${Math.floor(gap)}d gap to next open` : ''}`;
  if (!input.isLongOption) return factor('expiry', 0, value, 'short option: decay works for the seller (never a support vote in v1)');
  let p = 0;
  if (tradingSessionsLeft <= 2) p = -2;
  else if (tradingSessionsLeft <= 5) p = -1;
  if (gap >= 2 && tradingSessionsLeft <= 10) p -= 1; // a holiday/weekend gap is decay with no session
  const reason =
    p === 0 ? 'expiry far enough: little overnight theta' : `theta pressure on a long option${gap >= 2 ? ' across a non-trading gap' : ''}`;
  return factor('expiry', Math.max(p, -2), value, reason);
}

// ─── News on the stock ───────────────────────────────────────────────────────

export const NSE_ANNOUNCEMENTS_SOURCE = 'NSE Announcements';
/** NSE announcements weigh more than media (design §2). */
export const NSE_WEIGHT = 1.5;
export const NEWS_STRONG = 0.6;
export const NEWS_MILD = 0.3;

export interface NewsArticleLite {
  id: string;
  title: string;
  source: string;
  sentiment: string | null;
  sentimentScore: number | null;
  publishedAt: Date;
}

export function newsStrength(a: Pick<NewsArticleLite, 'source' | 'sentiment' | 'sentimentScore'>): number {
  const raw = a.sentimentScore ?? (a.sentiment === 'bullish' ? 0.5 : a.sentiment === 'bearish' ? -0.5 : 0);
  if (!Number.isFinite(raw)) return 0;
  return raw * (a.source === NSE_ANNOUNCEMENTS_SOURCE ? NSE_WEIGHT : 1);
}

/** `articles` null = the news read failed; [] = it worked and found nothing. */
export function scoreNews(articles: readonly NewsArticleLite[] | null, side: Side): FactorScore {
  if (articles == null) return unavailable('news', 'news read failed');
  if (articles.length === 0) return factor('news', 0, 'no tagged news since the close', 'no news on the stock');
  const best = [...articles].sort((a, b) => Math.abs(newsStrength(b)) - Math.abs(newsStrength(a)))[0];
  const s = newsStrength(best);
  const mag = Math.abs(s) >= NEWS_STRONG ? 2 : Math.abs(s) >= NEWS_MILD ? 1 : 0;
  const vote = Math.sign(s) * mag;
  const title = best.title.length > 90 ? `${best.title.slice(0, 89)}…` : best.title;
  return factor(
    'news',
    orient(vote, side),
    `${s >= 0 ? '+' : ''}${f2(s)} ${best.source}: "${title}" (${articles.length} item${articles.length > 1 ? 's' : ''})`,
    mag === 0 ? 'news is mild/neutral' : `${s > 0 ? 'positive' : 'negative'} ${mag === 2 ? 'strong ' : ''}news`,
  );
}

// ─── Indicators ──────────────────────────────────────────────────────────────

/** Daily bars needed for MACD(12,26,9). */
export const DAILY_MIN_BARS = 35;
export const M15_WEIGHT = 0.5;

export interface IndicatorInput {
  dailyCloses: readonly number[] | null;
  m15Closes: readonly number[] | null;
  /** Validated MBM daily setups that fired on the last session (NIFTY only today). */
  setups: ReadonlyArray<{ setup: string; action: string }>;
}

/** One timeframe's vote in −3…+3: EMA9 vs EMA20, MACD histogram sign (+slope), RSI14 zone. */
export function timeframeVote(closes: readonly number[]): { vote: number; text: string } | null {
  const e9 = lastEma(closes, 9);
  const e20 = lastEma(closes, 20);
  const m = macdHistogram(closes);
  const r = rsi(closes, 14);
  if (e9 == null || e20 == null || m == null || r == null) return null;
  let vote = e9 > e20 ? 1 : e9 < e20 ? -1 : 0;
  if (m.hist > 0 && m.hist >= m.prevHist) vote += 1;
  else if (m.hist < 0 && m.hist <= m.prevHist) vote -= 1;
  if (r >= 55 && r < 75) vote += 1;
  else if (r <= 45 && r > 25) vote -= 1;
  const text = `EMA9${e9 > e20 ? '>' : e9 < e20 ? '<' : '='}EMA20, MACD h ${m.hist >= 0 ? '+' : ''}${f2(m.hist)}${
    m.hist >= m.prevHist ? '↑' : '↓'
  }, RSI ${r.toFixed(0)}`;
  return { vote, text };
}

export function scoreIndicators(input: IndicatorInput, side: Side): FactorScore {
  const daily = input.dailyCloses && input.dailyCloses.length >= DAILY_MIN_BARS ? timeframeVote(input.dailyCloses) : null;
  if (!daily) return unavailable('indicators', `fewer than ${DAILY_MIN_BARS} daily candles`);
  const m15 = input.m15Closes && input.m15Closes.length >= DAILY_MIN_BARS ? timeframeVote(input.m15Closes) : null;
  let raw = daily.vote + (m15 ? M15_WEIGHT * m15.vote : 0);
  const fired: string[] = [];
  for (const s of input.setups) {
    if (s.action === 'LONG_SETUP') { raw += 1; fired.push(s.setup); }
    else if (s.action === 'EXIT_OR_TIGHTEN_LONGS') { raw -= 1; fired.push(s.setup); }
  }
  const vote = raw >= 2.5 ? 2 : raw >= 1 ? 1 : raw <= -2.5 ? -2 : raw <= -1 ? -1 : 0;
  const value = [`D: ${daily.text}`, m15 ? `15m: ${m15.text}` : '15m n/a', ...(fired.length ? [`setup ${fired.join(',')}`] : [])].join('; ');
  const tilt = vote > 0 ? 'bullish' : vote < 0 ? 'bearish' : 'mixed';
  return factor('indicators', orient(vote, side), value, `${tilt} technicals (raw ${raw >= 0 ? '+' : ''}${raw})`);
}

// ─── Market mood (MBM) ───────────────────────────────────────────────────────

export interface MoodInput {
  behaviour: {
    status: 'ok' | 'stale' | 'absent';
    horizons?: Record<string, { p: number; regime: string }>;
    /**
     * Set only when the horizons are the last session's STORED predictions (mbm_predictions), used
     * because the live model is not running (after hours): the as-of instant of the newest one.
     */
    storedAsOf?: Date | null;
  } | null;
  isIndex: boolean;
  isLongOption: boolean;
}

/** 'YYYY-MM-DD HH:MM IST' for a stored prediction's as-of. */
export function istLabel(at: Date): string {
  const iso = new Date(at.getTime() + 5.5 * 3600_000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} IST`;
}

const moodValue = (b: NonNullable<MoodInput['behaviour']>, k: string, hz: { p: number; regime: string }, prefix: string): string =>
  `${prefix}${hz.regime} (${k}, p ${f2(hz.p)}${b.storedAsOf ? `, as of ${istLabel(b.storedAsOf)}` : ''})`;

/** Horizon key → minutes, for picking the longest ('30m', '2h', '1d'). */
function horizonMinutes(k: string): number {
  const m = /^(\d+)\s*(m|h|d)$/i.exec(k.trim());
  if (!m) return 0;
  return Number(m[1]) * (m[2].toLowerCase() === 'm' ? 1 : m[2].toLowerCase() === 'h' ? 60 : 1440);
}

export function scoreMood(input: MoodInput): FactorScore {
  const b = input.behaviour;
  if (!input.isIndex) {
    // Stocks get NIFTY's mood as context (shown, never a vote): the model is index-only.
    const ok = b && b.status === 'ok' && b.horizons && Object.keys(b.horizons).length > 0;
    if (!ok) return factor('mood', 0, 'NIFTY mood n/a (model runs in session)', 'stock position: index context only');
    const [k, hz] = Object.entries(b.horizons!).sort((a, c) => horizonMinutes(c[0]) - horizonMinutes(a[0]))[0];
    return factor('mood', 0, moodValue(b!, k, hz, 'NIFTY '), 'stock position: index context only, no vote');
  }
  if (!b || b.status !== 'ok' || !b.horizons || Object.keys(b.horizons).length === 0) {
    return unavailable('mood', `MBM behaviour ${b?.status ?? 'absent'}`);
  }
  const [key, h] = Object.entries(b.horizons).sort((a, c) => horizonMinutes(c[0]) - horizonMinutes(a[0]))[0];
  const value = moodValue(b, key, h, '');
  if (!input.isLongOption) return factor('mood', 0, value, 'volatility context only (not a long option)');
  // Move-size, never direction: a long option needs a move; a QUIET tape is decay with no move.
  if (h.regime === 'ACTIVE') return factor('mood', 1, value, 'ACTIVE tape: a move is likely (either way)');
  if (h.regime === 'QUIET') return factor('mood', -1, value, 'QUIET tape: decay without a move');
  return factor('mood', 0, value, 'normal tape');
}
