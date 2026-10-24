import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { istMinutes, istYmd } from '../../market-cues/fetchers/ist-dates';
import { istMidnightOf } from '../../night-report/domain/night-report.logic';
import type { SessionClock } from '../../market-hub/session-clock';
import { MCX_UNDERLYINGS, MCX_BENCHMARKS_V2 } from '../../news-events/keys';
import { AssistBusyError } from '../../ai-assist/assist-slot';
import {
  ANALYSE_WITHIN_MS,
  buildImpactUserMessage,
  highImpactTargets,
  impactRank,
  impactRunDue,
  impactSentiment,
  pickBatch,
  validateImpactReply,
  type ClusterForImpact,
  type ImpactItem,
} from '../domain/impact';
import { RELEVANT_AT } from '../domain/relevance';
import { isIndexSymbol, judgeSessionOf } from '../domain/reaction';
import { NEWS_IMPACT_CONFIG, type NewsImpactConfig } from '../news-impact.config';
import { NEWS_IMPACT_HIGH_EVENT, type NewsImpactHighEvent } from '../news-impact.ports';
import { NewsImpactRepository } from '../news-impact.repository';
import { IMPACT_LLM, type ImpactLlm } from './news-impact-llm.service';

export const NEWS_IMPACT_CLOCK = Symbol('NEWS_IMPACT_CLOCK');
/** Affected stocks per cluster whose reaction is recorded (plus the index). */
const REACTION_SYMBOLS = 3;
const COMMODITIES: ReadonlySet<string> = new Set([...MCX_UNDERLYINGS, ...MCX_BENCHMARKS_V2]);

export interface ImpactRunSummary {
  ran: boolean;
  reason?: string;
  sent?: number;
  stored?: number;
  high?: number;
}

/**
 * Layer 2 + 3a. Every 15 min (the cadence rule in `impactRunDue` makes it 15 min in the NSE session,
 * 2 h otherwise): ONE batched model call over the new relevant + material clusters (≤ 30), capped
 * at NEWS_IMPACT_DAILY_CALLS per IST day. Each valid item → news_impacts (+ the cluster's article
 * sentiment, + reaction rows). A HIGH impact on a held symbol / NIFTY / BANKNIFTY → one
 * 'news.impact.high' event (the sentinel's news wake) and one Telegram ops alert, once per cluster.
 * Places nothing.
 */
@Injectable()
export class NewsImpactService {
  private readonly logger = new Logger(NewsImpactService.name);
  private running = false;
  private lastRunAt: Date | null | undefined = undefined;
  /** In-memory call count per IST day (the cap still holds when ai_calls recording is off). */
  private calls: { day: string; n: number } = { day: '', n: 0 };

