/**
 * Blind watch (2026-11-19, the 16 Nov freeze): on 16 Nov the sentinel cycle was stuck from 09:27 to 13:15 IST
 * and nobody was told — the only trace was a WARN line every 30 s. This tracks, per key (a real position's
 * tracker, or a user's whole cycle), when it was last seen working, and says when it has been blind long
 * enough to alert the owner. Pure and in-memory; the caller sends the alert (sendOpsAlert de-duplicates
 * each key for 30 min).
 */
export const SENTINEL_BLIND_ALERT_MS = 5 * 60_000;

export class BlindWatch {
  private readonly lastGood = new Map<string, number>();

  constructor(private readonly alertAfterMs = SENTINEL_BLIND_ALERT_MS) {}

  /**
   * Records one look at `key`. `ok`: it worked. Returns the whole minutes it has been blind when an alert is
   * due, else null. The first sighting starts the clock even when it fails, so a position that never once
   * worked still alerts after `alertAfterMs`.
   */
  record(key: string, ok: boolean, now: number): number | null {
    const since = this.lastGood.get(key);
    if (ok || since === undefined) {
      this.lastGood.set(key, now);
      return null;
    }
    const blind = now - since;
    return blind >= this.alertAfterMs ? Math.floor(blind / 60_000) : null;
  }

  /** Drops keys no longer watched (closed positions). */
  keepOnly(keys: Set<string>): void {
    for (const k of this.lastGood.keys()) if (!keys.has(k)) this.lastGood.delete(k);
  }
}
