import type { NightReport, Section } from './night-report.types';

/** Hard cap on the advisor's night-report block (chars). Keeps the prompt small. */
export const ADVISOR_SUMMARY_MAX_CHARS = 1500;

const ok = <T>(s: Section<T> | null | undefined): T | null =>
  s && typeof s === 'object' && !('error' in (s as object)) ? (s as T) : null;

const pct = (p: number) => `${Math.round(p * 100)}%`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A SMALL plain-text digest of the night report for the AI advisor (read-only context): the
 * summary counts, the NIFTY move-size mood, the top news ideas, the next-session trade setups and
 * the daily setups — top items only, never the full payload. Pure.
 */
export function nightReportAdvisorSummary(r: NightReport, maxChars = ADVISOR_SUMMARY_MAX_CHARS): string {
  const lines: string[] = [];
  const s = r.summary;
  lines.push(
    `Night report (generated ${r.generatedAt}): ${s.positions} positions (${s.exitAtOpen} exit-at-open, ${s.tighten} tighten, ${s.held} hold); ` +
      `${s.newsOnPositions} news on positions; ${s.eventsToday} events today.`,
  );

  const mood = ok(r.mood);
  if (mood && mood.status !== 'absent') {
    const hs = Object.entries(mood.horizons ?? {})
      .slice(0, 3)
      .map(([h, v]) => `${h} ${v.regime} p=${pct(v.p)}`)
      .join(', ');
    if (hs) lines.push(`NIFTY move-size mood (${mood.status}): ${hs}. Size only, not direction.`);
  }

  const ideas = ok(r.newsIdeas) ?? [];
  if (ideas.length) {
    lines.push(`News ideas (${ideas.length}, top 5):`);
    for (const i of ideas.slice(0, 5)) lines.push(`- ${i.symbol} ${i.idea}: ${clip(i.headline ?? '', 90)}`);
  }

  const ts = r.tradeSetups ? ok(r.tradeSetups) : null;
  if (ts && ts.setups?.length) {
    lines.push(`Trade setups for ${ts.sessionDate ?? 'next session'} (advisory, top 3):`);
    for (const t of ts.setups.slice(0, 3)) {
      lines.push(`- ${t.symbol} ${t.side} ${t.instrumentKind}: ref ${t.entryRef}, stop ${t.stop}, T1 ${t.target1}`);
    }
  }

  const daily = ok(r.dailySetups) ?? [];
  if (daily.length) {
    lines.push(`Daily setups (${daily.length}, top 3): ${daily.slice(0, 3).map((d) => `${d.instrument.symbol} ${d.action}`).join('; ')}`);
  }

  const events = ok(r.events) ?? [];
  if (events.length) {
    lines.push(`Events (top 3): ${events.slice(0, 3).map((e) => clip(e.title, 60)).join('; ')}`);
  }

  const out = lines.join('\n');
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}
