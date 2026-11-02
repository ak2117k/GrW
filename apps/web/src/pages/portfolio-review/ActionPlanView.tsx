import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Info } from 'lucide-react';
import { Badge } from '@/components/common';
import { cn } from '@/utils/cn';
import type { ActionPlan, EvidenceChip, HoldingAction, NewIdea } from '@/types/portfolioReview.types';
import { chipVariant, inr, pct, pnlTone, price, recommendationLabel, recommendationVariant } from './portfolioReviewFormat';

const CARD = 'rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3 sm:p-4';
const INNER = 'rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)] p-3';
const MUTED = 'text-[var(--color-text-muted)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';
const PRIMARY = 'text-[var(--color-text-primary)]';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className={CARD}>
      <h2 className={cn('text-sm font-semibold', PRIMARY)}>{title}</h2>
      {hint && <p className={cn('mt-0.5 text-xs', MUTED)}>{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Fact({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={INNER}>
      <div className={cn('text-[11px] font-medium uppercase tracking-wide', MUTED)}>{label}</div>
      <div className={cn('mt-1 text-base font-semibold', tone ?? PRIMARY)}>{value}</div>
      {sub && <div className={cn('mt-0.5 text-xs', SECONDARY)}>{sub}</div>}
    </div>
  );
}

function Chips({ chips }: { chips: EvidenceChip[] }) {
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <Badge key={c.label} label={c.label} size="sm" variant={chipVariant(c.tone)} />
      ))}
    </div>
  );
}

const arrow = (a: number, b: number, unit = '%') => `${a.toFixed(1)}${unit} → ${b.toFixed(1)}${unit}`;

/** What the row asks the user to do, in one short line. */
function actionLine(h: HoldingAction): string {
  switch (h.recommendation) {
    case 'ADD':
      return `Buy ${h.qty} more (~${inr(h.cashImpact)})`;
    case 'TRIM':
      return `Sell ${h.qty} of ${h.heldQty} (frees ~${inr(-h.cashImpact)})`;
    case 'EXIT':
      return `Sell all ${h.qty} (frees ~${inr(-h.cashImpact)})`;
    case 'SET_STOP':
      return `Keep ${h.heldQty}, place a stop`;
    default:
      return `Keep ${h.heldQty}`;
  }
}

function HoldingRow({ h }: { h: HoldingAction }) {
  return (
    <li className={INNER}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('text-sm font-semibold', PRIMARY)}>{h.symbol}</span>
            <Badge label={recommendationLabel(h.recommendation)} size="sm" variant={recommendationVariant(h.recommendation)} />
          </div>
          <div className={cn('mt-0.5 text-xs', SECONDARY)}>{actionLine(h)}</div>
        </div>
        <div className="grid grid-cols-3 gap-3 text-right text-xs">
          <div>
            <div className={MUTED}>Stop</div>
            <div className={cn('font-medium', PRIMARY)}>{h.stop != null ? price(h.stop) : '—'}</div>
          </div>
          <div>
            <div className={MUTED}>P&amp;L</div>
            <div className={cn('font-medium', pnlTone(h.pnl))}>{pct(h.pnlPct, true)}</div>
          </div>
          <div>
            <div className={MUTED}>Weight</div>
            <div className={cn('font-medium', PRIMARY)}>{h.weightPct === h.weightAfterPct ? `${h.weightPct.toFixed(1)}%` : arrow(h.weightPct, h.weightAfterPct)}</div>
          </div>
        </div>
      </div>
      <div className={cn('mt-1 text-[11px]', MUTED)}>
        {h.heldQty} held · LTP {price(h.ltp)} · {h.daysHeld} days{h.evidence.sector ? ` · ${h.evidence.sector}` : ''}
        {h.stop != null && ` · stop ${h.stopBasis}`}
      </div>
      <div className="mt-2">
        <Chips chips={h.chips} />
      </div>
      <ul className={cn('mt-2 list-disc space-y-0.5 pl-4 text-xs', SECONDARY)}>
        {h.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {h.blocked.length > 0 && h.recommendation !== 'ADD' && <p className={cn('mt-1 text-[11px]', MUTED)}>Not an add because: {h.blocked.join('; ')}.</p>}
    </li>
  );
}

