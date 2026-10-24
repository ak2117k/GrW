import { useStrategyBuilderStore } from '@/stores/strategy-builder-store';
import type { FillAt, StopKind, StrategySettings } from './strategyAi';

const input =
  'w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none';
const label = 'text-[10px] text-gray-500 mb-1 block';

const toNum = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Stop, target, sizing, session and fill timing — the fields the checks and the AI work with. */
export function StrategyRiskSettings() {
  const settings = useStrategyBuilderStore((s) => s.settings);
  const setSetting = useStrategyBuilderStore((s) => s.setSetting);

  const numField = (key: keyof StrategySettings, text: string, placeholder: string, step = 'any') => (
    <div>
      <label className={label}>{text}</label>
      <input
        type="number"
        step={step}
        value={(settings[key] as number | null) ?? ''}
        placeholder={placeholder}
        onChange={(e) => setSetting(key, toNum(e.target.value) as never)}
        className={input}
      />
    </div>
  );

  const kindField = (key: 'stopLossKind' | 'targetKind') => (
    <select
      value={settings[key] ?? ''}
      onChange={(e) => setSetting(key, (e.target.value || null) as StopKind | null)}
      className={input}
    >
      <option value="">unit…</option>
      <option value="ATR">× ATR</option>
      <option value="PERCENT">%</option>
      <option value="POINTS">points</option>
    </select>
  );

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Risk &amp; execution</h3>
      <div className="space-y-3">
        <div>
          <label className={label}>Stop-loss</label>
          <div className="grid grid-cols-2 gap-2">
            {kindField('stopLossKind')}
            <input
              type="number"
              step="any"
              value={settings.stopLossValue ?? ''}
              placeholder="e.g. 1.5"
              onChange={(e) => setSetting('stopLossValue', toNum(e.target.value))}
              className={input}
            />
          </div>
        </div>
        <div>
          <label className={label}>Target</label>
          <div className="grid grid-cols-2 gap-2">
            {kindField('targetKind')}
            <input
              type="number"
              step="any"
              value={settings.targetValue ?? ''}
              placeholder="e.g. 3"
              onChange={(e) => setSetting('targetValue', toNum(e.target.value))}
              className={input}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {numField('riskPerTradeRupees', 'Risk / trade (₹)', '1000')}
          {numField('capitalPerTradeRupees', 'Capital / trade (₹)', '10000')}
          {numField('maxOpenPositions', 'Max open positions', '2', '1')}
          {numField('maxTradesPerDay', 'Max trades / day', '3', '1')}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label}>Session start</label>
            <input type="time" value={settings.sessionStart ?? ''} onChange={(e) => setSetting('sessionStart', e.target.value || null)} className={input} />
          </div>
          <div>
            <label className={label}>Session end</label>
            <input type="time" value={settings.sessionEnd ?? ''} onChange={(e) => setSetting('sessionEnd', e.target.value || null)} className={input} />
          </div>
        </div>
        <div>
          <label className={label}>Entry fill</label>
          <select value={settings.fillAt ?? ''} onChange={(e) => setSetting('fillAt', (e.target.value || null) as FillAt | null)} className={input}>
            <option value="">next bar open (default)</option>
            <option value="next_open">next bar open</option>
            <option value="signal_close">signal bar close</option>
            <option value="same_bar_open">signal bar open (look-ahead!)</option>
          </select>
        </div>
      </div>
    </div>
  );
}
