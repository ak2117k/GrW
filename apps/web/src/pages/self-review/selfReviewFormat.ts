import type {
  AgentLesson,
  KindStats,
  SelfReviewLatest,
  SelfReviewMiss,
  SelfReviewSummary,
  TuningProposal,
} from '@/types/selfReview.types';

/** Display order of the verified kinds (totals first, factor detail last). */
export const KIND_ORDER = [
  'SCORECARD_TOTAL',
  'OVERNIGHT_VERDICT',
  'LIVE_EXIT',
  'NEWS_IDEA',
  'MBM_PREDICTION',
  'MBM_RELATIVE',
  'STOCK_MOVE',
  'SCORECARD_FACTOR',
] as const;

const KIND_LABELS: Record<string, string> = {
  SCORECARD_TOTAL: 'Scorecard calls',
  SCORECARD_FACTOR: 'Scorecard factors',
  OVERNIGHT_VERDICT: 'Overnight verdicts',
  LIVE_EXIT: 'Live AI exits',
  NEWS_IDEA: 'News ideas',
  MBM_PREDICTION: 'Move-size model',
  MBM_RELATIVE: 'Move size vs recent days',
  STOCK_MOVE: 'Stock big-move model',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? sentence(kind);
}

function sentence(s: string): string {
  const t = s.replace(/[_.]+/g, ' ').trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : s;
}

/** 0.625 → "63%"; null/NaN → "—". */
export function pct(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** Hit rate from right/wrong (the API's own hitRate wins when present). */
export function hitRateOf(s: Pick<KindStats, 'right' | 'wrong'> & { hitRate?: number | null }): number | null {
  if (s.hitRate != null && Number.isFinite(s.hitRate)) return s.hitRate;
  const judged = s.right + s.wrong;
  return judged > 0 ? s.right / judged : null;
}

/** "63% · 5 right / 3 wrong" (+ " · 2 not judged"). */
export function hitLine(s: KindStats): string {
  const base = `${pct(hitRateOf(s))} · ${s.right} right / ${s.wrong} wrong`;
  return s.nullCount > 0 ? `${base} · ${s.nullCount} not judged` : base;
}

/** Tone of a hit rate for colouring: ≥ 0.55 good, < 0.45 bad, else neutral. */
export function hitTone(rate: number | null): 'good' | 'bad' | 'neutral' {
  if (rate == null) return 'neutral';
  if (rate >= 0.55) return 'good';
  if (rate < 0.45) return 'bad';
  return 'neutral';
}

export interface KindRow {
  kind: string;
  label: string;
  stats: KindStats;
}

/** The summary's kinds in display order; unknown kinds after the known ones; empty kinds dropped. */
export function kindRows(summary: SelfReviewSummary | null | undefined): KindRow[] {
  const by = summary?.byKind ?? {};
  const known = KIND_ORDER as readonly string[];
  const keys = [
    ...known.filter((k) => by[k]),
    ...Object.keys(by).filter((k) => !known.includes(k)).sort(),
  ];
  return keys
    .map((kind) => {
      const raw = by[kind] as Partial<KindStats> | undefined;
      const stats: KindStats = {
        n: raw?.n ?? 0,
        right: raw?.right ?? 0,
        wrong: raw?.wrong ?? 0,
        nullCount: raw?.nullCount ?? 0,
        hitRate: raw?.hitRate ?? null,
      };
      return { kind, label: kindLabel(kind), stats };
    })
    .filter((r) => r.stats.n > 0 || r.stats.right + r.stats.wrong > 0);
}

/** Totals across kinds, excluding per-factor rows (they double-count the scorecards). */
export function totals(summary: SelfReviewSummary | null | undefined): { right: number; wrong: number; rate: number | null } {
  let right = 0;
  let wrong = 0;
  for (const r of kindRows(summary)) {
    if (r.kind === 'SCORECARD_FACTOR') continue;
    right += r.stats.right;
    wrong += r.stats.wrong;
  }
  return { right, wrong, rate: right + wrong > 0 ? right / (right + wrong) : null };
}

/** The first `n` misses that carry a cause. */
export function topMisses(misses: SelfReviewMiss[] | null | undefined, n = 3): SelfReviewMiss[] {
  return (misses ?? []).filter((m) => m && typeof m.cause === 'string' && m.cause.trim() !== '').slice(0, n);
}

/** `lessonsAdded` arrives as a count, keys, or lesson objects depending on the API build. */
export function lessonsAddedList(v: SelfReviewLatest['lessonsAdded'] | null | undefined): Array<{ key: string; text: string | null }> {
  if (!Array.isArray(v)) return [];
  return v.map((l) => (typeof l === 'string' ? { key: l, text: null } : { key: l.key, text: l.text ?? null }));
}

export function lessonsAddedCount(v: SelfReviewLatest['lessonsAdded'] | null | undefined): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return Array.isArray(v) ? v.length : 0;
}

const FACTOR_NAMES: Record<string, string> = {
  oi: 'Option chain (OI)',
  fii_dii: 'FII/DII',
  vix: 'VIX',
  expiry: 'Expiry',
  news: 'News',
  indicators: 'Indicators',
  mood: 'Market mood',
};

/** "scorecard.factor.news.weight" → "News factor weight"; unknown targets pass through. */
export function targetLabel(target: string): string {
  const f = /^scorecard\.factor\.([a-z_]+)\.(weight|requireConfirmation)$/.exec(target);
  if (f) {
    const name = FACTOR_NAMES[f[1]] ?? f[1];
    return f[2] === 'weight' ? `${name} factor weight` : `${name} factor needs confirmation`;
  }
  if (target === 'exit.openingGuardMin') return 'Exit opening guard (minutes)';
  if (target === 'exit.persistMinSec') return 'Exit persistence (seconds)';
  if (target === 'scorecard.stockMove.points') return 'Stock big-move model points (0 = shadow, 1 = counted)';
  return target;
}

/** A tunable value for display: numbers trimmed, booleans on/off, JSON otherwise. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v && 'value' in (v as Record<string, unknown>)) {
    return formatValue((v as Record<string, unknown>).value);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** "13 cases · 4 right / 9 wrong". */
export function evidenceLine(p: TuningProposal): string {
  const e = p.evidence ?? { n: 0, right: 0, wrong: 0 };
  return `${e.n ?? 0} cases · ${e.right ?? 0} right / ${e.wrong ?? 0} wrong`;
}

/** Lesson net score, used for ordering (highest first, like the injector). */
export function lessonNet(l: Pick<AgentLesson, 'rightCount' | 'wrongCount'>): number {
  return (l.rightCount ?? 0) - (l.wrongCount ?? 0);
}

export function sortLessons(lessons: AgentLesson[]): AgentLesson[] {
  return [...lessons].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ACTIVE' ? -1 : 1;
    return lessonNet(b) - lessonNet(a);
  });
}

