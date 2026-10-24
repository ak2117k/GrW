import type { InfoItem } from './info';

/**
 * CHANNEL_INFO outcome of one INFO item on the underlying's DAILY bars (self-review, 2026-10-24).
 *
 * - base     = the last daily close at or before the post (a post after the session close uses that
 *              session's close; one during the session uses the previous close — close-to-close).
 * - judged   = the next session close after the post (horizon INTRADAY / DAYS / none) or the 5th
 *              (WEEKS). MONTHS is recorded but not judged (too long).
 * - band     = 0.3 × ATR14 at the base (× √5 for WEEKS): a move inside it is noise (FLAT → null).
 * - BULL right when the close-to-close return > +band, BEAR right when < −band.
 * - levelHit = any of the item's levels / target traded inside a bar between base and judged
 *              (null when the item has none). Separate from the direction verdict.
 */

export interface DailyBar {
  /** IST 'YYYY-MM-DD' of the session. */
  day: string;
  high: number;
  low: number;
  close: number;
}

export type InfoOutcomeStatus = 'RIGHT' | 'WRONG' | 'FLAT' | 'NOT_JUDGED_MONTHS' | 'NO_BIAS' | 'NO_DATA' | 'PENDING';

export interface InfoItemOutcome {
  status: InfoOutcomeStatus;
  /** The session the verdict belongs to (judged close); null when there is none yet. */
  session: string | null;
  baseClose: number | null;
  judgedClose: number | null;
  ret: number | null;
  band: number | null;
  levelHit: boolean | null;
}

export const INFO_BAND_ATR = 0.3;
export const INFO_WEEKS_SESSIONS = 5;
const ATR_N = 14;

const round = (x: number) => Math.round(x * 100) / 100;

function atrAt(bars: readonly DailyBar[], idx: number): number | null {
  const trs: number[] = [];
  for (let i = Math.max(1, idx - ATR_N + 1); i <= idx; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  if (trs.length === 0) {
    const b = bars[idx];
    return b && b.high > b.low ? b.high - b.low : null;
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/**
 * @param post IST day of the post and whether it came after that day's close on the item's exchange.
 */
export function judgeInfoItem(item: InfoItem, bars: readonly DailyBar[], post: { day: string; afterClose: boolean }): InfoItemOutcome {
  const none = (status: InfoOutcomeStatus, session: string | null = null): InfoItemOutcome => ({
    status, session, baseClose: null, judgedClose: null, ret: null, band: null, levelHit: null,
  });
  const sorted = [...bars].filter((b) => Number.isFinite(b.close) && b.close > 0).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  let baseIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].day < post.day || (sorted[i].day === post.day && post.afterClose)) baseIdx = i;
  }
  if (baseIdx < 0) return none('NO_DATA');
  const n = item.horizon === 'WEEKS' ? INFO_WEEKS_SESSIONS : 1;
  const next = sorted[baseIdx + 1];
  if (item.horizon === 'MONTHS') return next ? none('NOT_JUDGED_MONTHS', next.day) : none('PENDING');
  const judgedIdx = baseIdx + n;
  if (judgedIdx >= sorted.length) return none('PENDING');

  const base = sorted[baseIdx];
  const judged = sorted[judgedIdx];
  const lv = [...item.levels, ...(item.targetLevel !== null ? [item.targetLevel] : [])];
  let levelHit: boolean | null = lv.length ? false : null;
  for (let i = baseIdx + 1; i <= judgedIdx && lv.length; i++) {
    if (lv.some((x) => sorted[i].low <= x && x <= sorted[i].high)) levelHit = true;
  }
  const atr = atrAt(sorted, baseIdx);
  const band = atr !== null ? INFO_BAND_ATR * atr * Math.sqrt(n) : null;
  const ret = judged.close - base.close;
  const common = { session: judged.day, baseClose: base.close, judgedClose: judged.close, ret: round(ret), band: band !== null ? round(band) : null, levelHit };
  if (item.bias !== 'BULL' && item.bias !== 'BEAR') return { status: 'NO_BIAS', ...common };
  if (band === null) return { status: 'NO_DATA', ...common };
  const signed = item.bias === 'BULL' ? ret : -ret;
  const status: InfoOutcomeStatus = signed > band ? 'RIGHT' : signed < -band ? 'WRONG' : 'FLAT';
  return { status, ...common };
}

/** right / wrong / null, as the self-review stores it. */
export function infoOutcomeCorrect(status: string | null | undefined): boolean | null {
  if (status === 'RIGHT') return true;
  if (status === 'WRONG') return false;
  return null;
}