  constructor(
    private readonly repo: NewsImpactRepository,
    @Inject(NEWS_IMPACT_CONFIG) private readonly cfg: NewsImpactConfig,
    @Inject(NEWS_IMPACT_CLOCK) private readonly clock: SessionClock,
    @Inject(IMPACT_LLM) private readonly llm: ImpactLlm,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  @Cron('0 */15 * * * *', { name: 'news-impact-batch', timeZone: 'Asia/Kolkata' })
  async onTick(): Promise<ImpactRunSummary> {
    if (!bootJobsEnabled()) return { ran: false, reason: 'boot jobs off' };
    return this.run(new Date());
  }

  async run(now: Date): Promise<ImpactRunSummary> {
    if (!this.cfg.enabled || !this.cfg.llm) return { ran: false, reason: 'NEWS_IMPACT_LLM off' };
    if (this.running) return { ran: false, reason: 'previous run still going' };
    this.running = true;
    try {
      if (this.lastRunAt === undefined) this.lastRunAt = await this.repo.lastAiCallAt().catch(() => null);
      if (!impactRunDue(now, istMinutes(now), this.clock.isTradingDay('NSE', now), this.lastRunAt)) return { ran: false, reason: 'not due' };
      const day = istYmd(now);
      if (this.calls.day !== day) this.calls = { day, n: 0 };
      const used = Math.max(this.calls.n, await this.repo.aiCallsSince(istMidnightOf(day)).catch(() => 0));
      if (used >= this.cfg.dailyCalls) return { ran: false, reason: `daily cap ${this.cfg.dailyCalls} reached` };

      const batch = pickBatch(await this.repo.impactCandidates(new Date(now.getTime() - ANALYSE_WITHIN_MS), RELEVANT_AT), now);
      if (batch.length === 0) return { ran: true, sent: 0, stored: 0, high: 0 };
      return await this.analyse(batch, now);
    } catch (e) {
      this.logger.warn(`[news-impact] run failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: true, reason: e instanceof Error ? e.message : String(e) };
    } finally {
      this.running = false;
    }
  }

  private async analyse(batch: ClusterForImpact[], now: Date): Promise<ImpactRunSummary> {
    const texts = await this.repo.clusterTexts(batch);
    const message = buildImpactUserMessage(batch.map((c) => ({ ...c, ...(texts.get(c.id) ?? {}) })));
    let reply: unknown;
    this.calls.n++;
    this.lastRunAt = now;
    try {
      reply = await this.llm.analyse(message);
    } catch (e) {
      if (e instanceof AssistBusyError) {
        this.calls.n--; // never started
        this.logger.log('[news-impact] shared model slot busy — batch skipped, next run retries');
        return { ran: true, reason: 'busy', sent: 0 };
      }
      await this.repo.bumpAttempts(batch.map((c) => c.id));
      throw e;
    }
    const items = validateImpactReply(reply, batch.map((c) => c.id));
    const got = new Set(items.map((i) => i.clusterId));
    await this.repo.bumpAttempts(batch.filter((c) => !got.has(c.id)).map((c) => c.id));

    const byId = new Map(batch.map((c) => [c.id, c]));
    let held: Set<string> | null = null;
    let high = 0;
    for (const item of items) {
      const c = byId.get(item.clusterId)!;
      try {
        const saved = await this.repo.upsertImpact(item, this.cfg.model, c.sourceCount, impactRank(item, c.relevance, c.sourceCount), now);
        const s = impactSentiment(item);
        await this.repo.setClusterSentiment(c.id, s.sentiment, s.score);
        await this.recordReactions(saved.id, c, item);
        if (item.magnitude === 'HIGH' && this.cfg.alerts && saved.alertedAt === null) {
          held ??= await this.repo.heldUnderlyings().catch(() => new Set<string>());
          if (await this.highImpact(saved.id, c, item, held, now)) high++;
        }
      } catch (e) {
        this.logger.warn(`[news-impact] storing ${c.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.logger.log(`[news-impact] ${items.length}/${batch.length} clusters analysed (${high} high-impact alert(s))`);
    return { ran: true, sent: batch.length, stored: items.length, high };
  }

  /** One reaction row per affected stock (≤ 3, no commodities) and the index. */
  private async recordReactions(impactId: string, c: ClusterForImpact, item: ImpactItem): Promise<void> {
    const symbols = [...item.affected.symbols.filter((s) => !COMMODITIES.has(s) && !isIndexSymbol(s)).slice(0, REACTION_SYMBOLS), ...(item.affected.index ? [item.affected.index] : [])];
    if (symbols.length === 0) return;
    const open = this.clock.isOpen('NSE', c.firstSeen);
    const anchor = open ? c.firstSeen : this.clock.nextOpen('NSE', c.firstSeen);
    if (!anchor) return;
    const w = this.clock.tradingWindow('NSE', anchor);
    const closeAt = w ? new Date(istMidnightOf(istYmd(anchor)).getTime() + w.closeMin * 60_000) : anchor;
    const next = this.clock.nextOpen('NSE', closeAt);
    const judgeSession = judgeSessionOf(item.horizon, istYmd(anchor), next ? istYmd(next) : null);
    for (const symbol of symbols) {
      await this.repo.createReaction({
        impactId,
        clusterId: c.id,
        symbol,
        kind: isIndexSymbol(symbol) ? 'INDEX' : 'STOCK',
        direction: item.direction,
        magnitude: item.magnitude,
        horizon: item.horizon,
        anchorAt: anchor,
        anchorIsOpen: !open,
        judgeSession,
        atr: null,
      });
    }
  }

  /** Emit the sentinel event + one ops alert, at most once per cluster (alertedAt claimed atomically). */
  private async highImpact(impactId: string, c: ClusterForImpact, item: ImpactItem, held: ReadonlySet<string>, now: Date): Promise<boolean> {
    const targets = highImpactTargets(item, held);
    if (targets.length === 0) return false;
    if (!(await this.repo.markAlerted(impactId, now))) return false;
    const evt: NewsImpactHighEvent = {
      clusterId: c.id,
      impactId,
      headline: c.headline,
      direction: item.direction,
      magnitude: item.magnitude,
      horizon: item.horizon,
      oneLine: item.oneLine,
      targets,
      analysedAt: now.toISOString(),
    };
    try {
      this.events?.emit(NEWS_IMPACT_HIGH_EVENT, evt);
    } catch (e) {
      this.logger.warn(`[news-impact] high-impact event failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    void sendOpsAlert(
      `news-impact:${c.id}`,
      `GrW news impact — HIGH ${item.direction} (${item.horizon.toLowerCase()}) on ${targets.join(', ')}\n` +
        `${c.headline.slice(0, 200)}\n${item.oneLine}\n` +
        `sources: ${c.sourceCount}${item.pricedIn ? ' · may be priced in' : ''} · confidence ${Math.round(item.confidence * 100)}%`,
    );
    return true;
  }
}