/** Whether the injector would feed this lesson to the agent (contract: ACTIVE and rightCount ≥ 2). */
export function lessonInjected(l: AgentLesson): boolean {
  return l.status === 'ACTIVE' && (l.rightCount ?? 0) >= 2;
}

const SCOPE_LABELS: Record<string, string> = {
  SENTINEL_LIVE: 'Sentinel live',
  SENTINEL_OVERNIGHT: 'Sentinel overnight',
  NEWS_IDEAS: 'News ideas',
  ALL: 'All',
};
export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? sentence(scope);
}

export function proposalStatusVariant(status: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  switch (status) {
    case 'APPLIED':
    case 'APPROVED':
      return 'success';
    case 'REJECTED':
      return 'danger';
    case 'PENDING':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function runStatusVariant(status: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (status === 'DONE') return 'success';
  if (status === 'FAILED') return 'danger';
  if (status === 'RUNNING') return 'info';
  return 'neutral';
}

/** '2026-10-20' → '20 Oct 2026'; anything else passes through. */
export function sessionLabel(d: string | null | undefined): string {
  if (!d) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Badge text for the nav: '' when nothing pending, '9+' past nine. */
export function pendingBadge(n: number | null | undefined): string {
  if (!n || n <= 0) return '';
  return n > 9 ? '9+' : String(n);
}

const SKILL_VERDICT: Record<string, string> = {
  NOT_TESTABLE: 'not testable yet',
  EDGE: 'real edge',
  NO_EDGE: 'no edge',
};

/** The probability models' skill line (last 20 sessions), or null when the run has none. */
export function skillLines(summary: SelfReviewSummary | null | undefined): Array<{ kind: string; label: string; verdict: string; tone: 'good' | 'bad' | 'neutral'; note: string }> {
  return Object.entries(summary?.skill ?? {})
    .filter(([, s]) => s?.rolling20)
    .map(([kind, s]) => {
      const r = s!.rolling20;
      return {
        kind,
        label: kindLabel(kind),
        verdict: SKILL_VERDICT[r.verdict] ?? r.verdict,
        tone: r.verdict === 'EDGE' ? 'good' : r.verdict === 'NO_EDGE' ? 'bad' : 'neutral',
        note: r.note,
      };
    });
}

const rupees = (n: number) => `${n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

const OI_LABEL = { AGREES: 'OI agrees', AGAINST: 'OI against', MIXED: 'OI mixed', NO_DATA: 'no OI data' } as const;

/** Signal paper trades by the OI check at entry, last 20 sessions, GROSS — one line per verdict with trades, or [] when none. */
export function paperOiLines(summary: SelfReviewSummary | null | undefined): Array<{ key: string; label: string; text: string; tone: 'good' | 'bad' | 'neutral' }> {
  const by = summary?.signalTrades?.rolling20?.paperByOi;
  if (!by) return [];
  return (Object.keys(OI_LABEL) as Array<keyof typeof OI_LABEL>)
    .filter((k) => (by[k]?.n ?? 0) > 0)
    .map((k) => {
      const s = by[k];
      const parts = [`${s.closed} closed`, `${s.wins}W/${s.losses}L`];
      if (s.winRate !== null) parts.push(`win ${Math.round(s.winRate * 100)}%`);
      parts.push(`gross ${rupees(s.gross)}`);
      return { key: k, label: OI_LABEL[k], text: parts.join(' · '), tone: (s.gross > 0 ? 'good' : s.gross < 0 ? 'bad' : 'neutral') as 'good' | 'bad' | 'neutral' };
    });
}

/** Telegram signal trades, live vs paper (no funds), last 20 sessions — one line each, or [] when none. */
export function signalTradeLines(summary: SelfReviewSummary | null | undefined): Array<{ key: 'live' | 'paperNoFunds'; label: string; text: string; tone: 'good' | 'bad' | 'neutral' }> {
  const r = summary?.signalTrades?.rolling20;
  if (!r) return [];
  const line = (key: 'live' | 'paperNoFunds', label: string) => {
    const s = r[key];
    const parts = [`${s.closed} closed`, `${s.wins}W/${s.losses}L`];
    if (s.open) parts.push(`${s.open} open`);
    parts.push(`P&L ${rupees(s.pnl)}`);
    return { key, label, text: parts.join(' · '), tone: (s.pnl > 0 ? 'good' : s.pnl < 0 ? 'bad' : 'neutral') as 'good' | 'bad' | 'neutral' };
  };
  return [line('live', 'Telegram signals — live'), line('paperNoFunds', 'Telegram signals — paper (no funds)')];
}
