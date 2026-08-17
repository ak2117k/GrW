/**
 * Run ONE Trade Sentinel cycle, right now, and print what it decided.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CRON. `SentinelRunner.tick()` is gated on
 * `isWithinSession()` (weekdays 09:15–15:29 IST) and on `SENTINEL_SHADOW_ENABLED`,
 * which is exactly right for the scheduled job and useless for the first run:
 * you find out whether the pipeline works by running it, and you cannot wait for
 * a market session to learn that a dependency does not resolve. This calls
 * `SentinelCycleService.runForUser` directly, so it runs at any hour.
 *
 * IT IS STILL SHADOW MODE. The cycle records verdicts and places nothing — that
 * property lives in the cycle itself (Stage 0 has no executor wired at all), not
 * in the gate this script bypasses. Bypassing the clock cannot bypass that.
 *
 * WHAT "RIGHT NOW" MEANS OUT OF HOURS: the tick reads `trade_trackers.lastLtp`,
 * which the tracker poller last wrote during the previous session. The prices
 * are that session's closes, not live. That is the honest state of the book
 * between sessions and it is fine for proving the pipeline — but a verdict
 * recorded out of hours is reasoning about stale prices, so DO NOT read the
 * out-of-hours corpus as though it were live judgement.
 *
 * Usage — point DATABASE_URL at the target DB and pick a transport:
 *   DATABASE_URL='postgresql://…' SENTINEL_JUDGE=cli node apps/api/dist/scripts/sentinel-once.js
 *   DATABASE_URL='postgresql://…' SENTINEL_JUDGE=cli node apps/api/dist/scripts/sentinel-once.js <userId>
 *
 * With no userId it runs every user holding an OPEN trade.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module';
import { SentinelCycleService } from '../modules/trade-sentinel/services/sentinel-cycle.service';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * Wake the database before Nest boots, and don't proceed until it answers.
 *
 * Neon AUTOSUSPENDS its compute when idle. The first connection after a pause
 * wakes it, which takes longer than Prisma's connect timeout — so that first
 * query fails and the next one succeeds. Booting straight into Nest turns that
 * into a lottery: a dozen services query in their `onModuleInit`, and whichever
 * one draws the cold connection aborts the entire bootstrap. Observed failing in
 * three different services on three different runs, each looking like a
 * different bug.
 *
 * One retried ping up front makes the wake explicit and the boot deterministic.
 */
async function wakeDatabase(attempts = 5): Promise<void> {
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient();
  try {
    for (let i = 1; i <= attempts; i += 1) {
      try {
        await client.$queryRawUnsafe('SELECT 1');
        if (i > 1) console.log(`database awake after ${i} attempts`);
        return;
      } catch (err) {
        if (i === attempts) throw err;
        console.log(`database cold (attempt ${i}/${attempts}) — retrying…`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  } finally {
    await client.$disconnect();
  }
}

async function main(): Promise<void> {
  const explicitUser = process.argv[2];

  console.log('transport :', process.env.SENTINEL_JUDGE === 'cli' ? 'claude CLI (subscription)' : 'Anthropic API');
  await wakeDatabase();
  console.log('booting the application context…\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    // The boot chatter would bury the only output that matters here.
    logger: ['error', 'warn'],
  });
  // The cron the real runner uses is registered by this context too; we never
  // call it, and a one-shot process exits long before it could fire.
  app.enableShutdownHooks();

  try {
    const prisma = app.get(PrismaService);
    const cycle = app.get(SentinelCycleService);

    const userIds = explicitUser
      ? [explicitUser]
      : (
          await prisma.tradeTracker.findMany({
            where: { status: 'OPEN' },
            select: { userId: true },
            distinct: ['userId'],
          })
        ).map((r) => r.userId);

    if (userIds.length === 0) {
      console.log('no user holds an OPEN trade — nothing to watch.');
      return;
    }

    for (const userId of userIds) {
      console.log(`── user ${userId} ${'─'.repeat(40)}`);
      const started = Date.now();
      const report = await cycle.runForUser(userId);
      console.log(`\ncycle finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      console.dir(report, { depth: 6, maxStringLength: 2000 });
    }
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    new Logger('sentinel-once').error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
