/**
 * Entry engine replay (stage 1 proof). Offline only; never runs in the API and never touches a
 * database or the broker.
 *
 *   npx tsx apps/api/scripts/entry-replay.ts <fixture.real.json>... [--verbose] [--no-news-paths] [--pre-open <outlook.json>]
 *
 * Each fixture is one underlying-day exported read-only from prod
 * (apps/api/src/modules/entry-engine/replay/sql/export-entry-fixture.sql). Prints what entryDecision
 * would have decided at every 15-minute step, with the news / trend / OI read behind it; --verbose
 * adds the decision's reasons. --no-news-paths replays the engine before 2026-11-02 (per-story news rule
 * only); --pre-open sets the day's pre-open outlook ({ underlying, sessionDate, bias, confidence, at,
 * summary }, e.g. from scripts/pre-open-replay.ts) on every fixture. Exit code 1 on an unreadable fixture.
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import { formatStep, replayEntry, type EntryFixtureV1 } from '../src/modules/entry-engine/replay/replay-entry';

/* eslint-disable no-console */
function main(argv: string[]): number {
  const verbose = argv.includes('--verbose');
  const newsPaths = !argv.includes('--no-news-paths');
  const preIdx = argv.indexOf('--pre-open');
  const preFile = preIdx >= 0 ? argv[preIdx + 1] : null;
  const files = argv.filter((a, i) => !a.startsWith('--') && !(preIdx >= 0 && i === preIdx + 1));
  let preOpen: EntryFixtureV1['preOpen'] = undefined;
  if (preFile) {
    try {
      preOpen = JSON.parse(readFileSync(preFile, 'utf8')) as EntryFixtureV1['preOpen'];
    } catch (e) {
      console.error(`${preFile}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  if (files.length === 0) {
    console.error('Usage: npx tsx apps/api/scripts/entry-replay.ts <fixture.real.json>... [--verbose]');
    return 1;
  }
  for (const f of files) {
    let fx: EntryFixtureV1;
    try {
      fx = JSON.parse(readFileSync(f, 'utf8')) as EntryFixtureV1;
    } catch (e) {
      console.error(`${f}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    if (preOpen !== undefined) fx.preOpen = preOpen;
    const steps = replayEntry(fx, { newsPaths });
    const enters = steps.filter((s) => s.decision.action !== 'NO_TRADE');
    console.log(`\n=== ${basename(f)} — ${fx.underlying} ${fx.date} (${steps.length} steps, ${enters.length} ENTER, ${steps.filter((s) => s.wouldOpen).length} would open) ===`);
    console.log('IST    action          news (* material, *T theme, *P pre-open)  | trend                                                | oi (verdict→want, chain lean 30m / since open, futures)');
    for (const s of steps) {
      console.log(formatStep(s));
      if (verbose) {
        for (const r of s.decision.reasons) console.log(`         · ${r}`);
        for (const r of s.guards.reasons) console.log(`         · ${r}`);
      }
    }
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
