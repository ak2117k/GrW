/**
 * Ping the database until it answers, BEFORE anything else connects.
 *
 * Neon (and any serverless Postgres) SUSPENDS its compute when idle. The first
 * connection after a pause wakes it, and the wake takes longer than Prisma's
 * connect timeout — so that first query fails and the next one succeeds.
 *
 * Booting an application straight into that turns it into a lottery: a dozen
 * services query in their `onModuleInit`, and whichever one happens to draw the
 * cold connection aborts the entire bootstrap. Observed failing in three
 * different services across three runs, each presenting as a different bug —
 * a scanner worker, a paper-account service, the Prisma module itself.
 *
 * One retried ping up front makes the wake explicit and the boot deterministic.
 * Long-lived servers do not need this (they wake once and stay up); short-lived
 * processes and scripts do.
 */
export async function wakeDatabase(
  attempts = 5,
  log: (message: string) => void = () => {},
): Promise<void> {
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient();
  try {
    for (let i = 1; i <= attempts; i += 1) {
      try {
        await client.$queryRawUnsafe('SELECT 1');
        if (i > 1) log(`database awake after ${i} attempts`);
        return;
      } catch (err) {
        if (i === attempts) throw err;
        log(`database cold (attempt ${i}/${attempts}) — retrying…`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  } finally {
    await client.$disconnect();
  }
}
