/**
 * The ChartinkScoringService factor columns, in fixed display order:
 *   10 scored factors first (ordered by weight, most-predictive leftmost),
 *   then 5 observability factors that are still computed and shown but
 *   contribute 0 points to the score.
 *
 * The /watch table (`WatchTable.tsx`) and the /signals/rejections table
 * (`RejectionsTab.tsx`) both read from this single list so the two views
 * always agree visually. Edit here, not in either page.
 */
export const FACTOR_COLUMNS: ReadonlyArray<{ name: string; short: string }> = [
  // --- Scored factors (10) — ordered by weight, leftmost = most predictive.
  { name: 'MACD on 1m',           short: 'M1m'  },
  { name: 'MACD on 5m',           short: 'M5m'  },
  { name: 'VWAP relationship',    short: 'VWAP' },
  { name: 'ADX trend strength',   short: 'ADX'  },
  { name: 'RSI on 5m',            short: 'RSI'  },
  { name: 'Volume confirmation',  short: 'Vol'  },
  { name: 'ATR target feasibility', short: 'ATR' },
  { name: 'Multi-day breakout',   short: 'MDB'  },
  { name: 'MACD on 1d',           short: 'M1d'  },
  { name: 'EMA9 over EMA20',      short: 'EMA'  },
  // --- Observability factors (5) — still computed, 0 points contribution.
  { name: 'Sector aligned',       short: 'Sect' },
  { name: 'Relative strength',    short: 'RS'   },
  { name: 'Index aligned',        short: 'Idx'  },
  { name: 'SuperTrend match',     short: 'ST'   },
  { name: 'S/R room',             short: 'S/R'  },
];