function IdeaCard({ i }: { i: NewIdea }) {
  return (
    <li className={INNER}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={cn('text-sm font-semibold', PRIMARY)}>{i.symbol}</span>
          {i.sector && <span className={cn('text-xs', MUTED)}>{i.sector}</span>}
        </div>
        <Badge label={i.qty > 0 ? `${i.qty} sh · ${inr(i.amount)}` : 'Watchlist'} size="sm" variant={i.qty > 0 ? 'success' : 'neutral'} />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className={MUTED}>Entry zone</div>
          <div className={cn('font-medium', PRIMARY)}>
            {price(i.entryLow)} – {price(i.entryHigh)}
          </div>
        </div>
        <div>
          <div className={MUTED}>Stop</div>
          <div className={cn('font-medium', PRIMARY)}>{price(i.stop)}</div>
        </div>
        <div>
          <div className={MUTED}>Risk to stop</div>
          <div className={cn('font-medium', PRIMARY)}>{i.qty > 0 ? inr(i.riskRupees) : '—'}</div>
        </div>
      </div>
      <div className="mt-2">
        <Chips chips={i.chips} />
      </div>
      <ul className={cn('mt-2 list-disc space-y-0.5 pl-4 text-xs', SECONDARY)}>
        {i.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </li>
  );
}

const BALANCE_LABEL = { LIVE: 'live', LAST_KNOWN: 'last known', NO_DATA: 'unknown' } as const;

/** "What you can do next": the rule-based plan for the holdings, the cash sizing and new ideas. */
export function ActionPlanView({ plan }: { plan: ActionPlan | null | undefined }) {
  if (!plan) {
    return (
      <section className={CARD}>
        <p className={cn('text-sm', SECONDARY)}>This review was made before the action plan existed. Run a new review to get “what you can do next”.</p>
      </section>
    );
  }
  const s = plan.sizing;
  const ex = plan.explanation;
  const rules = plan.rules;
  return (
    <div className="space-y-3 sm:space-y-4">
      <p className={cn('flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs', SECONDARY)}>
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <span>{plan.disclaimer}</span>
      </p>

      <Section title="In short">
        {ex.status === 'OK' && ex.text ? (
          <div className={cn('space-y-2 text-sm [&_li]:ml-4 [&_ol]:list-decimal [&_strong]:text-[var(--color-text-primary)] [&_ul]:list-disc', SECONDARY)}>
            <ReactMarkdown>{ex.text}</ReactMarkdown>
          </div>
        ) : (
          <div className={cn('space-y-1 text-sm', SECONDARY)}>
            <p>
              {plan.counts.EXIT} exit · {plan.counts.TRIM} trim · {plan.counts.SET_STOP} set stop · {plan.counts.ADD} add · {plan.counts.HOLD} hold · {plan.ideas.length} new idea
              {plan.ideas.length === 1 ? '' : 's'}.
            </p>
            <p className={cn('text-xs', MUTED)}>AI explanation: {ex.reason ?? ex.status.toLowerCase()}.</p>
          </div>
        )}
      </Section>

      <Section
        title="Your balance, on the safe side"
        hint={`Rules: keep ≥ ${rules.cashBufferPct}% of capital in cash · no stock above ${rules.maxWeightPct}% · at most ${rules.maxNewIdeaPct}% of capital per add or new idea · no averaging down (no add below the 200-DMA or at a loss worse than ${rules.maxLossToAddPct}%).`}
      >
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Fact
            label="Available cash"
            value={s.balance.status === 'NO_DATA' ? '—' : inr(s.cash)}
            sub={`${BALANCE_LABEL[s.balance.status]}${s.balance.status === 'NO_DATA' && s.balance.reason ? ` (${s.balance.reason})` : ''}`}
          />
          <Fact label="Total capital" value={inr(s.totalCapital)} sub={`holdings ${inr(s.holdingsValue)}`} />
          <Fact label="Cash share" value={arrow(s.cashPctBefore, s.cashPctAfter)} sub={`buffer ${rules.cashBufferPct}% = ${inr(s.bufferRupees)}`} tone={s.cashPctAfter >= rules.cashBufferPct ? 'text-[var(--color-accent-green)]' : 'text-[var(--color-accent-red)]'} />
          <Fact label="Freed / spent" value={`${inr(s.freed)} / ${inr(s.spent)}`} sub="sales first, then buys" />
          <Fact label="Largest weight" value={arrow(s.maxWeightBeforePct, s.maxWeightAfterPct)} sub={`${s.overCapBefore} → ${s.overCapAfter} above the ${rules.maxWeightPct}% cap`} />
          <Fact label="In a downtrend" value={arrow(s.downTrendPctBefore, s.downTrendPctAfter)} sub="of capital, below the 200-DMA" />
          <Fact label="If every stop hits" value={inr(s.riskToStops)} sub="loss from the last price" />
          <Fact label="Broker reads" value={`${plan.brokerCalls.used} / ${plan.brokerCalls.cap}`} sub="this run's cap" />
        </div>
        {s.notes.length > 0 && (
          <ul className={cn('mt-3 list-disc space-y-1 pl-4 text-xs', SECONDARY)}>
            {s.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        {s.raiseCash && s.raiseCash.candidates.length > 0 && (
          <div className={cn(INNER, 'mt-3')}>
            <div className={cn('text-xs font-medium', PRIMARY)}>
              To restore the {rules.cashBufferPct}% buffer ({inr(s.raiseCash.needed)} short), the weakest holdings by the rules would go first:
            </div>
            <ul className={cn('mt-1 space-y-0.5 text-xs', SECONDARY)}>
              {s.raiseCash.candidates.map((c) => (
                <li key={c.symbol} className="flex justify-between gap-2">
                  <span>
                    {c.symbol} <span className={MUTED}>· {c.why}</span>
                  </span>
                  <span>{inr(c.value)}</span>
                </li>
              ))}
            </ul>
            <p className={cn('mt-1 text-[11px]', MUTED)}>
              Together {inr(s.raiseCash.covered)}. Your choice — these keep their own recommendation above.
            </p>
          </div>
        )}
        {s.weights.length > 0 && (
          <div className="-mx-1 mt-3 overflow-x-auto">
            <table className="w-full min-w-[300px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)]">
                  <th className={cn('px-2 py-1 text-left font-medium uppercase tracking-wide', MUTED)}>Weight</th>
                  <th className={cn('px-2 py-1 text-right font-medium uppercase tracking-wide', MUTED)}>Now</th>
                  <th className={cn('px-2 py-1 text-right font-medium uppercase tracking-wide', MUTED)}>After the plan</th>
                </tr>
              </thead>
              <tbody>
                {s.weights.map((w) => (
                  <tr key={w.symbol} className="border-b border-[var(--color-border-subtle)] last:border-0">
                    <td className={cn('px-2 py-1', PRIMARY)}>{w.symbol}</td>
                    <td className={cn('px-2 py-1 text-right', w.beforePct > rules.maxWeightPct ? 'text-[var(--color-accent-red)]' : SECONDARY)}>{w.beforePct.toFixed(1)}%</td>
                    <td className={cn('px-2 py-1 text-right', w.afterPct > rules.maxWeightPct ? 'text-[var(--color-accent-red)]' : SECONDARY)}>{w.afterPct.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Your holdings: what you can do" hint="Exit and trim first, then stops, then adds. Each stop is a protective level to place at the broker; the chips are the evidence behind the call.">
        {plan.holdings.length ? (
          <ul className="space-y-2">
            {plan.holdings.map((h) => (
              <HoldingRow key={`${h.token}-${h.symbol}`} h={h} />
            ))}
          </ul>
        ) : (
          <p className={cn('text-xs', MUTED)}>No open holdings.</p>
        )}
      </Section>

      <Section
        title="New ideas"
        hint={`Liquid F&O stocks in a strong uptrend (above the 20/50/200-DMA, 6-month return ≥ ${rules.minIdeaRet6mPct}%, not more than ${rules.maxIdeaExtensionPct}% above the 20-DMA), futures OI not against, no negative news, one per sector. Buy only inside the entry zone.`}
      >
        {plan.ideas.length ? (
          <ul className="grid gap-2 lg:grid-cols-2">
            {plan.ideas.map((i) => (
              <IdeaCard key={i.symbol} i={i} />
            ))}
          </ul>
        ) : (
          <p className={cn('text-xs', MUTED)}>No stock passed the screen this run.</p>
        )}
        <p className={cn('mt-2 text-[11px]', MUTED)}>
          Screened {plan.screen.fetched + plan.screen.cachedToday} of {plan.screen.universe} F&amp;O stocks ({plan.screen.passedTrend} passed the trend rules, OI checked for {plan.screen.oiChecked})
          {plan.screen.skippedReason ? ` · ${plan.screen.skippedReason}` : ''}.
        </p>
      </Section>

      {plan.dataNotes.length > 0 && (
        <Section title="About this plan's data">
          <ul className={cn('list-disc space-y-1 pl-4 text-xs', SECONDARY)}>
            {plan.dataNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            <li>News is context only — the app's news reader is about a coin flip on direction, so it never decides an action on its own.</li>
          </ul>
        </Section>
      )}
    </div>
  );
}
