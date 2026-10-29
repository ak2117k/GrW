import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { SessionClock } from '../../market-hub/session-clock';
import { istMidnightOf, istYmd, lastSessionDates } from '../../night-report/domain/night-report.logic';
import { shapeOf } from '../../overnight-scorecard/domain/positions';
import { outcomeSession } from '../../overnight-scorecard/domain/windows';
import { directionOf, isExpired, proposeTuning, type EvidenceRow, type PastDecision, type RunSkill, type Suggestion } from '../domain/proposals';
import {
  latestPerWindowSymbol,
  openClose,
  pickNightVerdicts,
  scoreLiveExit,
  scoreMbmPrediction,
  scoreMbmRelative,
  scoreNewsIdea,
  scoreOvernightVerdict,
  scoreScorecardFactors,
  scoreScorecardTotal,
  scoreStockMove,
  scoreTradeSetup,
  scoreChannelSignal,
  scoreChannelInfo,
  type ScorecardRow,
} from '../domain/scorers';
import { buildSummary, channelStats, mergeChannelInfoStats, topMisses } from '../domain/summary';
import { probabilitySkill, relativeSkill } from '../domain/skill';
import { signalPaperDigest, signalTradeStats } from '../domain/signal-trades';
import { SelfReviewRepository } from '../repositories/self-review.repository';
import { VerificationSourcesRepository } from '../repositories/verification-sources.repository';
import { SELF_REVIEW_CONFIG, type SelfReviewConfig } from '../self-review.config';
import { DIAGNOSIS_MISS_CAP, SELF_REVIEW_DIAGNOSIS, type DiagnosisOutput, type DiagnosisPort } from '../self-review.ports';
import type { RunSummary, VerificationDraft, VerificationKind } from '../self-review.types';
import { TUNABLES, type TunableValue } from '../tuning/tunables';
import { TuningService } from '../tuning/tuning.service';
import { STOCK_MOVE_HORIZON_DAYS } from '../../stock-move/stock-move.logic';
import { NEWS_IMPACT_REVIEW, type NewsImpactReviewSource } from '../../news-impact/news-impact.ports';
import { newsImpactSummary, scoreNewsImpact } from '../domain/news-impact-scorer';

export const SELF_REVIEW_CLOCK = Symbol('SELF_REVIEW_CLOCK');
/** The consumers' own defaults for targets whose code default is env-derived (exit-discipline). */
export const SELF_REVIEW_DEFAULTS = Symbol('SELF_REVIEW_DEFAULTS');
export type TunableDefaults = Readonly<Record<string, TunableValue>>;

const DAY_MS = 86_400_000;
/** Each run re-verifies this many closed sessions: outcomes filled late (daily bars at 23:45) are picked up. */
export const VERIFY_SESSIONS = 3;
export const ROLLING_SESSIONS = 20;
/**
 * Kinds handed to the diagnosis (factor misses are covered by their total; MBM misses are a model metric).
 * TRADE_SETUP added 2026-10-28 (owner): the next-morning setups missed 2 of 3 on 10-27 and nobody asked why.
 */
export const DIAGNOSED_KINDS: ReadonlySet<VerificationKind> = new Set(['SCORECARD_TOTAL', 'OVERNIGHT_VERDICT', 'LIVE_EXIT', 'NEWS_IDEA', 'TRADE_SETUP']);
const CONTRACT = /^([A-Z&-]+?)(\d{2})([A-Z]{3})(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface RunOutcome {
  started: boolean;
  runId?: string;
  session?: string;
  results?: number;
  proposals?: number;
  reason?: string;
}

/** Parse an option tradingsymbol (NIFTY28OCT2625000CE) for the chain-snapshot fallback. */
export function parseOption(symbol: string): { underlying: string; expiry: string; strike: number; type: 'CE' | 'PE' } | null {
  const m = CONTRACT.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[3]);
  if (mi < 0) return null;
  return { underlying: m[1], expiry: `20${m[4]}-${String(mi + 1).padStart(2, '0')}-${m[2]}`, strike: Number(m[5]), type: m[6] as 'CE' | 'PE' };
}

/**
 * The nightly self-review run (contract "What gets verified" + "Proposals"): verify the last closed
 * NSE sessions, summarise S, hand S's misses to stream B's diagnosis (when bound), and raise the
 * deterministic proposals. Single-flight; every kind fails soft on its own.
 */
@Injectable()
export class SelfReviewRunService {
  private readonly logger = new Logger(SelfReviewRunService.name);
  private running = false;

