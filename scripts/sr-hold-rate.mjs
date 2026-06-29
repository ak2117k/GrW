#!/usr/bin/env node
// sr-hold-rate.mjs
// ----------------------------------------------------------------------------
// Calibration report: per evidence-kind HOLD RATE from sr_level_observations.
//
//   holdRate = REJECTED / (REJECTED + BROKE)
//
// i.e. of the times a level produced by a given evidence kind was decisively
// tested, how often did price respect it. UNTOUCHED rows are counted for
// context but excluded from the rate (no information about respect). Each
// observation is tallied once per evidence kind it carries.
//
// Prints "no data yet" until observations have been snapshotted AND evaluated
// (the SrLevelTrackingService.evaluate() pass fills in the reaction). That is
// expected on a fresh DB — the point is the report is ready to read once data
// accrues.
//
// Usage:  node scripts/sr-hold-rate.mjs
// ----------------------------------------------------------------------------
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function pct(x) {
  return x === null || x === undefined ? '   —  ' : `${(x * 100).toFixed(1)}%`;
}

async function main() {
  const rows = await prisma.srLevelObservation.findMany({
    where: { reaction: { not: null } },
    select: { kinds: true, touched: true, reaction: true },
  });

  if (rows.length === 0) {
    console.log('no data yet — no evaluated S/R observations in sr_level_observations.');
    console.log('(snapshots accrue at poll time; reactions fill in after the grace window via evaluate())');
    return;
  }

  // Tally per evidence kind.
  const byKind = new Map();
  for (const r of rows) {
    for (const kind of r.kinds ?? []) {
      const a = byKind.get(kind) ?? { n: 0, touched: 0, rejected: 0, broke: 0, untouched: 0 };
      a.n += 1;
      if (r.touched) a.touched += 1;
      if (r.reaction === 'REJECTED') a.rejected += 1;
      else if (r.reaction === 'BROKE') a.broke += 1;
      else if (r.reaction === 'UNTOUCHED') a.untouched += 1;
      byKind.set(kind, a);
    }
  }

  const out = [...byKind.entries()]
    .map(([kind, a]) => {
      const decisive = a.rejected + a.broke;
      const holdRate = decisive > 0 ? a.rejected / decisive : null;
      return { kind, ...a, decisive, holdRate };
    })
    .sort((x, y) => (y.holdRate ?? -1) - (x.holdRate ?? -1));

  console.log(`\nS/R hold-rate by evidence kind  (${rows.length} evaluated observations)\n`);
  console.log('  KIND        N    TOUCH   REJ   BROKE  UNTOUCH   HOLD%');
  console.log('  ─────────────────────────────────────────────────────');
  for (const r of out) {
    console.log(
      '  ' +
        r.kind.padEnd(11) +
        String(r.n).padStart(4) +
        String(r.touched).padStart(8) +
        String(r.rejected).padStart(6) +
        String(r.broke).padStart(7) +
        String(r.untouched).padStart(9) +
        pct(r.holdRate).padStart(9),
    );
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error('sr-hold-rate failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
