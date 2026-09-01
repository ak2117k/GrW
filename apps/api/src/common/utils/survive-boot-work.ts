/**
 * Run boot-time work that MUST NOT be able to stop the API from serving.
 *
 * Nest runs a module's `onModuleInit` hooks concurrently, inside `app.listen()`
 * and via `Promise.all`. One unguarded rejection therefore aborts the whole
 * batch, `init()` rejects, and `listen()` is never reached — so a single
 * seeding query against an unreachable database takes the entire API down.
 *
 * That is exactly what happened. With Neon unreachable, `UniverseScannerWorker`
 * did a bare `prisma.instrument.findFirst()` in its hook, the rejection escaped,
 * and the process never opened a port. The platform could only report "no open
 * ports detected", four layers from the cause.
 *
 * The distinction that matters, and that an earlier audit of these hooks got
 * wrong: the risk is not how LONG a boot query takes. These are all small,
 * bounded reads. The risk is an UNGUARDED REJECTION, and a fast query that
 * throws aborts boot exactly as completely as a slow one that hangs.
 *
 * So every boot hook that touches the database wraps its work in this. None of
 * it serves a request: they warm caches, reconcile paper-account balances and
 * resolve instrument ids, all of which recover on their own once the database
 * is back. Trading a recoverable warm-up for an unbootable API is never right.
 *
 * The failure is logged with its label, never swallowed silently — an invisible
 * skip is the failure shape this codebase already fights everywhere else.
 */
export async function surviveBootWork(
  label: string,
  work: () => Promise<void>,
  logger: { error: (message: string) => void },
): Promise<void> {
  try {
    await work();
  } catch (err) {
    // First line of the message only. A Prisma initialisation error carries a
    // multi-line body and a stack; five of those in a boot log is a log nobody
    // reads, and the first line already names the cause.
    const cause =
      err instanceof Error ? err.message.split('\n')[0] : String(err);
    logger.error(
      `Boot work "${label}" did not complete — the API is serving anyway and ` +
        `this recovers on its own. (${cause})`,
    );
  }
}
