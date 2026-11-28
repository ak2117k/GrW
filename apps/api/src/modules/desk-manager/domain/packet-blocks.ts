/**
 * Pure helpers for the desk packet (plan Task 3). Every block is time-boxed and never throws: a slow or failing
 * source becomes `unavailable` with its reason, so the manager always sees what it could not see.
 */
import { buildVocabulary } from '../../signal-intake/domain/vocabulary';
import type { Block, LotCost, Proposal } from './desk.types';

/** Each packet block's time box. */
export const DESK_BLOCK_MS = 3000;
/** The slower blocks (instruments, recentExits, funds: several market reads each) get this box. */
export const DESK_SLOW_BLOCK_MS = 6000;
/** Proposals the manager sees: the last 2 h (per-source quotas: PROPOSAL_QUOTAS). */
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

/**
 * Per-source lead quotas (audit 2026-11-27: the single cap 40 was hit in 149/165 runs, 81% entry-engine items).
 * Newest first within each source; a source's unused quota is NOT given to another (never to the engine).
 */
export const PROPOSAL_QUOTAS: Readonly<Record<Proposal['kind'], number>> = Object.freeze({ reading: 16, signal_decision: 8, setup: 6, engine: 10 });

const atMs = (p: Pick<Proposal, 'at'>) => {
  const v = Date.parse(p.at);
  return Number.isFinite(v) ? v : -Infinity;
};
const newestFirst = (a: Proposal, b: Proposal) => atMs(b) - atMs(a);

/**
 * Does free text name an instrument? A word (or two-word alias, "BANK NIFTY") that is a fixed vocabulary alias
 * (indices, commodities, stock nicknames) or, with the instrument master's names, a listed name of 3+ letters.
 */
export function textNamesInstrument(text: unknown, masterNames?: ReadonlySet<string> | null): boolean {
  const words = String(text ?? '').toUpperCase().match(/[A-Z][A-Z0-9&]*/g) ?? [];
  const alias = aliasNames();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (alias.has(w) && w.length >= 3) return true;
    if (i + 1 < words.length && alias.has(`${w} ${words[i + 1]}`)) return true;
    if (w.length >= 3 && !NOT_INSTRUMENT.has(w) && masterNames?.has(w)) return true;
  }
  return false;
}

/**
 * An UPDATE reading that names no instrument and no level (a bare "120++"): nothing to act on. Kept when a claim's
 * subject or the summary names an instrument (the reader left call.underlying empty but said what it is about).
 */
export function isBareUpdate(p: Proposal, masterNames?: ReadonlySet<string> | null): boolean {
  if (p.kind !== 'reading' || p.detail?.kind !== 'UPDATE') return false;
  if (String(p.underlying ?? '').trim()) return false;
  const c = (p.detail.call ?? null) as Record<string, unknown> | null;
  if (c) {
    if (String(c.underlying ?? '').trim()) return false;
    const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if ([c.strike, c.entryLow, c.entryHigh, c.stopLoss].some(n) || (Array.isArray(c.targets) && c.targets.some(n))) return false;
  }
  const claims = Array.isArray(p.detail.claims) ? (p.detail.claims as Array<Record<string, unknown>>) : [];
  if (claims.some((x) => x && typeof x.subject === 'string' && normaliseUnderlyingKey(x.subject) !== null)) return false;
  if (textNamesInstrument(p.text, masterNames)) return false;
  return true;
}

