/** Simple (unsmoothed) ATR(14) over daily bars (oldest first); null with fewer than 2 bars. Pure. */
export function atr14(bars: ReadonlyArray<{ high: number; low: number; close: number }>, n = 14): number | null {
  const ok = bars.filter((b) => [b.high, b.low, b.close].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0));
  if (ok.length < 2) return null;
  const tr: number[] = [];
  for (let k = 1; k < ok.length; k++) {
    const b = ok[k];
    const pc = ok[k - 1].close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  const last = tr.slice(-n);
  const v = last.reduce((a, x) => a + x, 0) / last.length;
  return v > 0 ? Math.round(v * 100) / 100 : null;
}
