// apps/api/src/modules/mbm/mbm-universe.ts
// The broker 1m series each MBM instrument's features need (plan §4; series ids = the M0 store's,
// ai-engine/src/mbm/universe.py). Global daily cues (Yahoo) are fetched by the MBM service itself.
//
// Tokens are the contract's list. NOT verified against a live `instruments` table here (the local DB
// was unreachable); they match packages/shared MAJOR_STOCKS for RELIANCE/TCS/HDFCBANK/INFY/ICICIBANK and
// the M0 scrip-master fixture for India VIX (99926017). NOTE: packages/shared SECTOR_INDICES labels
// 99926017 as NIFTY PHARMA — one of the two is wrong; a wrong token here shows up as an INDIAVIX
// series whose closes are ~20k instead of ~10-30. Check once against the Angel scrip master.

export interface MbmSeries {
  /** Store series id (mbm_bars_1m.series). */
  series: string;
  token: string;
  exchange: string;
}

export const MBM_UNIVERSE: Readonly<Record<string, readonly MbmSeries[]>> = {
  NIFTY: [
    { series: 'NIFTY', token: '99926000', exchange: 'NSE' },
    { series: 'BANKNIFTY', token: '99926009', exchange: 'NSE' },
    { series: 'INDIAVIX', token: '99926017', exchange: 'NSE' },
    { series: 'EQ_RELIANCE', token: '2885', exchange: 'NSE' },
    { series: 'EQ_HDFCBANK', token: '1333', exchange: 'NSE' },
    { series: 'EQ_ICICIBANK', token: '4963', exchange: 'NSE' },
    { series: 'EQ_INFY', token: '1594', exchange: 'NSE' },
    { series: 'EQ_TCS', token: '11536', exchange: 'NSE' },
    { series: 'EQ_BHARTIARTL', token: '10604', exchange: 'NSE' },
    { series: 'EQ_LT', token: '11483', exchange: 'NSE' },
    { series: 'EQ_ITC', token: '1660', exchange: 'NSE' },
  ],
};

/** De-duplicated series for the configured instruments; unknown instruments are reported, not fatal. */
export function universeFor(instruments: readonly string[]): { series: MbmSeries[]; unknown: string[] } {
  const seen = new Set<string>();
  const series: MbmSeries[] = [];
  const unknown: string[] = [];
  for (const inst of instruments) {
    const list = MBM_UNIVERSE[inst];
    if (!list) {
      unknown.push(inst);
      continue;
    }
    for (const s of list) {
      if (seen.has(s.series)) continue;
      seen.add(s.series);
      series.push(s);
    }
  }
  return { series, unknown };
}
