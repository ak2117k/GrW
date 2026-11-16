/**
 * The AI entry judge's pure parts (owner 2026-11-16, correctness review F4): the system prompt (the owner's
 * method), the JSON schema, the reply parser, and two deterministic readings put in front of the judge —
 * ROOM to the next level in the trade's direction and the QUALITY of the option-chain data. Pure: no I/O.
 */

export type EntryDirection = 'BULLISH' | 'BEARISH';
export type EntryDecision = 'ENTER' | 'WAIT' | 'SKIP';

export interface EntryVerdict {
  decision: EntryDecision;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  checks: { topDown: string; room: string; oi: string; recentExit: string; newsEvents: string };
}

export const ENTRY_JUDGE_SYSTEM = [
  'You decide whether to OPEN a new option position on an Indian index, stock or MCX commodity. An engine has proposed it (candidate.source) for a direction (candidate.direction: BULLISH = buy a CE, BEARISH = buy a PE) with its own reasons (candidate.engineReasons). The engines enter on simple rules; your job is the owner\'s full analysis. Answer ENTER only when that analysis supports entering NOW; WAIT when it may support it later (a pullback, a level to clear, a reversal to fail); SKIP when it does not.',
  '',
  'The owner\'s method, in this order:',
  '1. TOP-DOWN TREND (indicators): for each timeframe 1d, 1h, 30m, 15m, 3m — trend (EMA20 vs EMA80), whether MACD agrees (histogram sign and slope), where price sits against the EMAs (an EMA being tested is a level), and the swing structure (higher highs/lows, lower highs/lows, range). 1d is the higher-timeframe bias. Enter with the bias only when the intermediate timeframes (1h/30m/15m) agree and the lowest (15m/3m) is not reversing against the trade. A daily trend in your favour while the 3m/15m are making a counter-move (price back above VWAP / EMA20, higher lows for a PE, lower highs for a CE) is a WAIT, not an ENTER. A timeframe marked unavailable or stale is unseen — say so.',
  '2. MACD AGREEMENT: a trend whose MACD is turning against it is weakening — a warning, not a confirmation.',
  '3. OI (oi.read): put OI marks support, call OI resistance; price rarely breaks a heavy wall without strong news. A wall being BUILT in the trade\'s way is a reason not to enter; one being ABANDONED may let price through. oi.quality THIN or NO_DATA means the chain says nothing — never treat it as confirmation.',
  '4. ROOM (room): the distance from the price to the next level in the trade\'s direction — the previous day\'s low/high, today\'s low/high, the nearest OI wall — in daily ATR and in N15 (the 15m ATR). Little room (under ~0.5 daily ATR or ~1.5 N15 to a level that held before) means the move is likely spent: WAIT for a clean break and retest instead of buying into the level. Also look at how far price has ALREADY moved in the trade\'s direction in the last 30–60 minutes: entering after an extended move (well over 1.5 N15) is chasing.',
  '5. RECENT EXITS (recentExits): today\'s closed trades on this underlying. If the AI or a rule exited a trade in the SAME direction at a loss recently, entering again needs the reason for that exit to have CLEARED — e.g. the counter-move that caused it has failed (price back past the level the exit note names: "inv …", the underlying at exit "u …") and the structure has turned back. Name what cleared, or WAIT. Never re-enter just because time has passed.',
  '6. NEWS & EVENTS (news, events): an instrument headline or an event outcome against the direction outweighs the chart; a strong one for it can justify entering through a level. An event due shortly (minutesAway small) is a risk to name.',
  '',
  'Rules for the answer: cite the fields you used (e.g. "indicators.timeframes.15m", "room.toPrevDay", "oi.read.support"). Be specific with prices. Keep "reason" to two or three sentences a trader can act on. When in real doubt, WAIT — a missed entry costs nothing, a bad one costs money.',
  'Reply with JSON only: {"decision":"ENTER|WAIT|SKIP","confidence":"low|medium|high","reason":"…","checks":{"topDown":"…","room":"…","oi":"…","recentExit":"…","newsEvents":"…"}}',
].join('\n');

