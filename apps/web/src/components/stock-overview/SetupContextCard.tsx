import clsx from 'clsx';
import type { CombinedTier, ContextFactorBreakdown } from '@/types';
import type { SourceState, TradePlan } from '@/hooks/useChartContext';
import {
  deriveTradePlanView,
  type TriggerLineView,
} from '@/components/charts/tradePlanView';
import { trapBand, type ProjectionBoxView, type ProjectionZonesView } from '@/components/charts/projectionBoxView';
import { Card } from './_shared';

// ─── Types (lifted from the old AnalysisPanel.tsx) ─────────────────────────
// AnalysisDto is the wire type returned by GET /signals/analyze. Hosted here
// now that the floating AnalysisPanel is gone — useChartAnalysis re-exports
// it through this module instead.

export interface LevelsSnapshot {
  pdh: number;
  pdl: number;
  orh: number | null;
  orl: number | null;
  vwap: number;
  todayHigh: number;
  todayLow: number;
  atr14: number;
  // Previous trading day's opening-range high/low. Used as fallback when
  // today's `orh`/`orl` are still null (e.g. pre-market, OR not yet locked).
  // The frontend renders these as dimmed `Y-ORH`/`Y-ORL` lines on the chart.
  prevOrh?: number | null;
  prevOrl?: number | null;
}

export interface IndicatorReadings {
  ema9: number | null;
  ema21: number | null;
  rsi14: number | null;
  macdHistogram: number | null;
  bollingerPosition: number | null;
  roc10: number | null;
  alignment: {
    ema: 1 | 0 | -1;
    rsi: 1 | 0 | -1;
    macd: 1 | 0 | -1;
    bollinger: 1 | 0 | -1;
    momentum: 1 | 0 | -1;
  };
  agreement: number;
}

export type SetupStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'PARTIAL_BOOKED'
  | 'TARGET_HIT'
  | 'STOPPED'
  | 'TRAIL_STOPPED'
  | 'EOD'
  | 'INVALIDATED';

export interface RecommendedStrike {
  strike: number;
  side: 'CE' | 'PE';
  expiry: string;
  ltp: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  oi: number;
  volume: number;
  expectedProfitPerShare: number;
  expectedLossPerShare: number;
  lotSize: number;
  expectedProfitPerLot: number;
  expectedLossPerLot: number;
  reason: string;
}

export interface SetupAnalysis {
  kind: 'setup';
  symbol: string;
  side: 'BUY' | 'SELL';
  entry: number;
  stoploss: number;
  target: number;
  levelType: 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'VWAP' | 'ROUND' | 'VOL_STRIKE';
  setupType: 'BREAKOUT' | 'REVERSAL';
  grade: 'A' | 'B' | 'C';
  atr14: number;
  volumeRatio: number;
  levels: LevelsSnapshot;
  reason: string;
  indicators?: IndicatorReadings;
  higherTimeframeTrend?: {
    tf: string;
    bias: 'bullish' | 'bearish' | 'neutral';
  } | null;
  regime?: 'trending' | 'choppy' | 'normal' | null;
  intradayRangeRatio?: number;
  status?: SetupStatus;
  setupId?: string;
  triggeredAt?: string | null;
  partialTakeAt?: number;
  trailingSl?: number | null;
  partialBookedAt?: string | null;
  recommendedStrike?: RecommendedStrike | null;
  invalidationKind?: 'structural' | 'counter-setup' | 'time-mfe' | null;
  invalidationReason?: string | null;
  tp1Source?: 'obstacle' | 'fixed';
  tp1Obstacle?: {
    classification: 'STRONG' | 'MEDIUM';
    touchCount: number;
    nearEdge: number;
  } | null;
  contextScore?: number;
  contextTier?: CombinedTier;
  contextCoverage?: number;
  contextFactors?: ContextFactorBreakdown[];
}

