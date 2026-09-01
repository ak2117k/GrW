/**
 * What to do when `bootstrap()` rejects.
 *
 * Extracted from `main.ts` so it can be tested: this runs exactly once, at the
 * moment everything else has already gone wrong, which is precisely when an
 * untested path is least affordable.
 *
 * WHY THIS EXISTS. `main.ts` registers a `process.on('unhandledRejection')`
 * handler so a known-benign broker WebSocket heartbeat error cannot kill the
 * process. Registering that handler also suppresses Node's default behaviour
 * since v15 — an unhandled rejection normally terminates the process. With
 * `bootstrap()` invoked and never `.catch`ed, a boot failure therefore hit that
 * handler, got logged, and the process CARRIED ON: alive, holding open handles
 * from half-initialised modules, and never reaching `listen()`.
 *
 * Render can only report what it can see, which is a live process with no
 * listening port: "no open ports detected". That message is four layers removed
 * from a database that would not answer, and it sent three separate
 * investigations after port binding instead of the connection.
 *
 * A failed boot must therefore be loud and fatal. Non-zero exit puts the real
 * error at the end of the deploy log and lets the platform restart the
 * container — which is what every layer above already assumes a failed boot
 * looks like.
 */
export interface BootFailureDeps {
  error: (message: string, cause?: unknown) => void;
  exit: (code: number) => void;
}

export function exitOnBootFailure(
  cause: unknown,
  deps: BootFailureDeps = {
    // eslint-disable-next-line no-console
    error: (message, err) => console.error(message, err),
    exit: (code) => process.exit(code),
  },
): void {
  // The cause is passed through as-is rather than stringified: the stack names
  // which module's lifecycle hook rejected, and that is the whole diagnosis.
  deps.error('[bootstrap] failed to start — exiting', cause);
  deps.exit(1);
}