/** Entry-engine items merged to one per (underlying, side): the latest wins and carries `count` (how many were merged). */
export function mergeEngine(list: readonly Proposal[]): Proposal[] {
  const groups = new Map<string, { latest: Proposal; count: number }>();
  for (const p of list) {
    const key = `${String(p.underlying ?? '').toUpperCase()}|${String(p.detail?.action ?? '')}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { latest: p, count: 1 });
    else {
      g.count += 1;
      if (atMs(p) > atMs(g.latest)) g.latest = p;
    }
  }
  return [...groups.values()].map((g) => ({ ...g.latest, detail: { ...g.latest.detail, count: g.count } })).sort(newestFirst);
}

/** The proposals block: bare UPDATEs dropped, engine merged, then each source cut to its quota; newest first overall. */
export function quotaProposals(
  list: readonly Proposal[],
  quotas: Readonly<Record<Proposal['kind'], number>> = PROPOSAL_QUOTAS,
  masterNames?: ReadonlySet<string> | null,
): Proposal[] {
  const kept = list.filter((p) => !isBareUpdate(p, masterNames));
  const out: Proposal[] = [];
  for (const kind of Object.keys(quotas) as Array<Proposal['kind']>) {
    const own = kept.filter((p) => p.kind === kind);
    const ready = kind === 'engine' ? mergeEngine(own) : [...own].sort(newestFirst);
    out.push(...ready.slice(0, Math.max(0, quotas[kind])));
  }
  return out.sort(newestFirst);
}

/** Channel market views: INFO readings from the last 3 h, at most 10, newest first. */
export const CHANNEL_VIEW_WINDOW_MS = 3 * 60 * 60_000;
export const CHANNEL_VIEW_CAP = 10;

/** Keys that are not an instrument (a market-wide claim, a sector index). */
const NOT_INSTRUMENT: ReadonlySet<string> = new Set(['MARKET', 'SECTOR', 'SECTORINDEX', 'INDEX', 'NONE', 'NULL', 'UNKNOWN', 'N/A']);
/** MCX minis read as their parent for data (bars, levels, chain). */
const MINI_PARENT: Readonly<Record<string, string>> = { GOLDM: 'GOLD', GOLDPETAL: 'GOLD', SILVERM: 'SILVER', SILVERMIC: 'SILVER', CRUDEOILM: 'CRUDEOIL', NATGASMINI: 'NATURALGAS' };
/** The mini contract that exists for a full MCX underlying (1/10 lot). */
const MINI_OF_PARENT: Readonly<Record<string, string>> = { CRUDEOIL: 'CRUDEOILM', GOLD: 'GOLDM', SILVER: 'SILVERM', NATURALGAS: 'NATGASMINI' };

export function miniUnderlyingOf(underlying: string): string | null {
  return MINI_OF_PARENT[String(underlying ?? '').trim().toUpperCase()] ?? null;
}

let staticNames: ReadonlyMap<string, string> | null = null;
/** The intake vocabulary's fixed aliases (indices, commodities, common stock nicknames). */
function aliasNames(): ReadonlyMap<string, string> {
  staticNames ??= buildVocabulary([]).names;
  return staticNames;
}

/** At most one edit (substitution / insertion / deletion) between a and b. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * One packet underlying key: upper-cased, `-EQ` cut, a non-instrument (MARKET, sector) dropped (null), minis and
 * aliases mapped to the data name (GOLDM → GOLD, BANK NIFTY → BANKNIFTY). With the instrument master's names: a
 * name the master does not list is matched to the master's 10-letter cut (BHARATFORGE → BHARATFORG) or a unique
 * one-letter-off name; else kept as given.
 */
export function normaliseUnderlyingKey(raw: string | null | undefined, masterNames?: ReadonlySet<string> | null): string | null {
  let k = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ').replace(/-(EQ|BE)$/, '');
  if (!k || NOT_INSTRUMENT.has(k)) return null;
  k = MINI_PARENT[k] ?? aliasNames().get(k) ?? k;
  k = MINI_PARENT[k] ?? k;
  if (!masterNames || masterNames.size === 0 || masterNames.has(k)) return k;
  const cut10 = k.slice(0, 10);
  if (cut10 !== k && masterNames.has(cut10)) return cut10;
  if (k.length >= 6 && /^[A-Z&-]+$/.test(k)) {
    const near: string[] = [];
    for (const n of masterNames) if (n[0] === k[0] && withinOneEdit(n, k)) near.push(n);
    if (near.length === 1) return near[0];
  }
  return k;
}

/**
 * The 1-lot cost of a contract (premium x lot size x value factor) and whether it fits the funds (null = unknown).
 * `required` is what the order path's funds check will ask for (signal-trader requiredFunds: the cost plus its
 * charges buffer); `fits` compares that, so it matches what the order path accepts. Default: the bare cost.
 */
export function lotCost(c: { contract: string; premium: number; lotSize: number; valueFactor: number }, available: number | null, required?: number): LotCost {
  const vf = c.valueFactor > 0 ? c.valueFactor : 1;
  const cost = Math.round(c.premium * c.lotSize * vf * 100) / 100;
  const need = typeof required === 'number' && Number.isFinite(required) ? Math.round(required * 100) / 100 : cost;
  return { contract: c.contract, premium: c.premium, lotSize: c.lotSize, valueFactor: vf, cost, required: need, fits: available == null || !Number.isFinite(available) ? null : need <= available };
}

/**
 * Ordered, de-duplicated, normalised underlyings (see normaliseUnderlyingKey), at most `cap`. The caller orders the
 * groups by what the manager can act on (F&O / MCX positions, proposals and channel views, recent exits, holdings).
 */
export function pickUnderlyings(groups: ReadonlyArray<ReadonlyArray<string | null | undefined>>, cap = INSTRUMENT_CAP, masterNames?: ReadonlySet<string> | null): string[] {
  const out: string[] = [];
  for (const g of groups) {
    for (const u of g) {
      const k = normaliseUnderlyingKey(u, masterNames);
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
