/**
 * Resident memory, in megabytes.
 *
 * Render's free AND Starter tiers both cap at 512 MB, and an OOM kill presents
 * as a healthy service with a small `uptimeSec` — the only clue anyone had
 * during the scrip-master crash loop. Reporting RSS turns "the container
 * restarted again" into "the container restarted at 480 MB during the
 * instrument refresh", which names the culprit.
 */
export interface ProcessMemory {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
}

const BYTES_PER_MB = 1024 * 1024;

/** Pure so it can be tested without provoking real memory pressure. */
export function toProcessMemory(usage: NodeJS.MemoryUsage): ProcessMemory {
  const mb = (bytes: number) => Math.round(bytes / BYTES_PER_MB);
  return {
    rssMb: mb(usage.rss),
    heapUsedMb: mb(usage.heapUsed),
    heapTotalMb: mb(usage.heapTotal),
    externalMb: mb(usage.external),
  };
}
