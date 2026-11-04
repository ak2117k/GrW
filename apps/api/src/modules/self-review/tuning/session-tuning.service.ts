import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { validateTunable, type TunableValue, type TuningReader } from './tunables';

/** A failed / missing day snapshot is retried at most this often. */
export const SESSION_TUNING_RETRY_MS = 60_000;
const IST_OFFSET_MS = 330 * 60_000;

export interface TimedOverrideSource {
  /** `previousValue`: the value in force before this override (its proposal's currentValue), when known. */
  overrides(): Promise<Array<{ target: string; value: unknown; appliedAt: Date; previousValue?: unknown }>>;
}

/** The IST calendar date of `ms`. */
export const istDateOf = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
/** UTC ms of 00:00 IST on `ymd`. */
const istDayStartMs = (ymd: string): number => Date.parse(`${ymd}T00:00:00.000Z`) - IST_OFFSET_MS;

/**
 * Serves `tuning_overrides` FIXED PER IST SESSION DATE (spec 2026-11-04 wrong-decision loop, S7; 2026-11-05):
 * the value of a target on day D is its override applied BEFORE 00:00 IST of D; an override applied ON D serves,
 * for the rest of D, the value it replaced (its proposal's currentValue); else the consumer's default.
 * So an override written at 19:30 (the auto-apply cron) or by the owner mid-session is served from the next
 * session's open — never mid-session, and a restart mid-session reproduces the same day's values.
 *
 *  - `get` is synchronous and never throws. On a new IST date it kicks one load; until that load lands it
 *    keeps serving the previous snapshot (a subset of the same history: values only move at the day change).
 *  - A failed load keeps the last good snapshot and is retried every {@link SESSION_TUNING_RETRY_MS}.
 *    Never loaded ⇒ every value is the consumer's default (contract: "DB failure → code default").
 *  - Non-allow-listed / out-of-bounds / wrong-typed rows are ignored (validateTunable).
 */
@Injectable()
export class SessionTuningService implements TuningReader, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionTuningService.name);
  private snap = new Map<string, TunableValue>();
  private day: string | null = null;
  private triedAt = 0;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly source: TimedOverrideSource,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static fromPrisma(prisma: PrismaService): SessionTuningService {
    return new SessionTuningService({
      overrides: async () => {
        const rows = await prisma.tuningOverride.findMany({ select: { target: true, value: true, appliedAt: true, proposalId: true } });
        const ids = rows.map((r) => r.proposalId).filter((x): x is string => typeof x === 'string');
        const props = ids.length ? await prisma.tuningProposal.findMany({ where: { id: { in: ids } }, select: { id: true, currentValue: true } }) : [];
        const before = new Map(props.map((p) => [p.id, p.currentValue as unknown]));
        return rows.map((r) => ({ target: r.target, value: r.value, appliedAt: r.appliedAt, previousValue: r.proposalId ? before.get(r.proposalId) : undefined }));
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.load();
    // Roll the snapshot just after 00:00 IST, so no session's first decision runs on yesterday's values.
    this.timer = setInterval(() => {
      if (istDateOf(this.now()) !== this.day) void this.load();
    }, SESSION_TUNING_RETRY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get<T extends TunableValue>(target: string, fallback: T): T {
    const t = this.now();
    if (istDateOf(t) !== this.day && t - this.triedAt >= SESSION_TUNING_RETRY_MS) void this.load();
    const v = this.snap.get(target);
    return v !== undefined && typeof v === typeof fallback ? (v as T) : fallback;
  }

  /** The session date the snapshot is for (null before the first good load). */
  sessionDate(): string | null {
    return this.day;
  }

  /** Load the snapshot for today's IST date. Never throws; single-flight. */
  load(): Promise<void> {
    if (this.inflight) return this.inflight;
    const t = this.now();
    this.triedAt = t;
    const day = istDateOf(t);
    const cut = istDayStartMs(day);
    this.inflight = (async () => {
      try {
        const rows = await this.source.overrides();
        const next = new Map<string, TunableValue>();
        for (const r of rows) {
          // Applied today ⇒ from tomorrow; today keeps the value in force before it (else the consumer's default).
          const appliedToday = !(r.appliedAt instanceof Date) || r.appliedAt.getTime() >= cut;
          if (appliedToday && r.previousValue === undefined) continue;
          const v = validateTunable(r.target, appliedToday ? r.previousValue : r.value);
          if (v.ok) next.set(r.target, v.value);
        }
        this.snap = next;
        this.day = day;
      } catch (e) {
        this.logger.warn(`[session-tuning] override read failed — keeping the ${this.day ?? 'default'} snapshot: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
