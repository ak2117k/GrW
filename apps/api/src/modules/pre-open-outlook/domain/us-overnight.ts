import { eventLabel, type MarketEvent } from '../../../common/utils/market-events';
import { chartMove, priceAt, type GlobalChart, type GlobalMove } from './global-chart';
import { OUTLOOK_UNIVERSE } from './outlook';

/**
 * US OVERNIGHT section of the 08:30 pre-open outlook (2026-11-03, US midterm results night).
 * VOLATILITY / GAP-SIZE awareness only — it never calls a direction. Pure: no I/O, no clock.
 *
 *   ES=F    S&P 500 futures % since the Indian close (15:30 IST previous NSE session) and since its
 *           own previous daily settle (Yahoo meta.previousClose, live reads only).
 *   CL=F    WTI % since the Indian close.
 *   VIX     India VIX last close → a typical day's move ≈ VIX / √252 % (1σ, the standard reading).
 *   gap     estimated NIFTY opening-gap SIZE = |ES % since the Indian close| × {@link US_OVERNIGHT.esNiftyBeta}
 *           — the same rough ES→NIFTY beta the outlook already uses when GIFT Nifty is unavailable
 *           (OUTLOOK_UNIVERSE.NIFTY.beta['ES=F']). An ESTIMATE of size, not of sign.
 *   event   an active MARKET_EVENT_DAYS entry → "expect a bigger-than-usual opening move; direction not predicted".
 */
export const US_OVERNIGHT = Object.freeze({
  esNiftyBeta: OUTLOOK_UNIVERSE.NIFTY.beta['ES=F'],
  tradingDaysPerYear: 252,
});

export interface UsOvernightInput {
  at: Date;
  /** NIFTY's last close (the Indian close) — time and price; null when unknown. */
  indianClose: { price: number; at: Date } | null;
  es: { chart: GlobalChart | null; source: string; why?: string };
  crude: { chart: GlobalChart | null; source: string; why?: string };
  vix: { close: number; at: Date } | null;
  events: readonly MarketEvent[];
}

export interface UsOvernight {
  at: string;
  indianCloseAt: string | null;
  es: { sinceIndianClose: GlobalMove | null; sinceOwnClose: { pct: number; from: number; to: number } | null };
  crude: GlobalMove | null;
  vix: { close: number; at: string; typicalDayMovePct: number } | null;
  /** Estimated NIFTY opening-gap SIZE (unsigned). */
  gapEstimate: { sizePct: number; sizePoints: number | null; basis: string } | null;
  events: Array<{ date: string; name: string; label: string }>;
  lines: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
const usable = (m: GlobalMove | null): m is GlobalMove & { movePct: number } => !!m && m.status !== 'NO_DATA' && m.movePct !== null;

export function usOvernightOf(i: UsOvernightInput): UsOvernight {
  const now = i.at.getTime();
  const closeT = i.indianClose?.at.getTime() ?? null;
  const move = (c: UsOvernightInput['es']): GlobalMove | null =>
    closeT === null ? null : chartMove(c.chart, closeT, now, c.source, c.why);

  const esMove = move(i.es);
  const crude = move(i.crude);
  let sinceOwnClose: UsOvernight['es']['sinceOwnClose'] = null;
  const prev = i.es.chart?.previousClose ?? null;
  const last = i.es.chart ? priceAt(i.es.chart, now) : null;
  if (prev && prev > 0 && last) sinceOwnClose = { pct: r2(((last.price - prev) / prev) * 100), from: prev, to: r2(last.price) };

  const vix = i.vix && i.vix.close > 0
    ? { close: r2(i.vix.close), at: i.vix.at.toISOString(), typicalDayMovePct: r2(i.vix.close / Math.sqrt(US_OVERNIGHT.tradingDaysPerYear)) }
    : null;

  const gapEstimate = usable(esMove)
    ? (() => {
        const sizePct = r2(Math.abs(esMove.movePct) * US_OVERNIGHT.esNiftyBeta);
        return {
          sizePct,
          sizePoints: i.indianClose ? Math.round((i.indianClose.price * sizePct) / 100) : null,
          basis: `|ES=F % since the Indian close| × ${US_OVERNIGHT.esNiftyBeta} (rough ES→NIFTY beta) — an estimate of size, not direction`,
        };
      })()
    : null;

  const events = i.events.map((e) => ({ date: e.date, name: e.name, label: eventLabel(e.name) }));

  const lines: string[] = [];
  const esParts: string[] = [];
  if (usable(esMove)) esParts.push(`${signed(esMove.movePct)}% since the Indian close${esMove.status === 'STALE' ? ` (STALE: ${esMove.reason})` : ''}`);
  else esParts.push(`n/a since the Indian close (${esMove?.reason ?? (closeT === null ? 'no Indian close' : 'no data')})`);
  if (sinceOwnClose) esParts.push(`${signed(sinceOwnClose.pct)}% since its own previous close`);
  lines.push(`S&P 500 futures (ES=F): ${esParts.join(', ')}`);
  lines.push(usable(crude) ? `WTI crude (CL=F): ${signed(crude.movePct)}% since the Indian close${crude.status === 'STALE' ? ' (STALE)' : ''}` : `WTI crude (CL=F): n/a (${crude?.reason ?? 'no data'})`);
  lines.push(vix ? `India VIX last close ${vix.close} → a typical day's move ≈ ±${vix.typicalDayMovePct.toFixed(2)}% (VIX/√252)` : 'India VIX: n/a');
  if (gapEstimate) lines.push(`Estimated NIFTY opening-gap size ≈ ${gapEstimate.sizePct.toFixed(2)}%${gapEstimate.sizePoints !== null ? ` (~${gapEstimate.sizePoints} pts)` : ''} — ESTIMATE: |ES move| × ${US_OVERNIGHT.esNiftyBeta}; size only, direction not predicted`);
  for (const e of events) lines.push(`Event: ${e.label} — expect a bigger-than-usual opening move; direction not predicted`);

  return {
    at: i.at.toISOString(),
    indianCloseAt: i.indianClose ? i.indianClose.at.toISOString() : null,
    es: { sinceIndianClose: esMove, sinceOwnClose },
    crude,
    vix,
    gapEstimate,
    events,
    lines,
  };
}
