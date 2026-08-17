/**
 * Should this process run BOOT-TIME BACKGROUND WORK — the crons, workers,
 * warmers and feed connections that services kick off from `onModuleInit`?
 *
 * `BOOT_JOBS=false` says no. Defaults to YES, so the API server is unchanged.
 *
 * WHY IT EXISTS. Nest builds the whole injector for whatever module tree you
 * boot, and every `onModuleInit` in it fires — even in a
 * `createApplicationContext` process that wants one service. A one-shot script
 * that needed only the sentinel was, in practice:
 *
 *   - blocked for MINUTES on a full instrument-master upsert into a remote
 *     database, one row at a time, because that refresh is AWAITED at boot;
 *   - opening a live market-data WebSocket and seeding quotes from the broker;
 *   - crashing outright in a Socket.IO gateway that has no HTTP server attached;
 *   - failing boot entirely when a scanner worker's first query lost the
 *     connection the instrument refresh had just exhausted.
 *
 * None of that is the script's work, and every one of it is a separate failure
 * with a separate symptom — which is the argument for ONE flag rather than a
 * flag per service. A process either serves traffic or it does not.
 *
 * It is deliberately NOT the inverse of some `WORKER_MODE`. Read it at the point
 * of use, not once at import: tests set and clear it per case.
 */
export function bootJobsEnabled(): boolean {
  return process.env.BOOT_JOBS !== 'false';
}

/** The one-line reason to log when boot work is skipped, so it is never silent. */
export const BOOT_JOBS_DISABLED = 'BOOT_JOBS=false — skipping boot-time background work';
