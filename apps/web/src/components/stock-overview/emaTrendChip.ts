type Alignment = 1 | 0 | -1;

/** The EMA20/80 chip: green when EMA20 is above EMA80 and MACD is green, red for the opposite, otherwise mixed. */
export function emaTrendChip(ind: { ema20?: number | null; ema80?: number | null; trend?: Alignment | null }): { value: string; alignment: Alignment } {
  if (ind.ema20 == null || ind.ema80 == null || ind.trend == null) return { value: '—', alignment: 0 };
  const arrow = ind.ema20 > ind.ema80 ? '↑' : '↓';
  const word = ind.trend === 1 ? 'green' : ind.trend === -1 ? 'red' : 'mixed';
  return { value: `${arrow} ${word}`, alignment: ind.trend };
}

/** The MACD chip: the Heikin Ashi histogram, as on the owner's charts. Green above zero, red below. */
export function macdChip(ind: { trendMacdHistogram?: number | null; macdHistogram?: number | null }): { value: string; alignment: Alignment } {
  const h = ind.trendMacdHistogram ?? ind.macdHistogram;
  if (h == null) return { value: '—', alignment: 0 };
  return { value: `${h >= 0 ? '+' : ''}${h.toFixed(2)}`, alignment: h > 0 ? 1 : h < 0 ? -1 : 0 };
}