export const ENTRY_JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'confidence', 'reason', 'checks'],
  properties: {
    decision: { type: 'string', enum: ['ENTER', 'WAIT', 'SKIP'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reason: { type: 'string' },
    checks: {
      type: 'object',
      additionalProperties: false,
      required: ['topDown', 'room', 'oi', 'recentExit', 'newsEvents'],
      properties: {
        topDown: { type: 'string' },
        room: { type: 'string' },
        oi: { type: 'string' },
        recentExit: { type: 'string' },
        newsEvents: { type: 'string' },
      },
    },
  },
} as const;

const stripFences = (t: string) => t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

/** The judge's reply → a verdict. Throws with a stated cause on anything malformed (the caller fails closed). */
export function parseEntryVerdict(message: unknown): EntryVerdict {
  const m = message as { stop_reason?: string; content?: Array<{ type: string; text?: string }> } | null;
  if (!m) throw new Error('no reply');
  if (m.stop_reason === 'refusal') throw new Error('the model declined');
  if (m.stop_reason === 'max_tokens') throw new Error('the verdict was cut off (max_tokens)');
  const text = (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  if (!text) throw new Error('empty reply');
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(stripFences(text)) as Record<string, unknown>;
  } catch {
    throw new Error('reply is not JSON');
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('reply is not an object');
  if (o.decision !== 'ENTER' && o.decision !== 'WAIT' && o.decision !== 'SKIP') throw new Error(`decision ${JSON.stringify(o.decision)}`);
  const confidence = o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low' ? o.confidence : 'low';
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim().slice(0, 600) : '';
  if (!reason) throw new Error('no reason');
  const c = (o.checks ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof c[k] === 'string' ? (c[k] as string).slice(0, 400) : '');
  return { decision: o.decision, confidence, reason, checks: { topDown: s('topDown'), room: s('room'), oi: s('oi'), recentExit: s('recentExit'), newsEvents: s('newsEvents') } };
}

interface LevelsLike { prevDayHigh: number | null; prevDayLow: number | null; todayHigh: number | null; todayLow: number | null; dailyAtr14: number | null }
interface WallLike { strike: number; oi?: number | null; oiChg?: number | null; trend?: string }
interface OiReadLike {
  support?: WallLike[];
  resistance?: WallLike[];
  totals?: { callOi?: number | null; putOi?: number | null };
  changeBasis?: string;
  units?: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Room in the trade's direction: distance from the price to the previous day's low (BEARISH) / high (BULLISH),
 * today's low / high, and the nearest OI wall on that side — in daily ATR and N15. A level already crossed
 * reads `crossed`. Pure; null fields when unreadable.
 */
export function entryRoom(i: { direction: EntryDirection; price: number | null; levels: LevelsLike | null; n15: number | null; oiRead: OiReadLike | null }) {
  const p = i.price;
  const atr = i.levels?.dailyAtr14 ?? null;
  const bear = i.direction === 'BEARISH';
  const dist = (lvl: number | null | undefined) => {
    if (p === null || !(p > 0) || lvl === null || lvl === undefined || !(lvl > 0)) return null;
    const d = bear ? p - lvl : lvl - p;
    return {
      level: lvl,
      points: r2(d),
      dailyAtr: atr && atr > 0 ? r2(d / atr) : null,
      n15: i.n15 && i.n15 > 0 ? r2(d / i.n15) : null,
      ...(d < 0 ? { crossed: true } : {}),
    };
  };
  const walls = (bear ? i.oiRead?.support : i.oiRead?.resistance) ?? [];
  const wallAhead = walls.find((w) => (p !== null ? (bear ? w.strike < p : w.strike > p) : false)) ?? null;
  return {
    direction: i.direction,
    price: p,
    toPrevDay: dist(bear ? i.levels?.prevDayLow : i.levels?.prevDayHigh),
    toTodayExtreme: dist(bear ? i.levels?.todayLow : i.levels?.todayHigh),
    toOiWall: wallAhead ? { ...dist(wallAhead.strike), oi: wallAhead.oi ?? null, oiChg: wallAhead.oiChg ?? null, trend: wallAhead.trend ?? null } : null,
    note: 'distance to the next level in the trade direction; under ~0.5 daily ATR or ~1.5 N15 is little room',
  };
}

/** THIN or NO_DATA ⇒ the chain cannot confirm anything (2026-11-16: GOLD "OI agrees" on 261 / 554 OI, no change). */
export function oiQuality(o: OiReadLike | null): 'OK' | 'THIN' | 'NO_DATA' {
  if (!o) return 'NO_DATA';
  const total = (o.totals?.callOi ?? 0) + (o.totals?.putOi ?? 0);
  if (o.changeBasis === 'none' || !(total >= 2_000)) return 'THIN';
  return 'OK';
}
