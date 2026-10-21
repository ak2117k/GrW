import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { DiagnosisResult } from '../diagnose/types';
import { lessonDeltas, lessonsModeFrom, selectForInjection, shouldRetire } from './lessons.logic';
import {
  LESSON_CACHE_TTL_MS,
  type InjectedLesson,
  type InjectionScope,
  type LessonRecord,
  type LessonsMode,
  type LessonsReader,
  type LessonUpsertSummary,
} from './types';

/** The slice of Prisma this service uses (a test double implements just this). */
export interface LessonsStore {
  agentLesson: {
    findMany(args: { where?: Record<string, unknown>; orderBy?: unknown }): Promise<LessonRecord[]>;
    findUnique(args: { where: { key: string } | { id: string } }): Promise<LessonRecord | null>;
    create(args: { data: Record<string, unknown> }): Promise<LessonRecord>;
    update(args: { where: { key: string } | { id: string }; data: Record<string, unknown> }): Promise<LessonRecord>;
  };
}

/** Optional clock override (tests). */
export const LESSONS_NOW = 'SELF_REVIEW_LESSONS_NOW';

/** How often an observe-mode "would inject" line is logged per scope. */
const OBSERVE_LOG_EVERY_MS = 5 * 60_000;

/**
 * Agent lessons: upsert from a diagnosis, counters, auto-retire, and the cached,
 * synchronous {@link LessonsReader} the sentinel packet and the news-ideas prompt read.
 *
 * HOT PATH IS DB-FREE. `inject()` only reads the in-memory cache; when the cache is older
 * than 5 min it starts a background refresh and answers from what it has. A failed refresh
 * keeps the previous cache (or none) and is logged — it can never fail a packet.
 */
@Injectable()
export class LessonsService implements LessonsReader, OnModuleInit {
  private readonly logger = new Logger(LessonsService.name);
  private cache: { at: number; rows: LessonRecord[] } | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly observeLogged = new Map<InjectionScope, number>();
  readonly mode: LessonsMode;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() config?: ConfigService,
    @Optional() @Inject(LESSONS_NOW) private readonly now: () => number = Date.now,
  ) {
    this.mode = lessonsModeFrom(config?.get<string>('SELF_REVIEW_LESSONS') ?? process.env.SELF_REVIEW_LESSONS);
  }

  private get store(): LessonsStore {
    return this.prisma as unknown as LessonsStore;
  }

  onModuleInit(): void {
    if (this.mode !== 'off') void this.refresh();
  }

  /** Every ACTIVE lesson in `scope` (and `ALL`), from the database — for the diagnosis and the API. */
  async activeFor(scope: InjectionScope | 'ALL'): Promise<LessonRecord[]> {
    const where =
      scope === 'ALL' ? { status: 'ACTIVE' } : { status: 'ACTIVE', scope: { in: [scope, 'ALL'] } };
    return this.store.agentLesson.findMany({ where, orderBy: [{ rightCount: 'desc' }, { key: 'asc' }] });
  }

  /** Every lesson (any status), newest first — for the API's lessons tab. */
  async list(): Promise<LessonRecord[]> {
    return this.store.agentLesson.findMany({ orderBy: [{ status: 'asc' }, { lastSeen: 'desc' }] });
  }

  /** Owner retire (idempotent). Returns the row, or null when there is no such lesson. */
  async retire(id: string, by?: string): Promise<LessonRecord | null> {
    const row = await this.store.agentLesson.findUnique({ where: { id } });
    if (!row) return null;
    const out = row.status === 'RETIRED' ? row : await this.store.agentLesson.update({ where: { id }, data: { status: 'RETIRED' } });
    this.logger.log(`[lessons] retired ${row.key} (right ${row.rightCount}, wrong ${row.wrongCount})${by ? ` by ${by}` : ''}`);
    void this.refresh();
    return out;
  }

  /**
   * Apply one run's diagnosis: create new keys (with text), bump counters on existing ones,
   * auto-retire any that cross the rule. A RETIRED lesson is counted but never revived.
   * Call ONCE per run — counters are additive. Never throws for a single bad key.
   */
  async upsertFromDiagnosis(
    runId: string,
    result: DiagnosisResult | null | undefined,
    kindOf?: (refId: string) => string | undefined,
  ): Promise<LessonUpsertSummary> {
    const summary: LessonUpsertSummary = { created: [], updated: [], retired: [] };
    if (!result) return summary;
    const at = new Date(this.now());
    for (const d of lessonDeltas(result, kindOf)) {
      try {
        const existing = await this.store.agentLesson.findUnique({ where: { key: d.key } });
        if (!existing) {
          if (!d.text || d.right === 0) continue; // a new lesson needs text and a case it explains
          await this.store.agentLesson.create({
            data: { key: d.key, text: d.text, scope: d.scope, rightCount: d.right, wrongCount: d.wrong, status: 'ACTIVE', firstSeen: at, lastSeen: at, sourceRun: runId },
          });
          summary.created.push(d.key);
          continue;
        }
        const right = existing.rightCount + d.right;
        const wrong = existing.wrongCount + d.wrong;
        const retire = existing.status === 'ACTIVE' && shouldRetire(right, wrong);
        await this.store.agentLesson.update({
          where: { key: d.key },
          data: { rightCount: right, wrongCount: wrong, lastSeen: at, ...(retire ? { status: 'RETIRED' } : {}) },
        });
        summary.updated.push(d.key);
        if (retire) {
          summary.retired.push(d.key);
          this.logger.log(`[lessons] auto-retired ${d.key}: wrong ${wrong} > right ${right}`);
        }
      } catch (e) {
        this.logger.warn(`[lessons] upsert ${d.key} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (summary.created.length + summary.updated.length > 0) {
      this.logger.log(`[lessons] run ${runId}: created ${summary.created.length}, updated ${summary.updated.length}, retired ${summary.retired.length}`);
      void this.refresh();
    }
    return summary;
  }

  /**
   * {@link LessonsReader}: the lessons to show an agent in `scope`, synchronously from the
   * cache. `off` → []; `observe` → [] and a throttled log of what would be injected.
   */
  inject(scope: InjectionScope): InjectedLesson[] {
    if (this.mode === 'off') return [];
    try {
      const t = this.now();
      if (!this.cache || t - this.cache.at >= LESSON_CACHE_TTL_MS) void this.refresh();
      const lessons = this.cache ? selectForInjection(this.cache.rows, scope) : [];
      if (this.mode === 'on') return lessons;
      const last = this.observeLogged.get(scope);
      if (lessons.length > 0 && (last === undefined || t - last >= OBSERVE_LOG_EVERY_MS)) {
        this.observeLogged.set(scope, t);
        this.logger.log(`[lessons] observe: would inject ${lessons.length} into ${scope}: ${lessons.map((l) => l.key).join(', ')}`);
      }
      return [];
    } catch (e) {
      this.logger.warn(`[lessons] inject(${scope}) skipped: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /** Reload ACTIVE lessons into the cache. Single-flight; never rejects. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const rows = await this.store.agentLesson.findMany({ where: { status: 'ACTIVE' } });
        this.cache = { at: this.now(), rows };
      } catch (e) {
        // Keep the old rows, but stamp the attempt so a down DB is retried every TTL, not every packet.
        this.cache = { at: this.now(), rows: this.cache?.rows ?? [] };
        this.logger.warn(`[lessons] cache refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}