export type RejectGate =
  | 'distance'
  | 'confirmation'
  | 'rr'
  | 'regime-mismatch'
  | 'mtf-conflict'
  | 'grade-c';

export interface RankedReject {
  levelType: string;
  levelValue: number;
  blockedAt: RejectGate;
  side: 'BUY' | 'SELL' | null;
  progress: number;
  blockedReason: string;
  needsFor: string;
  detail?: Record<string, unknown>;
}

export interface NoSetupAnalysis {
  kind: 'no-setup';
  reason: string;
  levels: LevelsSnapshot | null;
  rejections?: RankedReject[];
}

export type AnalysisDto = SetupAnalysis | NoSetupAnalysis;

interface Props {
  analysis: AnalysisDto | null;
  loading?: boolean;
  /** The server's one trade plan. Undefined until the first response lands. */
  tradePlan?: TradePlan | null;
  /** `sources.tradePlan` — 'failed' means "we don't know", not "nothing". */
  tradePlanSource?: SourceState;
  /**
   * The projection view, ALREADY DERIVED by the page and shared with the
   * chart overlay. Passing the derived view rather than the raw zones is what
   * makes "chart draws a box while the card says unavailable" unexpressible.
   */
  projectionView?: ProjectionZonesView;
}

function fmt(n: number): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtRupees0(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  const absRounded = Math.round(Math.abs(n));
  return `${sign}₹ ${absRounded.toLocaleString('en-IN')}`;
}

