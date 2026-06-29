import clsx from 'clsx';
import type { CombinedTier, ContextFactorBreakdown } from '@/types';
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

function computeRR(setup: SetupAnalysis): string {
  const risk = Math.abs(setup.entry - setup.stoploss);
  const reward = Math.abs(setup.target - setup.entry);
  if (risk === 0) return '–';
  return `1:${(reward / risk).toFixed(2)}`;
}

/**
 * Card 1 of the StockOverviewPanel. Lifts the body of the (deleted) floating
 * AnalysisPanel into a regular in-flow card. Renders setup details (entry,
 * SL, target, TP1, RR, grade, options play, context-scoring breakdown) when
 * a setup is active; falls back to a "No active setup" placeholder otherwise.
 *
 * The drag wrapper, localStorage position, and absolute placement from the
 * old AnalysisPanel are all gone — this card lives in the document flow.
 */
export default function SetupContextCard({ analysis, loading }: Props) {
  if (analysis === null && loading) {
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

  if (analysis === null) {
    return (
      <Card title="Setup &amp; Context">
        <p className="text-sm text-zinc-500">
          No active setup on this instrument right now.
        </p>
      </Card>
    );
  }

  if (analysis.kind === 'no-setup') {
    const topRejects = (analysis.rejections ?? []).slice(0, 3);
    return (
      <Card title="Setup &amp; Context">
        <div className="text-sm font-semibold text-zinc-300">No setup right now</div>

        {topRejects.length > 0 ? (
          <div className="mt-2 space-y-1.5 border-t border-zinc-700/60 pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Closest to firing
            </div>
            {topRejects.map((r, i) => (
              <RejectRow
                key={`${r.levelType}-${r.levelValue}-${i}`}
                reject={r}
                highlight={i === 0}
              />
            ))}
          </div>
        ) : (
          <div className="mt-1 text-[11px] italic text-zinc-500" title={analysis.reason}>
            {analysis.reason}
          </div>
        )}

        {analysis.levels && (
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-zinc-700/60 pt-2 text-[11px]">
            <div className="flex justify-between">
              <span className="text-zinc-500">PDH</span>
              <span className="font-mono tabular-nums text-zinc-300">{fmt(analysis.levels.pdh)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">PDL</span>
              <span className="font-mono tabular-nums text-zinc-300">{fmt(analysis.levels.pdl)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">VWAP</span>
              <span className="font-mono tabular-nums text-zinc-300">{fmt(analysis.levels.vwap)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">ATR14</span>
              <span className="font-mono tabular-nums text-zinc-300">{fmt(analysis.levels.atr14)}</span>
            </div>
          </div>
        )}
      </Card>
    );
  }

  const isBuy = analysis.side === 'BUY';
  const gradeClass =
    analysis.grade === 'A'
      ? 'bg-emerald-500/20 text-emerald-300'
      : analysis.grade === 'B'
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
            {analysis.side}
          </div>
          {analysis.status && (
            <StatusBadge
              status={analysis.status}
              invalidationKind={analysis.invalidationKind ?? null}
            />
          )}
        </div>
        <div className="text-[11px] text-zinc-300">
          <span className="font-semibold text-zinc-100">{analysis.symbol}</span>
          <span className="mx-1 text-zinc-500">·</span>
          <span className="text-zinc-400">
            {analysis.levelType} {analysis.setupType}
          </span>
        </div>
      </div>

      {analysis.status === 'INVALIDATED' && analysis.invalidationReason && (() => {
        const kindLabel =
          analysis.invalidationKind === 'structural'
            ? 'STRUCTURAL EXIT'
            : analysis.invalidationKind === 'counter-setup'
              ? 'COUNTER FLIP'
              : analysis.invalidationKind === 'time-mfe'
                ? 'TIMED OUT'
                : 'CLOSED';
        return (
          <div className="mt-3 rounded-md border-2 border-amber-500/50 bg-amber-500/10 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
              <span>⚠</span>
              <span>Invalidated — {kindLabel}</span>
            </div>
            <div className="mt-1 text-[11px] leading-snug text-amber-100/90">
              {analysis.invalidationReason}
            </div>
          </div>
        );
      })()}

      <div
        className={clsx(
          'mt-3 space-y-1.5 text-[12px]',
          analysis.status === 'INVALIDATED' && 'opacity-60',
        )}
      >
        <div className="flex items-center justify-between">
          <span className="text-amber-400">Entry</span>
          <span className="font-mono tabular-nums text-zinc-100">{fmt(analysis.entry)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-red-400">SL</span>
          <span className="font-mono tabular-nums text-zinc-100">{fmt(analysis.stoploss)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-emerald-400">Target</span>
          <span className="font-mono tabular-nums text-zinc-100">{fmt(analysis.target)}</span>
        </div>
      </div>

      {analysis.partialTakeAt !== undefined && analysis.partialTakeAt !== null && (
        <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-t border-zinc-700/60 pt-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">TP1</span>
          <span className="text-right">
            <span className="font-mono text-[11px] tabular-nums text-white">
              {fmt(analysis.partialTakeAt)}
            </span>
            {analysis.tp1Source === 'obstacle' && analysis.tp1Obstacle && (
              <span
                className="ml-1.5 text-[9px] uppercase tracking-wider text-zinc-500"
                title={`TP1 sits just before a ${analysis.tp1Obstacle.classification} zone with ${analysis.tp1Obstacle.touchCount} historical touches at ${analysis.tp1Obstacle.nearEdge.toFixed(2)}`}
              >
                at {analysis.tp1Obstacle.classification.toLowerCase()} zone · {analysis.tp1Obstacle.touchCount}t
              </span>
            )}
          </span>
          {analysis.status === 'PARTIAL_BOOKED' && (
            <>
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Trail</span>
              <span className="text-right font-mono text-[11px] tabular-nums text-white">
                {analysis.trailingSl !== null && analysis.trailingSl !== undefined
                  ? fmt(analysis.trailingSl)
                  : '—'}
              </span>
            </>
          )}
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Tgt2</span>
          <span className="text-right font-mono text-[11px] tabular-nums text-white">
            {fmt(analysis.target)}
          </span>
        </div>
      )}

      {analysis.recommendedStrike && (() => {
        const r = analysis.recommendedStrike!;
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

      <div className="mt-3 flex items-center justify-between border-t border-zinc-700/60 pt-2 text-[10px]">
        <span className="rounded bg-zinc-700/60 px-1.5 py-0.5 font-mono tabular-nums text-zinc-200">
          {computeRR(analysis)}
        </span>
        <span className={clsx('rounded px-1.5 py-0.5 font-bold', gradeClass)}>
          Grade {analysis.grade}
        </span>
        <span className="font-mono tabular-nums text-zinc-400">
          vol {analysis.volumeRatio.toFixed(2)}×
        </span>
      </div>

      {analysis.higherTimeframeTrend && (() => {
        const mtf = analysis.higherTimeframeTrend!;
        const label =
          mtf.bias === 'bullish'
            ? 'BULLISH'
            : mtf.bias === 'bearish'
              ? 'BEARISH'
              : 'NEUTRAL';
        const arrow = mtf.bias === 'bullish' ? '↑' : mtf.bias === 'bearish' ? '↓' : '—';
        const tone = clsx(
          mtf.bias === 'bullish' && 'text-emerald-400',
          mtf.bias === 'bearish' && 'text-red-400',
          mtf.bias === 'neutral' && 'text-zinc-400',
        );
        return (
          <div className="mt-2 flex items-center justify-between border-t border-zinc-700/60 pt-2 text-[10px]">
            <span className="font-semibold uppercase tracking-wider text-zinc-500">
              {mtf.tf.toUpperCase()} Trend
            </span>
            <span className={clsx('font-semibold uppercase tracking-wider', tone)}>
              {label} {arrow}
            </span>
          </div>
        );
      })()}

      {analysis.regime && (() => {
        const regime = analysis.regime!;
        const ratio = analysis.intradayRangeRatio ?? 0;
        const label =
          regime === 'trending' ? 'TRENDING' : regime === 'choppy' ? 'CHOPPY' : 'NORMAL';
        const tone = clsx(
          regime === 'trending' && 'text-emerald-400',
          regime === 'choppy' && 'text-amber-400',
          regime === 'normal' && 'text-zinc-400',
        );
        return (
          <div className="mt-2 flex items-center justify-between border-t border-zinc-700/60 pt-2 text-[10px]">
            <span className="font-semibold uppercase tracking-wider text-zinc-500">
              Regime
            </span>
            <span className={clsx('font-semibold uppercase tracking-wider', tone)}>
              {label} ({ratio.toFixed(1)}×)
            </span>
          </div>
        );
      })()}

      {analysis.indicators && (() => {
        const ind = analysis.indicators;
        const aligned = (
          [ind.alignment.ema, ind.alignment.rsi, ind.alignment.macd, ind.alignment.bollinger, ind.alignment.momentum] as const
        ).filter((v) => v === 1).length;
        const arrow = isBuy ? '↑' : '↓';
        const headerClass =
          ind.agreement >= 4
            ? 'text-emerald-400'
            : ind.agreement <= -2
              ? 'text-red-400'
              : 'text-zinc-400';

        const fmtMacd = (v: number | null) =>
          v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
        const fmtRsi = (v: number | null) => (v === null ? 'n/a' : v.toFixed(1));
        const fmtRoc = (v: number | null) =>
          v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
        const emaTitle =
          ind.ema9 !== null && ind.ema21 !== null
            ? `EMA9${ind.ema9 > ind.ema21 ? '>' : ind.ema9 < ind.ema21 ? '<' : '='}EMA21`
            : 'EMA n/a';
        const bbTitle =
          ind.bollingerPosition === null
            ? 'BB n/a'
            : `BB pos ${ind.bollingerPosition >= 0 ? '+' : ''}${ind.bollingerPosition.toFixed(2)}`;

        const chips: { label: string; alignment: 1 | 0 | -1; title: string }[] = [
          { label: 'EMA', alignment: ind.alignment.ema, title: emaTitle },
          { label: 'RSI', alignment: ind.alignment.rsi, title: `RSI ${fmtRsi(ind.rsi14)}` },
          { label: 'MACD', alignment: ind.alignment.macd, title: `MACD hist ${fmtMacd(ind.macdHistogram)}` },
          { label: 'BB', alignment: ind.alignment.bollinger, title: bbTitle },
          { label: 'MOM', alignment: ind.alignment.momentum, title: `ROC10 ${fmtRoc(ind.roc10)}` },
        ];

        return (
          <div className="mt-3 border-t border-zinc-700/60 pt-2">
            <div className={clsx('text-[10px] font-semibold uppercase tracking-wider', headerClass)}>
              Confluence: {aligned}/5 {arrow}
            </div>
            <div className="mt-1.5 flex items-center gap-1">
              {chips.map((chip) => (
                <span
                  key={chip.label}
                  title={chip.title}
                  className={clsx(
                    'text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded',
                    chip.alignment === 1
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : chip.alignment === -1
                        ? 'bg-red-500/15 text-red-400'
                        : 'bg-zinc-700/40 text-zinc-500',
                  )}
                >
                  {chip.label}
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      {analysis.contextScore !== undefined && analysis.contextFactors && (
        <div className="mt-3 border-t border-zinc-700/60 pt-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Market Context
            </span>
            <span
              className={clsx(
                'text-[11px] font-bold tabular-nums',
                analysis.contextTier === 'STRONG_BULL' && 'text-emerald-400',
                analysis.contextTier === 'BULL' && 'text-emerald-300',
                analysis.contextTier === 'STRONG_BEAR' && 'text-red-400',
                analysis.contextTier === 'BEAR' && 'text-red-300',
                analysis.contextTier === 'NEUTRAL' && 'text-zinc-300',
              )}
            >
              {analysis.contextScore > 0 ? '+' : ''}
              {analysis.contextScore} {analysis.contextTier?.replace('_', ' ')}
            </span>
          </div>
          <div className="mt-0.5 text-[9px] text-zinc-500">
            {analysis.contextFactors.filter((f) => !f.isStub).length}/
            {analysis.contextFactors.length} factors active · coverage{' '}
            {Math.round((analysis.contextCoverage ?? 0) * 100)}%
          </div>
          <div className="mt-1.5 space-y-0.5">
            {analysis.contextFactors.map((f) => (
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

      <div className="mt-2 truncate text-[10px] italic text-zinc-500" title={analysis.reason}>
        {analysis.reason}
      </div>
    </Card>
  );
}

function RejectRow({ reject, highlight }: { reject: RankedReject; highlight: boolean }) {
  const tone =
    reject.progress >= 4
      ? 'border-emerald-500/40 bg-emerald-500/5'
      : reject.progress >= 2
        ? 'border-amber-500/30 bg-amber-500/5'
        : 'border-zinc-700/60 bg-zinc-800/40';
  const sideColor =
    reject.side === 'BUY'
      ? 'text-emerald-400'
      : reject.side === 'SELL'
        ? 'text-red-400'
        : 'text-zinc-400';
  return (
    <div className={clsx('rounded border px-2 py-1.5', tone, highlight && 'ring-1 ring-amber-500/30')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {reject.side && (
            <span className={clsx('text-[9px] font-bold uppercase', sideColor)}>{reject.side}</span>
          )}
          <span className="rounded bg-zinc-700/60 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-zinc-300">
            {reject.levelType}
          </span>
          <span className="font-mono tabular-nums text-[11px] text-zinc-200">
            {fmt(reject.levelValue)}
          </span>
        </div>
        <span className="text-[9px] font-mono tabular-nums text-zinc-500">{reject.progress}/5</span>
      </div>
      <div className="mt-0.5 text-[10px] leading-tight text-zinc-400">{reject.blockedReason}</div>
      {reject.needsFor && (
        <div className="text-[10px] leading-tight text-zinc-500">
          <span className="text-zinc-600">needs: </span>
          {reject.needsFor}
        </div>
      )}
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
