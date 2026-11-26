/**
 * Pure helpers for the desk packet (plan Task 3). Every block is time-boxed and never throws: a slow or failing
 * source becomes `unavailable` with its reason, so the manager always sees what it could not see.
 */
import type { Block, Proposal } from './desk.types';

/** Each packet block's time box. */
export const DESK_BLOCK_MS = 3000;
/** Proposals the manager sees: newest first, last 2 h, at most this many. */
export const PROPOSAL_CAP = 40;
export const PROPOSAL_WINDOW_MS = 2 * 60 * 60_000;
/** Underlyings the instruments block reads. */
export const INSTRUMENT_CAP = 8;
/** Closed trackers within this window are recent exits. */
export const RECENT_EXIT_WINDOW_MS = 90 * 60_000;
/** A proposal younger than this keeps the manager on the busy cadence. */
export const BUSY_PROPOSAL_MS = 30 * 60_000;
/** Today's decisions in the memory block. */
export const MEMORY_DECISIONS_CAP = 30;
/** Level-book levels per underlying, nearest the price first. */
export const LEVELS_PER_INSTRUMENT = 6;
/** Free text (judge summaries, reasons) is cut to this many characters. */
export const TEXT_CAP = 300;
/** The whole packet JSON stays under this. */
export const PACKET_MAX_CHARS = 100_000;

export function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}

/** Runs one source against the time box; never throws. `undefined` from the read counts as present (empty). */
export async function timedBlock<T>(source: string, read: () => Promise<T>, ms = DESK_BLOCK_MS): Promise<Block<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  try {
    const value = await Promise.race([read(), timeout]);
    return { status: 'present', value, source };
  } catch (err) {
    return { status: 'unavailable', reason: errText(err), source };
  } finally {
    clearTimeout(timer);
  }
}

/** Like timedBlock but yields the value or null (sub-reads inside a block). `failed` names the miss. */
export async function timedValue<T>(read: () => Promise<T>, ms = DESK_BLOCK_MS): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const b = await timedBlock('sub', read, ms);
  return b.status === 'present' ? { ok: true, value: b.value as T } : { ok: false, reason: b.reason ?? 'unavailable' };
}

export function cut(text: unknown, n = TEXT_CAP): string {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Newest first, at most `cap`. Unparseable times sort last. */
export function capProposals(list: readonly Proposal[], cap = PROPOSAL_CAP): Proposal[] {
  const t = (p: Proposal) => {
    const v = Date.parse(p.at);
    return Number.isFinite(v) ? v : -Infinity;
  };
  return [...list].sort((a, b) => t(b) - t(a)).slice(0, cap);
}

/** Ordered, de-duplicated, upper-cased underlyings (positions first, then exits, then proposals), at most `cap`. */
export function pickUnderlyings(groups: ReadonlyArray<ReadonlyArray<string | null | undefined>>, cap = INSTRUMENT_CAP): string[] {
  const out: string[] = [];
  for (const g of groups) {
    for (const u of g) {
      const k = String(u ?? '').trim().toUpperCase();
      if (!k || out.includes(k)) continue;
      out.push(k);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * The underlying name a contract symbol starts with ('NIFTY27NOV2624650CE' → NIFTY, 'GOLDM05DEC25FUT' → GOLDM,
 * 'RELIANCE-EQ' → RELIANCE). A name only — no (exchange, token) lookup happens here.
 */
export function underlyingFromSymbol(symbol: string | null | undefined): string | null {
  const s = String(symbol ?? '').trim().toUpperCase();
  if (!s) return null;
  const m = /^([A-Z&-]+?)(?:-EQ|-BE)?(?=\d|$)/.exec(s);
  const name = m?.[1]?.replace(/-+$/, '') ?? '';
  return name.length > 0 ? name : null;
}

/** The first number in a free-text level ("below 3863 on 15m close" → 3863), else null. */
export function firstNumber(text: unknown): number | null {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const m = /-?\d+(?:\.\d+)?/.exec(String(text ?? '').replace(/,/g, ''));
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

/** The `n` levels nearest `ltp` (all levels sorted when the price is unknown), rounded to 2 dp. */
export function nearestLevels(levels: readonly number[], ltp: number | null, n = LEVELS_PER_INSTRUMENT): number[] {
  const clean = [...new Set(levels.filter((l) => typeof l === 'number' && Number.isFinite(l)).map((l) => Math.round(l * 100) / 100))];
  if (ltp == null || !Number.isFinite(ltp)) return clean.sort((a, b) => a - b).slice(0, n);
  return clean.sort((a, b) => Math.abs(a - ltp) - Math.abs(b - ltp)).slice(0, n).sort((a, b) => a - b);
}

/** NOT_CHECKABLE claims across the given readings, grouped by reasonCode (absent = OTHER). */
export function countNotCheckable(claimLists: readonly unknown[]): { total: number; byReason: Record<string, number> } {
  const byReason: Record<string, number> = {};
  let total = 0;
  for (const list of claimLists) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!c || typeof c !== 'object' || (c as { verdict?: unknown }).verdict !== 'NOT_CHECKABLE') continue;
      const code = (c as { reasonCode?: unknown }).reasonCode;
      const key = typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : 'OTHER';
      byReason[key] = (byReason[key] ?? 0) + 1;
      total += 1;
    }
  }
  return { total, byReason };
}

/** Names of the unavailable blocks (`name: reason`). */
export function failedBlocks(blocks: Record<string, Block<unknown>>): string[] {
  return Object.entries(blocks)
    .filter(([, b]) => b.status === 'unavailable')
    .map(([name, b]) => `${name}: ${b.reason ?? 'unavailable'}`);
}

/** HH:mm in IST. */
export function istClock(now: Date): string {
  const t = new Date(now.getTime() + 5.5 * 3600_000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' IST. */
export function istYmdOf(at: Date): string {
  return new Date(at.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** UTC instant of 00:00 IST on `now`'s IST day. */
export function istMidnight(now: Date): Date {
  return new Date(`${istYmdOf(now)}T00:00:00+05:30`);
}

/** The manager stop / targets carried by OPEN and TIGHTEN decision payloads. */
export function managerLevelsFrom(rows: ReadonlyArray<{ action: string; payload: unknown; createdAt: Date }>): { stop: number | null; targets: number[] } {
  let stop: number | null = null;
  let stopAt = -Infinity;
  let targets: number[] = [];
  let targetsAt = -Infinity;
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const at = r.createdAt.getTime();
    if (r.action === 'OPEN') {
      const s = firstNumber((p.stop as { underlying?: unknown } | undefined)?.underlying);
      if (s != null && at > stopAt) {
        stop = s;
        stopAt = at;
      }
      const ts = (p.targets as { underlying?: unknown } | undefined)?.underlying;
      if (Array.isArray(ts) && at > targetsAt) {
        targets = ts.map((x) => firstNumber(x)).filter((x): x is number => x != null);
        targetsAt = at;
      }
    } else if (r.action === 'TIGHTEN') {
      const s = firstNumber(p.underlyingStop);
      if (s != null && at > stopAt) {
        stop = s;
        stopAt = at;
      }
    }
  }
  return { stop, targets };
}

/** A short text of an action result JSON ({status, detail}) for the memory block. */
export function resultText(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === 'string') return cut(result, 200);
  const r = result as { status?: unknown; detail?: unknown };
  const parts = [r.status, r.detail].filter((x) => typeof x === 'string' && x) as string[];
  return parts.length > 0 ? cut(parts.join(': '), 200) : cut(JSON.stringify(result), 200);
}