function fmtPremium(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Card 1 of the StockOverviewPanel.
 *
 * It answers ONE question: what is the trade? When a setup is formed it shows
 * that trade; otherwise it shows the two triggers that would fire, one line
 * each. Everything the engine used to reach that answer — confluence chips,
 * regime, higher-timeframe bias, volume ratio, and the raw reject payload
 * (`reject:confirmation {...}`) — is still computed server-side and still
 * gates the setup, but is no longer rendered: it was engine state, not a
 * trade, and reading it was the user's job to synthesize.
 *
 * The state -> content decision lives in `deriveTradePlanView` so it is
 * testable without a DOM, and so the chart's two drawn lines come off the
 * same `TradePlan` fields this card reads.
 */
/**
 * One projected break: where entry is still valid, where it is aiming, and how
 * often that has actually happened.
 *
 * The hit-rate line is deliberately never omitted. "no measured history yet"
 * is a weaker claim than a percentage but it is a TRUE one, and a box with a
 * silent confidence reads as a confident box.
 */
function ProjectionRow({ box }: { box: ProjectionBoxView }) {
  const up = box.side === 'UP';
  return (
    <div
      className={clsx(
        'rounded border-l-2 py-1 pl-2',
        up ? 'border-emerald-500/70' : 'border-red-500/70',
        box.state === 'armed' && 'opacity-60',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={clsx('text-xs font-semibold', up ? 'text-emerald-400' : 'text-red-400')}>
          {box.headline}
        </span>
        <span className="text-[11px] text-zinc-500">{box.state}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-zinc-400">
        Enter {box.entryText} · SL {box.stopText} · T {box.targetText} · {box.rrText}
      </div>
      {/* Why THAT target. A projection without its reason is just a number. */}
      {box.convictionText && (
        <div className="text-[11px] text-zinc-500">{box.convictionText}</div>
      )}
      {box.cappedBySession && (
        <div className="text-[11px] text-amber-500/80">
          Capped by what&apos;s left of today&apos;s range
        </div>
      )}
      <div
        className={clsx(
          'text-[11px]',
          box.hasMeasuredHistory ? 'text-zinc-300' : 'italic text-zinc-500',
        )}
      >
        {box.hitRateText}
      </div>
    </div>
  );
}

function ProjectionSection({ view }: { view: ProjectionZonesView }) {
  if (view.kind === 'loading') return null;
  if (view.kind === 'unavailable' || view.kind === 'none') {
    return <div className="mt-3 border-t border-zinc-800 pt-2 text-[11px] italic text-zinc-500">{view.message}</div>;
  }
  if (!view.up && !view.down) return null;
  const trap = trapBand(view);
  return (
    <div className="mt-3 space-y-1.5 border-t border-zinc-800 pt-2">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">Projected breaks</div>
      {/* Named as well as drawn: "range-bound, waiting" is a position a trader
          takes deliberately, not the absence of a signal. */}
      {trap && (
        <div className="rounded border-l-2 border-zinc-500/70 py-1 pl-2 text-[11px] text-zinc-400">
          Range-bound between {trap.from.toLocaleString('en-IN')} and{' '}
          {trap.to.toLocaleString('en-IN')} — neither side has broken yet.
        </div>
      )}
      {view.up && <ProjectionRow box={view.up} />}
      {view.down && <ProjectionRow box={view.down} />}
    </div>
  );
}

export default function SetupContextCard({
  analysis,
  loading,
  tradePlan,
  tradePlanSource,
  projectionView,
}: Props) {
  const view = deriveTradePlanView({
    plan: tradePlan,
    analysis,
    source: tradePlanSource,
    loading: !!loading,
  });

  if (view.kind === 'loading') {
    return (
      <Card title="Setup &amp; Context">
        <div className="space-y-2">
          <div className="h-3 w-3/4 animate-pulse rounded bg-zinc-700/60" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-zinc-700/60" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-700/60" />
        </div>
        <div className="mt-3 text-xs italic text-zinc-500">Analyzing...</div>
      </Card>
    );
  }

  if (view.kind === 'unavailable' || view.kind === 'none') {
    return (
      <Card title="Setup &amp; Context">
        <p className="text-sm text-zinc-400">{view.message}</p>
        {/* A break can be projected even when no trigger qualifies — the two
            answer different questions, so the boxes still render here. */}
        {projectionView && <ProjectionSection view={projectionView} />}
      </Card>
    );
  }

  if (view.kind === 'triggers') {
    return (
      <Card title="Setup &amp; Context">
        <div className="text-sm font-semibold text-zinc-300">No setup right now</div>
        <div className="mt-2 space-y-1.5 border-t border-zinc-700/60 pt-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Waiting for
          </div>
          {view.above ? (
            <TriggerRow trigger={view.above} />
          ) : (
            <div className="text-[11px] text-zinc-500">Nothing set up above.</div>
          )}
          {view.below ? (
            <TriggerRow trigger={view.below} />
          ) : (
            <div className="text-[11px] text-zinc-500">Nothing set up below.</div>
          )}
        </div>
        {projectionView && <ProjectionSection view={projectionView} />}
      </Card>
    );
  }

  const trade = view.trade;
  // The extras (status, TP1, options play, market context) only exist on a
  // live setup payload; the plan alone carries the trade itself.
  const setup = analysis?.kind === 'setup' ? analysis : null;
  const isBuy = trade.side === 'BUY';
  const gradeClass =
    trade.grade === 'A'
      ? 'bg-emerald-500/20 text-emerald-300'
      : trade.grade === 'B'
        ? 'bg-blue-500/20 text-blue-300'
        : 'bg-zinc-500/20 text-zinc-300';

  return (
    <Card
      title="Setup &amp; Context"
      className={clsx(isBuy ? 'border-emerald-500/40' : 'border-red-500/40')}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div
            className={clsx(
              'rounded-md px-2 py-1 text-xs font-bold',
              isBuy ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
            )}
          >
            {trade.side}
          </div>
          {setup?.status && (
            <StatusBadge
              status={setup.status}
              invalidationKind={setup.invalidationKind ?? null}
            />
          )}
        </div>
        <div className="text-[11px] text-zinc-300">
          {setup && <span className="font-semibold text-zinc-100">{setup.symbol}</span>}
          <span className="mx-1 text-zinc-500">·</span>
          <span className="text-zinc-400">{trade.levelSource}</span>
        </div>
      </div>

      {setup?.status === 'INVALIDATED' && setup.invalidationReason && (() => {
        const kindLabel =
          setup.invalidationKind === 'structural'
            ? 'STRUCTURAL EXIT'
            : setup.invalidationKind === 'counter-setup'
              ? 'COUNTER FLIP'
              : setup.invalidationKind === 'time-mfe'
                ? 'TIMED OUT'
                : 'CLOSED';
        return (
          <div className="mt-3 rounded-md border-2 border-amber-500/50 bg-amber-500/10 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
              <span>⚠</span>
              <span>Invalidated — {kindLabel}</span>
            </div>
            <div className="mt-1 text-[11px] leading-snug text-amber-100/90">
              {setup.invalidationReason}
            </div>
          </div>
        );
      })()}

      <div
        className={clsx(
          'mt-3 space-y-1.5 text-[12px]',
          setup?.status === 'INVALIDATED' && 'opacity-60',
        )}
      >
        <div className="flex items-center justify-between">
          <span className="text-amber-400">Entry</span>
          <span className="font-mono tabular-nums text-zinc-100">{trade.entryText}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-red-400">SL</span>
          <span className="font-mono tabular-nums text-zinc-100">{trade.stoplossText}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-emerald-400">Target</span>
          <span className="font-mono tabular-nums text-zinc-100">{trade.targetText}</span>
        </div>
      </div>

      {setup && setup.partialTakeAt !== undefined && setup.partialTakeAt !== null && (
        <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-t border-zinc-700/60 pt-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">TP1</span>
          <span className="text-right">
            <span className="font-mono text-[11px] tabular-nums text-white">
              {fmt(setup.partialTakeAt)}
            </span>
            {setup.tp1Source === 'obstacle' && setup.tp1Obstacle && (
              <span
                className="ml-1.5 text-[9px] uppercase tracking-wider text-zinc-500"
                title={`TP1 sits just before a ${setup.tp1Obstacle.classification} zone with ${setup.tp1Obstacle.touchCount} historical touches at ${setup.tp1Obstacle.nearEdge.toFixed(2)}`}
              >
                at {setup.tp1Obstacle.classification.toLowerCase()} zone · {setup.tp1Obstacle.touchCount}t
              </span>
            )}
          </span>
          {setup.status === 'PARTIAL_BOOKED' && (
            <>
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Trail</span>
              <span className="text-right font-mono text-[11px] tabular-nums text-white">
                {setup.trailingSl !== null && setup.trailingSl !== undefined
                  ? fmt(setup.trailingSl)
                  : '—'}
              </span>
            </>
          )}
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Tgt2</span>
          <span className="text-right font-mono text-[11px] tabular-nums text-white">
            {trade.targetText}
          </span>
        </div>
      )}

      {setup?.recommendedStrike && (() => {
        const r = setup.recommendedStrike!;
        const expiryShort = r.expiry.slice(0, 10);
        const showLot = r.lotSize > 1;
        return (
          <div className="mt-3 border-t border-zinc-700/60 pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              Options Play
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-200">
              <span className="font-semibold tabular-nums">
                {r.side} {fmt(r.strike)}
              </span>
              <span className="text-zinc-500">Exp {expiryShort}</span>
            </div>
            <div className="mt-1 grid grid-cols-3 gap-x-2 text-[10px] tabular-nums">
              <div className="flex flex-col">
                <span className="text-zinc-500">Premium</span>
                <span className="text-zinc-100">{fmtPremium(r.ltp)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-zinc-500">Δ</span>
                <span className="text-zinc-100">{r.delta.toFixed(2)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-zinc-500">IV</span>
                <span className="text-zinc-100">{r.iv.toFixed(1)}</span>
              </div>
            </div>
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                Expected P&amp;L
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[11px] tabular-nums">
                <span className="text-emerald-400">
                  {showLot
                    ? `${fmtRupees0(r.expectedProfitPerLot)} / lot @ TGT`
                    : `${fmtRupees0(r.expectedProfitPerShare)} @ TGT`}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] tabular-nums">
                <span className="text-red-400">
                  {showLot
                    ? `-₹ ${Math.round(Math.abs(r.expectedLossPerLot)).toLocaleString('en-IN')} / lot @ SL`
                    : `-₹ ${Math.abs(r.expectedLossPerShare).toFixed(2)} @ SL`}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* R:R and Grade only. `vol ×` is gone: for an index it was always
          0.00× (no volume is reported for index tokens), which read as
          "volume disconfirmed this" when the truth was "nothing to read". */}
      <div className="mt-3 flex items-center justify-between border-t border-zinc-700/60 pt-2 text-[10px]">
        <span className="rounded bg-zinc-700/60 px-1.5 py-0.5 font-mono tabular-nums text-zinc-200">
          {trade.rrText}
        </span>
        {trade.grade && (
          <span className={clsx('rounded px-1.5 py-0.5 font-bold', gradeClass)}>
            Grade {trade.grade}
          </span>
        )}
      </div>

      {/* Confluence chips (EMA/RSI/MACD/BB/MOM), Regime and the 1H-trend row
          used to render here. They are engine state, not a trade — still
          computed and still gating the setup, just no longer shown. */}

      {setup && setup.contextScore !== undefined && setup.contextFactors && (
        <div className="mt-3 border-t border-zinc-700/60 pt-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Market Context
            </span>
            <span
              className={clsx(
                'text-[11px] font-bold tabular-nums',
                setup.contextTier === 'STRONG_BULL' && 'text-emerald-400',
                setup.contextTier === 'BULL' && 'text-emerald-300',
                setup.contextTier === 'STRONG_BEAR' && 'text-red-400',
                setup.contextTier === 'BEAR' && 'text-red-300',
                setup.contextTier === 'NEUTRAL' && 'text-zinc-300',
              )}
            >
              {setup.contextScore > 0 ? '+' : ''}
              {setup.contextScore} {setup.contextTier?.replace('_', ' ')}
            </span>
          </div>
          <div className="mt-0.5 text-[9px] text-zinc-500">
            {setup.contextFactors.filter((f) => !f.isStub).length}/
            {setup.contextFactors.length} factors active · coverage{' '}
            {Math.round((setup.contextCoverage ?? 0) * 100)}%
          </div>
          <div className="mt-1.5 space-y-0.5">
            {setup.contextFactors.map((f) => (
              <div
                key={f.name}
                className="flex items-center justify-between text-[10px]"
              >
                <span
                  className={clsx(
                    'font-mono uppercase tracking-wider',
                    f.isStub ? 'text-zinc-600' : 'text-zinc-400',
                  )}
                >
                  {f.name}
                </span>
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
                      f.isStub
                        ? 'bg-zinc-700/30 text-zinc-500'
                        : f.tier === 'STRONG_BULL'
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : f.tier === 'BULL'
                            ? 'bg-emerald-500/10 text-emerald-300'
                            : f.tier === 'STRONG_BEAR'
                              ? 'bg-red-500/15 text-red-400'
                              : f.tier === 'BEAR'
                                ? 'bg-red-500/10 text-red-300'
                                : 'bg-zinc-700/40 text-zinc-400',
                    )}
                    title={
                      f.isStub
                        ? 'Stub factor — backend returns NEUTRAL_STUB until implemented'
                        : `value ${f.value.toFixed(2)} · weight ${(f.weight * 100).toFixed(0)}%`
                    }
                  >
                    {f.isStub ? 'STUB' : f.tier.replace('_', ' ')}
                  </span>
                  <span
                    className={clsx(
                      'w-8 text-right tabular-nums',
                      f.contribution > 0
                        ? 'text-emerald-400'
                        : f.contribution < 0
                          ? 'text-red-400'
                          : 'text-zinc-500',
                    )}
                  >
                    {f.contribution > 0 ? '+' : ''}
                    {Math.round(f.contribution)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sanitized upstream: a reason carrying an engine debug payload
          (`reject:confirmation {...}`) is dropped, never rendered. */}
      {trade.reason && (
        <div className="mt-2 text-[10px] italic leading-snug text-zinc-500">{trade.reason}</div>
      )}
      {projectionView && <ProjectionSection view={projectionView} />}
    </Card>
  );
}

/**
 * One forward trigger, e.g.
 * `Above 24,630 (PDH) → BUY  SL 24,590  T 24,720  1:2.0`.
 *
 * The pieces are laid out here but composed in `deriveTradePlanView`, so the
 * single-line form the tests assert on and the rendered form are the same
 * numbers off the same trigger object.
 */
function TriggerRow({ trigger }: { trigger: TriggerLineView }) {
  const isBuy = trigger.side === 'BUY';
  return (
    <div
      className={clsx(
        'rounded border px-2 py-1.5',
        isBuy ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5',
      )}
      title={trigger.text}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            {trigger.prefix}
          </span>
          <span className="font-mono text-[12px] tabular-nums text-zinc-100">
            {trigger.priceText}
          </span>
          <span className="rounded bg-zinc-700/60 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-zinc-300">
            {trigger.levelSource}
          </span>
        </div>
        <span
          className={clsx(
            'text-[10px] font-bold uppercase',
            isBuy ? 'text-emerald-400' : 'text-red-400',
          )}
        >
          {trigger.side}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-3 font-mono text-[10px] tabular-nums text-zinc-400">
        <span>SL {trigger.stoplossText}</span>
        <span>T {trigger.targetText}</span>
        <span className="text-zinc-300">{trigger.rrText}</span>
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  invalidationKind,
}: {
  status: SetupStatus;
  invalidationKind?: SetupAnalysis['invalidationKind'];
}) {
  const cfg: Record<SetupStatus, { label: string; classes: string; pulse: boolean }> = {
    PENDING:        { label: 'PENDING',    classes: 'bg-amber-500/15 text-amber-300',     pulse: true },
    ACTIVE:         { label: 'ACTIVE',     classes: 'bg-blue-500/20 text-blue-300',       pulse: true },
    PARTIAL_BOOKED: { label: 'TP1 BOOKED', classes: 'bg-cyan-500/20 text-cyan-300',       pulse: true },
    TARGET_HIT:     { label: 'TARGET',     classes: 'bg-emerald-500/20 text-emerald-300', pulse: false },
    STOPPED:        { label: 'STOPPED',    classes: 'bg-red-500/20 text-red-300',         pulse: false },
    TRAIL_STOPPED:  { label: 'TRAIL EXIT', classes: 'bg-violet-500/20 text-violet-300',   pulse: false },
    EOD:            { label: 'EOD',        classes: 'bg-zinc-700/40 text-zinc-400',       pulse: false },
    INVALIDATED:    { label: 'CLOSED',     classes: 'bg-zinc-700/40 text-zinc-400',       pulse: false },
  };

  let c = cfg[status];
  if (status === 'INVALIDATED' && invalidationKind) {
    if (invalidationKind === 'structural') {
      c = { label: 'STRUCTURAL EXIT', classes: 'bg-amber-500/20 text-amber-300', pulse: false };
    } else if (invalidationKind === 'counter-setup') {
      c = { label: 'COUNTER FLIP', classes: 'bg-violet-500/20 text-violet-300', pulse: false };
    } else if (invalidationKind === 'time-mfe') {
      c = { label: 'TIMED OUT', classes: 'bg-zinc-600/40 text-zinc-300', pulse: false };
    }
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
        c.classes,
      )}
    >
      {c.pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {c.label}
    </span>
  );
}
