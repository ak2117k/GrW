import { Badge, SymbolChartLink } from '@/components/common';
import { cn } from '@/utils/cn';
import type { TradeSetupView, TradeSetupsView } from '@/types/nightReport.types';
import { levelsText, outcomeText, qtyText, riskText, sessionLine, sideText } from './tradeSetupsFormat';

const CARD = 'rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3 sm:p-4';
const MUTED = 'text-[var(--color-text-muted)]';
const SECONDARY = 'text-[var(--color-text-secondary)]';
const PRIMARY = 'text-[var(--color-text-primary)]';

function SetupCard({ s }: { s: TradeSetupView }) {
  const out = outcomeText(s);
  return (
    <li className={cn(CARD, 'space-y-2 text-sm')} data-testid="trade-setup-card">
      <div className="flex flex-wrap items-center gap-2">
        <SymbolChartLink symbol={s.symbol} token={null} exchange="NSE" className={cn('min-h-10 font-semibold', PRIMARY)} />
        <Badge label={sideText(s)} variant={s.side === 'SHORT' ? 'danger' : 'success'} size="sm" />
        <span className={cn('text-xs', SECONDARY)}>{s.instrument}</span>
        {s.exceedsRisk && <Badge label="exceeds 1% risk" variant="warning" size="sm" />}
      </div>
      <p className={PRIMARY}>{s.entryRule}</p>
      <p className={cn('tabular-nums', PRIMARY)}>{levelsText(s)}</p>
      <p className={cn('text-xs', SECONDARY)}>{s.inputs.stopRule} {s.inputs.targetsRule} {s.inputs.timeExit}</p>
      <p className={cn('tabular-nums', PRIMARY)}>
        {qtyText(s)} · {riskText(s)}
      </p>
      <p className={cn('text-xs', SECONDARY)}>Sized on {s.inputs.sizingBasis}.</p>
      {s.inputs.sizingNotes.map((n) => (
        <p key={n} className={cn('text-xs', n.startsWith('exceeds') ? 'text-amber-400' : MUTED)}>{n}</p>
      ))}
      <p className={cn('text-xs', MUTED)}>{s.inputs.levelsNote}</p>
      <ul className="space-y-0.5 text-xs">
        {s.inputs.context.map((c) => (
          <li key={c.label} className={c.available ? SECONDARY : MUTED}>
            <span className="font-medium">{c.label}:</span> {c.text}
          </li>
        ))}
      </ul>
      {s.inputs.headlines.length > 0 && (
        <ul className={cn('list-disc pl-4 text-xs', SECONDARY)}>
          {s.inputs.headlines.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      <div className="text-xs">
        <p className={cn('font-medium', SECONDARY)}>Skip if</p>
        <ul className={cn('list-disc pl-4', MUTED)}>
          {s.inputs.skipIf.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
      <p className={cn('text-xs italic', MUTED)}>
        {s.inputs.trigger}. {s.inputs.direction}
      </p>
      {out && <p className={cn('text-xs', SECONDARY)}>{out}</p>}
    </li>
  );
}

/**
 * Night report "Trade setups": next-morning futures / intraday-cash plans where a news idea and the
 * big-move model agree. Advisory only — the owner places any order by hand.
 */
export function TradeSetupsPanel({ view }: { view: TradeSetupsView }) {
  return (
    <div className="space-y-2" data-testid="trade-setups">
      <p className={cn('rounded-md border border-amber-500/40 px-3 py-2 text-xs text-amber-400')}>{view.advisory}</p>
      <p className={cn('text-xs', MUTED)}>{sessionLine(view)}</p>
      {view.setups.length === 0 ? (
        <p className={cn(CARD, 'text-sm', MUTED)}>No setups: no news idea had the big-move model's agreement.</p>
      ) : (
        <ul className="space-y-3">
          {view.setups.map((s) => (
            <SetupCard key={s.id} s={s} />
          ))}
        </ul>
      )}
    </div>
  );
}
