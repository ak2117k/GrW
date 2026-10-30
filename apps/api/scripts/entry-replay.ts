/**
 * Entry engine replay (stage 1 proof). Offline only; never runs in the API and never touches a
 * database or the broker.
 *
 *   npx tsx apps/api/scripts/entry-replay.ts <fixture.real.json>... [--verbose]
 *
 * Each fixture is one underlying-day exported read-only from prod
 * (apps/api/src/modules/entry-engine/replay/sql/export-entry-fixture.sql). Prints what entryDecision
 * would have decided at every 15-minute step, with the news / trend / OI read behind it; --verbose
 * adds the decision's reasons. Exit code 1 on an unreadable fixture.
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import { formatStep, replayEntry, type EntryFixtureV1 } from '../src/modules/entry-engine/replay/replay-entry';

/* eslint-disable no-console */
function main(argv: string[]): number {
  const verbose = argv.includes('--verbose');
  const files = argv.filter((a) => !a.startsWith('--'));
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
    const steps = replayEntry(fx);
    const enters = steps.filter((s) => s.decision.action !== 'NO_TRADE');
    console.log(`\n=== ${basename(f)} — ${fx.underlying} ${fx.date} (${steps.length} steps, ${enters.length} ENTER, ${steps.filter((s) => s.wouldOpen).length} would open) ===`);
    console.log('IST    action          news (* material)  | trend                                                | oi (verdict→want, chain lean 30m / since open, futures)');
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
