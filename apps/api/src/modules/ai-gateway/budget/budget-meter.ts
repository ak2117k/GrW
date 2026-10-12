import { isReviewJob, type AiJob } from '../ai-job';

/** A call was refused because it could push today's API spend past the cap. */
export class AiBudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiBudgetExceeded';
  }
}

export interface BudgetReservation {
  /** Replace the reservation with what the call actually cost. */
  settle(actualInr: number): void;
  /** The call did not happen (or failed before billing): free the reservation. */
  release(): void;
}

export interface BudgetMeterOptions {
  capInr: number;
  /** Share of the cap only position-review jobs may use (spec §4.5: 0.25). */
  reserveShare: number;
  /** Today's (IST) recorded API spend, from `ai_calls.costInr`. */
  spentToday: () => Promise<number>;
  now: () => Date;
}

const IST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` of the IST calendar day containing `d`. */
export function istDayKey(d: Date): string {
  return IST_DAY.format(d);
}

/**
 * Daily cap on metered API spend (spec §4.5).
 *
 * WHY `reserve` IS SYNCHRONOUS. The check ("does this call's worst case fit?")
 * and the act ("count it as spent") happen in one synchronous step, with no
 * `await` between them. JavaScript runs that step to completion, so two
 * concurrent calls cannot both see the same headroom and jointly cross the cap
 * — the second one sees the first one's reservation. An async `reserve` would
 * reopen exactly that race.
 *
 * FAILS CLOSED. Until today's spend has been loaded (`refresh`), and from the
 * moment the IST day rolls over until the new day's spend is loaded, every
 * reservation is refused: the meter never assumes zero spend it has not read.
 *
 * Reservations carry the day they were taken on; settling one after midnight
 * does not touch the new day's ledger (its cost is in `ai_calls` and is counted
 * by whichever day's load reads it).
 */
export class BudgetMeter {
  private day: string | null = null;
  private committed = 0;
  private reserved = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly opts: BudgetMeterOptions) {}

  /** Load today's spend once per IST day; concurrent callers share one load. */
  refresh(): Promise<void> {
    const today = istDayKey(this.opts.now());
    if (this.day === today) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = this.opts
      .spentToday()
      .then((spent) => {
        this.day = today;
        this.committed = Number.isFinite(spent) && spent > 0 ? spent : 0;
        this.reserved = 0;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  reserve(job: AiJob, worstCaseInr: number): BudgetReservation {
    const today = istDayKey(this.opts.now());
    if (this.day !== today) {
      throw new AiBudgetExceeded(`ai budget: today's spend is not loaded (${today})`);
    }
    if (!Number.isFinite(worstCaseInr) || worstCaseInr < 0) {
      throw new AiBudgetExceeded(`ai budget: invalid worst-case cost ${worstCaseInr}`);
    }
    const limit = isReviewJob(job)
      ? this.opts.capInr
      : this.opts.capInr * (1 - this.opts.reserveShare);
    const after = this.committed + this.reserved + worstCaseInr;
    if (after > limit) {
      throw new AiBudgetExceeded(
        `ai budget: ${job} worst case ₹${worstCaseInr.toFixed(2)} would take today's API spend to ` +
          `₹${after.toFixed(2)}, over its limit ₹${limit.toFixed(2)} (cap ₹${this.opts.capInr})`,
      );
    }
    this.reserved += worstCaseInr;
    const day = today;
    let open = true;
    const close = (actual: number | null): void => {
      if (!open) return;
      open = false;
      if (this.day !== day) return;
      this.reserved = Math.max(0, this.reserved - worstCaseInr);
      if (actual !== null && Number.isFinite(actual) && actual > 0) this.committed += actual;
    };
    return { settle: (actual) => close(actual), release: () => close(null) };
  }

  /** Current ledger, for health reporting and tests. */
  snapshot(): { day: string | null; committedInr: number; reservedInr: number; capInr: number } {
    return {
      day: this.day,
      committedInr: this.committed,
      reservedInr: this.reserved,
      capInr: this.opts.capInr,
    };
  }
}