  constructor(
    private readonly repo: SelfReviewRepository,
    private readonly sources: VerificationSourcesRepository,
    private readonly tuning: TuningService,
    @Inject(SELF_REVIEW_CONFIG) private readonly config: SelfReviewConfig,
    @Inject(SELF_REVIEW_CLOCK) private readonly clock: SessionClock,
    @Inject(SELF_REVIEW_DEFAULTS) private readonly defaults: TunableDefaults,
    @Optional() @Inject(SELF_REVIEW_DIAGNOSIS) private readonly diagnosis?: DiagnosisPort,
    /** News impact reactions (@Global news-impact module); absent ⇒ no NEWS_IMPACT rows. */
    @Optional() @Inject(NEWS_IMPACT_REVIEW) private readonly newsImpact?: NewsImpactReviewSource,
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** The value in force for a target: override, else the consumer's default, else the code default. */
  currentValue(target: string): TunableValue {
    const t = TUNABLES[target];
    const fallback = this.defaults[target] ?? (t && t.default !== null ? t.default : 0);
    return this.tuning.get(target, fallback);
  }

  async run(now: Date = new Date(), trigger = 'cron'): Promise<RunOutcome> {
    if (!this.config.enabled) return { started: false, reason: 'SELF_REVIEW_ENABLED=false' };
    if (this.running) return { started: false, reason: 'a run is already going' };
    const sessions = lastSessionDates(now, this.clock, ROLLING_SESSIONS);
    if (sessions.length === 0) return { started: false, reason: 'no closed NSE session' };
    this.running = true;
    const S = sessions[0];
    let runId: string | undefined;
    try {
      const run = await this.repo.createRun(S);
      runId = run.id;
      const errors: string[] = [];
      const drafts: VerificationDraft[] = [];
      for (const s of sessions.slice(0, VERIFY_SESSIONS)) drafts.push(...(await this.verifySession(s, errors)));
      await this.repo.upsertResults(run.id, drafts);

      const sessionRows = (await this.repo.results({ sessionDate: S })).map(toDraft);
      const history = await this.repo.results({ sessions, kinds: ['SCORECARD_FACTOR', 'LIVE_EXIT', 'STOCK_MOVE'] }, 20_000);
      // STOCK_MOVE history is proposal evidence only; its bucket subjects are not scorecard factors.
      const summary = buildSummary(S, sessionRows, history.filter((h) => h.kind !== 'STOCK_MOVE'), sessions);
      await this.soft('MBM skill', errors, async () => {
        const mbm = await this.repo.results({ sessions, kinds: ['MBM_PREDICTION'] }, 20_000);
        const rel = await this.repo.results({ sessions, kinds: ['MBM_RELATIVE'] }, 20_000);
        summary.skill = {
          MBM_PREDICTION: {
            session: probabilitySkill(sessionRows.filter((r) => r.kind === 'MBM_PREDICTION')),
            rolling20: probabilitySkill(mbm),
          },
          MBM_RELATIVE: {
            session: relativeSkill(sessionRows.filter((r) => r.kind === 'MBM_RELATIVE')),
            rolling20: relativeSkill(rel),
          },
        };
        return [];
      });

      await this.soft('CHANNEL_SIGNAL stats', errors, async () => {
        const ch = await this.repo.results({ sessions, kinds: ['CHANNEL_SIGNAL'] }, 20_000);
        if (ch.length || sessionRows.some((r) => r.kind === 'CHANNEL_SIGNAL')) summary.byChannel = channelStats(sessionRows, ch, sessions);
        return [];
      });

      await this.soft('CHANNEL_INFO stats', errors, async () => {
        const inf = await this.repo.results({ sessions, kinds: ['CHANNEL_INFO'] }, 20_000);
        if (inf.length || sessionRows.some((r) => r.kind === 'CHANNEL_INFO')) summary.byChannel = mergeChannelInfoStats(summary.byChannel, sessionRows, inf, sessions);
        return [];
      });

      await this.soft('NEWS_IMPACT stats', errors, async () => {
        const rows = await this.repo.results({ sessions, kinds: ['NEWS_IMPACT'] }, 20_000);
        const today = sessionRows.filter((r) => r.kind === 'NEWS_IMPACT');
        if (rows.length || today.length) summary.news = { session: newsImpactSummary(today), rolling20: newsImpactSummary(rows) };
        return [];
      });

      await this.soft('SIGNAL_TRADES (live vs paper no-funds)', errors, async () => {
        const from = istMidnightOf(sessions[sessions.length - 1]);
        const to = new Date(istMidnightOf(S).getTime() + DAY_MS);
        const rows = await this.sources.signalTradeOutcomes(from, to);
        if (rows.paper.length || rows.live.length) summary.signalTrades = signalTradeStats(rows, sessions);
        return [];
      });

      const diagnosis = await this.diagnose(run.id, S, sessionRows, summary, errors);
      const mbmSkill = await this.mbmSkillRuns(S, summary, errors);
      const proposals = await this.propose(run.id, history, suggestionsOf(diagnosis), now, errors, mbmSkill);

      await this.repo.finishRun(run.id, { status: 'DONE', summary, error: errors.length ? errors.join('; ').slice(0, 2000) : null });
      this.logger.log(
        `[self-review] ${trigger} run ${run.id} for ${S}: ${drafts.length} results upserted, ${proposals} proposals` +
          (errors.length ? `, ${errors.length} soft errors` : ''),
      );
      return { started: true, runId: run.id, session: S, results: drafts.length, proposals };
    } catch (e) {
      this.logger.warn(`[self-review] run for ${S} failed: ${errText(e)}`);
      if (runId) await this.repo.finishRun(runId, { status: 'FAILED', error: errText(e).slice(0, 2000) }).catch(() => undefined);
      return { started: true, runId, session: S, reason: errText(e) };
    } finally {
      this.running = false;
    }
  }

  // ─── Verify ────────────────────────────────────────────────────────────────

  private sessionBounds(s: string): { midnight: Date; openAt: Date; closeAt: Date } | null {
    const midnight = istMidnightOf(s);
    const w = this.clock.tradingWindow('NSE', new Date(midnight.getTime() + 12 * 3_600_000));
    if (!w) return null;
    return {
      midnight,
      openAt: new Date(midnight.getTime() + w.openMin * 60_000),
      closeAt: new Date(midnight.getTime() + w.closeMin * 60_000),
    };
  }

  private async soft<T>(kind: string, errors: string[], fn: () => Promise<T[]>): Promise<T[]> {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${kind}: ${errText(e)}`);
      this.logger.warn(`[self-review] ${kind} scoring failed: ${errText(e)}`);
      return [];
    }
  }

  /** Every kind for one session. A kind that fails costs only itself. */
  async verifySession(s: string, errors: string[] = []): Promise<VerificationDraft[]> {
    const b = this.sessionBounds(s);
    if (!b) return [];
    // Rows whose outcome session is s were written between the previous session and s's open.
    const lookFrom = new Date(b.midnight.getTime() - 10 * DAY_MS);
    const inS = (at: Date) => outcomeSession(at, this.clock) === s;

    const scorecards: ScorecardRow[] = await this.soft('SCORECARD', errors, async () =>
      latestPerWindowSymbol(
        (await this.sources.scorecards(lookFrom, b.openAt))
          .filter((r) => r.moveBp !== null && inS(r.computedAt))
          .map((r) => ({ ...r, moveBp: r.moveBp as number, sessionDate: s })),
      ),
    );
    const out: VerificationDraft[] = [];
    for (const sc of scorecards) out.push(scoreScorecardTotal(sc), ...scoreScorecardFactors(sc));
    const proxy = new Map(scorecards.map((sc) => [sc.symbol, sc.moveBp]));

    out.push(...(await this.soft('OVERNIGHT_VERDICT', errors, () => this.overnight(s, b, lookFrom, inS, proxy))));
    out.push(
      ...(await this.soft('LIVE_EXIT', errors, async () =>
        (await this.sources.liveExits(b.midnight, new Date(b.midnight.getTime() + DAY_MS))).map((o) =>
          scoreLiveExit({ ...o, sessionDate: s, minutesSinceOpen: minutesSinceOpenOf(this.clock, o.exchange, o.decisionAt) }),
        ),
      )),
    );
    out.push(...(await this.soft('NEWS_IDEA', errors, () => this.newsIdeas(s, b.openAt, lookFrom, inS))));
    out.push(
      ...(await this.soft('MBM_PREDICTION', errors, async () => {
        const rows = (await this.sources.mbmPredictions(b.midnight, new Date(b.midnight.getTime() + DAY_MS))).map((r) => ({ ...r, sessionDate: s }));
        // The same rows judge the relative reading (MBM_RELATIVE) where they carry one.
        return [...rows.map(scoreMbmPrediction), ...rows.map(scoreMbmRelative).filter((d): d is VerificationDraft => d !== null)];
      })),
    );
    out.push(...(await this.soft('STOCK_MOVE', errors, () => this.stockMoves(s, b.closeAt))));
    // Outcomes are filled by the trade-setup module's 16:15 IST job, before this run.
    out.push(...(await this.soft('TRADE_SETUP', errors, async () => (await this.sources.tradeSetups(s)).map(scoreTradeSetup))));
    // Telegram channel tips: outcomes filled by signal-intake's 16:20 IST replay, before this run.
    out.push(...(await this.soft('CHANNEL_SIGNAL', errors, async () => (await this.sources.channelSignals(s)).map(scoreChannelSignal))));
    // Telegram INFO items (channel market views): outcomes filled by signal-intake after the close, before this run.
    out.push(...(await this.soft('CHANNEL_INFO', errors, async () => (await this.sources.channelInfos(s)).flatMap(scoreChannelInfo))));
    // News-impact reactions: points filled by the news-impact module's 15-min job, judged on their judge session.
    const newsImpact = this.newsImpact;
    if (newsImpact) {
      out.push(
        ...(await this.soft('NEWS_IMPACT', errors, async () =>
          (await newsImpact.reactionRows(s)).map(scoreNewsImpact).filter((d): d is VerificationDraft => d !== null),
        )),
      );
    }
    return out;
  }

  /**
   * Stock big-move rows whose 5-session horizon closes at s: scored on the session STOCK_MOVE_HORIZON_DAYS
   * sessions before s. Their outcome is filled by the writer after s's close (20:15 IST, after this run),
   * so a horizon is judged by the next night's re-verification (VERIFY_SESSIONS).
   */
  private async stockMoves(s: string, closeAt: Date): Promise<VerificationDraft[]> {
    const back = lastSessionDates(new Date(closeAt.getTime() + 60_000), this.clock, STOCK_MOVE_HORIZON_DAYS + 1);
    if (back[0] !== s || back.length <= STOCK_MOVE_HORIZON_DAYS) return [];
    const asOf = back[STOCK_MOVE_HORIZON_DAYS];
    return (await this.sources.stockMoves(asOf)).map((r) => scoreStockMove({ ...r, sessionDate: s }));
  }

  private async overnight(
    s: string,
    b: { openAt: Date; closeAt: Date },
    lookFrom: Date,
    inS: (at: Date) => boolean,
    proxy: Map<string, number>,
  ): Promise<VerificationDraft[]> {
    const verdicts = (await this.sources.nightVerdicts(lookFrom, b.openAt)).filter((v) => inS(v.createdAt));
    const picked = pickNightVerdicts(verdicts);
    const trackers = new Map((await this.sources.trackers([...new Set(picked.map((p) => p.row.trackerId))])).map((t) => [t.id, t]));
    const out: VerificationDraft[] = [];
    for (const p of picked) {
      const t = trackers.get(p.row.trackerId);
      // MCX positions trade to 23:30+, past this run: not an NSE-session outcome (open question).
      if (!t || t.exchange.toUpperCase() === 'MCX' || !t.qty) continue;
      const prices = await this.optionPrices(t, b);
      out.push(
        scoreOvernightVerdict({
          sessionDate: s,
          verdict: p.row,
          reruns: p.reruns,
          windows: p.windows,
          qty: t.qty,
          side: shapeOf(t.symbol, t.exchange, t.qty).side,
          prices,
          proxyMoveBp: proxy.get(t.symbol) ?? null,
        }),
      );
    }
    return out;
  }

  /** The instrument's own open→close: candles_1m, else chain snapshots (open falls back to an at-open exit fill). */
  private async optionPrices(
    t: { symbol: string; exchange: string; token: string; status: string; exitPrice: number | null; exitTime: Date | null },
    b: { openAt: Date; closeAt: Date },
  ): Promise<{ open: number; close: number; source: string } | null> {
    if (t.token) {
      const oc = openClose(await this.sources.bars1m(t.exchange, t.token, b.openAt, b.closeAt), b.openAt.getTime(), b.closeAt.getTime());
      if (oc) return { ...oc, source: 'candles_1m' };
    }
    const opt = parseOption(t.symbol);
    if (!opt) return null;
    const exitedAtOpen =
      t.exitPrice !== null && t.exitPrice > 0 && t.exitTime !== null &&
      t.exitTime.getTime() >= b.openAt.getTime() && t.exitTime.getTime() - b.openAt.getTime() <= 30 * 60_000;
    const chainOpen = await this.sources.chainLtp(opt.underlying, opt.expiry, opt.strike, opt.type, new Date(b.openAt.getTime() + 5 * 60_000));
    const open = chainOpen ?? (exitedAtOpen ? t.exitPrice : null);
    const close = await this.sources.chainLtp(opt.underlying, opt.expiry, opt.strike, opt.type, new Date(b.closeAt.getTime() - 5 * 60_000));
    if (open === null || close === null) return null;
    return { open, close, source: chainOpen !== null ? 'chain_snapshot' : 'tracker_exit+chain_snapshot' };
  }

  private async newsIdeas(s: string, openAt: Date, lookFrom: Date, inS: (at: Date) => boolean): Promise<VerificationDraft[]> {
    const ideas = (await this.sources.newsIdeas(lookFrom, openAt)).filter((i) => i.moveBp !== null && inS(i.createdAt));
    if (ideas.length === 0) return [];
    const [totals, sentiments] = await Promise.all([
      this.sources.scorecardTotals(ideas.map((i) => i.scorecardId).filter((x): x is string => !!x)),
      this.sources.articleSentiments(ideas.map((i) => i.newsIds[0]).filter((x): x is string => !!x)),
    ]);
    const totalOf = new Map(totals.map((t) => [t.id, t.total]));
    const atr = new Map<string, number | null>();
    const out: VerificationDraft[] = [];
    for (const i of ideas) {
      if (i.idea === 'NO_TRADE' && !atr.has(i.symbol)) atr.set(i.symbol, await this.sources.dailyRangeBp(i.symbol, openAt).catch(() => null));
      out.push(
        scoreNewsIdea({
          id: i.id,
          symbol: i.symbol,
          idea: i.idea,
          headline: i.headline,
          moveBp: i.moveBp as number,
          sessionDate: s,
          scorecardTotal: i.scorecardId ? totalOf.get(i.scorecardId) ?? null : null,
          sentiment: i.newsIds[0] ? sentiments.get(i.newsIds[0]) ?? null : null,
          atrBp: atr.get(i.symbol) ?? null,
        }),
      );
    }
    return out;
  }

  // ─── Diagnose ──────────────────────────────────────────────────────────────

  /**
   * Hand S's misses to stream B's diagnosis. Skipped (the earlier diagnosis reused) when a DONE run
   * of S already diagnosed at least as many misses — the 09:00 catch-up does not pay for a repeat.
   */
  private async diagnose(
    runId: string,
    S: string,
    rows: VerificationDraft[],
    summary: RunSummary,
    errors: string[],
  ): Promise<DiagnosisOutput | null> {
    const misses = topMisses(rows.filter((r) => DIAGNOSED_KINDS.has(r.kind)), DIAGNOSIS_MISS_CAP);
    const wrong = Object.values(summary.byKind).reduce((s, k) => s + (k?.wrong ?? 0), 0);
    const prior = (await this.repo.doneRunsFor(S)).find((r) => r.diagnosis !== null && r.id !== runId);
    if (prior) {
      const priorWrong = Object.values(((prior.summary as RunSummary | null)?.byKind ?? {}) as RunSummary['byKind']).reduce((s, k) => s + (k?.wrong ?? 0), 0);
      if (priorWrong >= wrong) return prior.diagnosis as unknown as DiagnosisOutput;
    }
    // The signal paper splits (OI verdict / AI judge) go in too: the owner checks the OI check at the nightly review.
    const signalPaper = signalPaperDigest(summary.signalTrades);
    if (!this.diagnosis || (misses.length === 0 && !signalPaper)) return null;
    try {
      const out = await this.diagnosis.diagnose(runId, misses, signalPaper ? { signalPaper } : undefined);
      // B persists the diagnosis itself; make sure the run carries it either way.
      if (out) await this.repo.setDiagnosisIfEmpty(runId, out);
      return out;
    } catch (e) {
      errors.push(`diagnosis: ${errText(e)}`);
      this.logger.warn(`[self-review] diagnosis failed (run continues): ${errText(e)}`);
      return null;
    }
  }

  // ─── Propose ───────────────────────────────────────────────────────────────

  /**
   * This run's MBM rolling-20 skill, then the previous session's last DONE run's (newest first) — the
   * `mbm.packet` rule needs two consecutive runs. A missing or unreadable one just means fewer runs.
   */
  private async mbmSkillRuns(S: string, summary: RunSummary, errors: string[]): Promise<RunSkill[]> {
    const out: RunSkill[] = [];
    const mine = summary.skill?.MBM_PREDICTION?.rolling20;
    if (!mine) return out;
    out.push({ session: S, skill: mine });
    try {
      const prev = await this.repo.previousDoneRun(S);
      const skill = (prev?.summary as RunSummary | null | undefined)?.skill?.MBM_PREDICTION?.rolling20;
      if (prev && skill && typeof skill.verdict === 'string') out.push({ session: prev.sessionDate, skill });
    } catch (e) {
      errors.push(`previous MBM skill: ${errText(e)}`);
    }
    return out;
  }

  /**
   * The owner's past decisions per key: APPLIED / REJECTED proposals (IST date of the decision) and the
   * overrides in force (their applied_at, which also covers an override written outside a proposal).
   * A read failure throws: proposing on stale evidence is exactly what this guards against.
   */
  private async pastDecisions(): Promise<PastDecision[]> {
    const [decided, overrides] = await Promise.all([this.repo.decidedProposals(500), this.repo.overrides()]);
    const out: PastDecision[] = decided.map((p) => ({
      key: p.key,
      status: p.status === 'APPLIED' ? 'APPLIED' : 'REJECTED',
      session: istYmd(p.decidedAt ?? p.createdAt),
      direction: directionOf(p.currentValue, p.proposedValue),
    }));
    for (const o of overrides) out.push({ key: o.target, status: 'APPLIED', session: istYmd(o.appliedAt) });
    return out;
  }

  private async propose(
    runId: string,
    history: EvidenceRow[],
    suggestions: Suggestion[],
    now: Date,
    errors: string[],
    mbmSkill: RunSkill[] = [],
  ): Promise<number> {
    try {
      const pending = await this.repo.proposals('PENDING', 500);
      const stale = pending.filter((p) => isExpired(p, now));
      if (stale.length) {
        await this.repo.expire(stale.map((p) => p.id));
        this.logger.log(`[self-review] expired ${stale.length} pending proposal(s) older than 14 days`);
      }
      const staleIds = new Set(stale.map((p) => p.id));
      const pendingKeys = new Set(pending.filter((p) => !staleIds.has(p.id)).map((p) => p.key));
      const decisions = await this.pastDecisions();
      const { drafts, rejected } = proposeTuning({ rows: history, current: (t) => this.currentValue(t), pendingKeys, suggestions, mbmSkill, decisions });
      for (const r of rejected) this.logger.log(`[self-review] proposal for ${r.target} not raised: ${r.reason}`);
      for (const d of drafts) {
        await this.repo.createProposal(d, runId);
        this.logger.log(`[self-review] PROPOSAL ${d.target}: ${JSON.stringify(d.currentValue)} → ${JSON.stringify(d.proposedValue)} (${d.rationale})`);
      }
      return drafts.length;
    } catch (e) {
      errors.push(`proposals: ${errText(e)}`);
      this.logger.warn(`[self-review] proposal step failed: ${errText(e)}`);
      return 0;
    }
  }
}

function suggestionsOf(d: DiagnosisOutput | null): Suggestion[] {
  if (!d || !Array.isArray(d.misses)) return [];
  return d.misses.filter((m) => m && typeof m.proposalTarget === 'string').map((m) => ({ proposalTarget: m.proposalTarget, proposedValue: m.proposedValue, cause: m.cause }));
}

/** Minutes from `exchange`'s session open to `at` (IST calendar); null off-session. */
export function minutesSinceOpenOf(clock: Pick<SessionClock, 'tradingWindow'>, exchange: string, at: Date): number | null {
  const w = clock.tradingWindow(exchange, at);
  if (!w) return null;
  const midnight = istMidnightOf(istYmd(at)).getTime();
  const m = (at.getTime() - midnight) / 60_000 - w.openMin;
  return m >= 0 && m <= w.closeMin - w.openMin ? Math.round(m * 10) / 10 : null;
}

export function toDraft(r: {
  sessionDate: string; kind: string; refId: string; subject: string | null; symbol: string | null;
  predicted: string; actual: string; correct: boolean | null; score: number | null; details: unknown; id?: string;
}): VerificationDraft & { id?: string } {
  return {
    ...(r.id ? { id: r.id } : {}),
    sessionDate: r.sessionDate,
    kind: r.kind as VerificationKind,
    refId: r.refId,
    subject: r.subject,
    symbol: r.symbol,
    predicted: r.predicted,
    actual: r.actual,
    correct: r.correct,
    score: r.score,
    details: (r.details as Record<string, unknown> | null) ?? null,
  };
}
