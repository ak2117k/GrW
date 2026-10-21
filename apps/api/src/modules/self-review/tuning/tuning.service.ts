import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { validateTunable, type TunableValue, type TuningReader } from './tunables';

/** Overrides are re-read at most this often (contract: refresh ≤ 60 s). */
export const TUNING_REFRESH_MS = 60_000;

export interface OverrideSource {
  overrides(): Promise<Array<{ target: string; value: unknown }>>;
}

/**
 * Serves `tuning_overrides` to the consumers (scorecard weights, news confirmation, exit-discipline).
 *
 *  - `get(target, default)` is SYNCHRONOUS and never throws: it answers from the cache, and kicks a
 *    single-flight background refresh when the cache is older than {@link TUNING_REFRESH_MS}.
 *  - A failed refresh EMPTIES the cache: every consumer falls back to its code default until the DB
 *    answers again (contract: "DB failure → code default").
 *  - An override row that is not allow-listed, or out of bounds, or of the wrong type is ignored.
 */
@Injectable()
export class TuningService implements TuningReader, OnModuleInit {
  private readonly logger = new Logger(TuningService.name);
  private cache = new Map<string, TunableValue>();
  private loadedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly source: OverrideSource,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static fromPrisma(prisma: PrismaService): TuningService {
    return new TuningService({
      overrides: () => prisma.tuningOverride.findMany({ select: { target: true, value: true } }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  get<T extends TunableValue>(target: string, fallback: T): T {
    if (this.now() - this.loadedAt >= TUNING_REFRESH_MS) void this.refresh();
    const v = this.cache.get(target);
    return v !== undefined && typeof v === typeof fallback ? (v as T) : fallback;
  }

  /** The current overrides (for the API / proposal engine's "current value"). */
  snapshot(): Record<string, TunableValue> {
    return Object.fromEntries(this.cache);
  }

  /** Re-read now (after an approve). Never throws. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const rows = await this.source.overrides();
        const next = new Map<string, TunableValue>();
        for (const r of rows) {
          const v = validateTunable(r.target, r.value);
          if (v.ok) next.set(r.target, v.value);
          else this.logger.warn(`[tuning] ignoring override ${r.target}: ${v.reason}`);
        }
        this.cache = next;
      } catch (e) {
        if (this.cache.size > 0) {
          this.logger.warn(`[tuning] override read failed — serving code defaults: ${e instanceof Error ? e.message : String(e)}`);
        }
        this.cache = new Map();
      } finally {
        this.loadedAt = this.now();
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
