/**
 * Prod candles_1m, BANKNIFTY index (NSE 99926009), 2026-11-23 08:50–09:29 IST (source 'tick'), verbatim. The NSE
 * pre-open: flat copies 08:50–08:59, the auction 09:00 bar (O 64635 H 64912 L 63796 C 64861, a 1,100-pt range that
 * never traded), indicative prints 09:01–09:08 up to 65,489, flat 09:09–09:14; real trading from 09:15.
 * Plus a deterministic synthetic history (session bars around 64,500 and flat off-hours copies, as the hub writes
 * them) for the sessions before it. Test-only.
 */
export type M1 = { ts: number; open: number; high: number; low: number; close: number; volume: number };

export const BANKNIFTY_REF = { exchange: 'NSE', token: '99926009', symbol: 'Nifty Bank' } as const;

const MIN = 60_000;
const IST_MS = 330 * MIN;
/** Epoch ms of an IST wall-clock "YYYY-MM-DD HH:MM". */
export const ist = (s: string): number => Date.parse(`${s.replace(' ', 'T')}:00Z`) - IST_MS;

const RAW_23NOV: Array<[string, number, number, number, number]> = [
  ['08:50', 64635.2, 64635.2, 64635.2, 64635.2], ['08:51', 64635.2, 64635.2, 64635.2, 64635.2],
  ['08:52', 64635.2, 64635.2, 64635.2, 64635.2], ['08:53', 64635.2, 64635.2, 64635.2, 64635.2],
  ['08:54', 64635.2, 64635.2, 64635.2, 64635.2], ['08:55', 64635.2, 64635.2, 64635.2, 64635.2],
  ['08:56', 64635.2, 64635.2, 64635.2, 64635.2], ['08:57', 64635.2, 64635.2, 64635.2, 64635.2],
  ['08:58', 64635.2, 64635.2, 64635.2, 64635.2], ['08:59', 64635.2, 64635.2, 64635.2, 64635.2],
  ['09:00', 64635.2, 64911.55, 63795.7, 64861.05], ['09:01', 64861.5, 65026.15, 64852.65, 65022.2],
  ['09:02', 65045.15, 65489.4, 65045.15, 65484.4], ['09:03', 65479.4, 65489.6, 65136, 65139],
  ['09:04', 65124.65, 65146.6, 65064.1, 65123.75], ['09:05', 65125.45, 65132.85, 65092.8, 65092.8],
  ['09:06', 65095.65, 65101.1, 65057.6, 65063.45], ['09:07', 65063.45, 65072.25, 65033.15, 65061.55],
  ['09:08', 65046.25, 65046.25, 65008.2, 65012.05], ['09:09', 65012.05, 65012.05, 65012.05, 65012.05],
  ['09:10', 65012.05, 65012.05, 65012.05, 65012.05], ['09:11', 65012.05, 65012.05, 65012.05, 65012.05],
  ['09:12', 65012.05, 65012.05, 65012.05, 65012.05], ['09:13', 65012.05, 65012.05, 65012.05, 65012.05],
  ['09:14', 65012.05, 65012.05, 65012.05, 65012.05], ['09:15', 65003.7, 65182.45, 64862, 65118.6],
  ['09:16', 65114.85, 65124.25, 64760.45, 64781.1], ['09:17', 64788.1, 64798, 64577.15, 64663.4],
  ['09:18', 64657.4, 64659.45, 64477.6, 64477.6], ['09:19', 64481.45, 64522.85, 64392.6, 64498.3],
  ['09:20', 64504.1, 64504.1, 64349.85, 64352.85], ['09:21', 64347.75, 64352.85, 64194.15, 64197.55],
  ['09:22', 64201.4, 64317.9, 64176.55, 64317.9], ['09:23', 64313.4, 64324.3, 64192.45, 64198.55],
  ['09:24', 64199.85, 64199.85, 64034.95, 64034.95], ['09:25', 64045.25, 64045.25, 63742.95, 63852.8],
  ['09:26', 63852.4, 63907.75, 63743.4, 63768.15], ['09:27', 63768.15, 63877.65, 63690.95, 63850.3],
  ['09:28', 63855.25, 63874.4, 63691.95, 63693.25], ['09:29', 63693.25, 63712.75, 63662.1, 63696.55],
];

export const BANKNIFTY_23NOV_1M: M1[] = RAW_23NOV.map(([t, o, h, l, c]) => ({ ts: ist(`2026-11-23 ${t}`), open: o, high: h, low: l, close: c, volume: 0 }));

/**
 * Synthetic prior sessions (IST days): every session minute 09:15–15:29 a gentle wave around `base`, plus flat
 * copies of the last close at 02:00 and every minute 15:30–16:10 (the hub's off-hours bars).
 */
export function syntheticHistory(days: readonly string[], base = 64_500): M1[] {
  const out: M1[] = [];
  let k = 0;
  for (const d of days) {
    let last = base;
    out.push({ ts: ist(`${d} 02:00`), open: last, high: last, low: last, close: last, volume: 0 });
    for (let m = 555; m < 930; m++, k++) {
      const c = Math.round((base + 120 * Math.sin(k / 37) + 40 * Math.sin(k / 5)) * 100) / 100;
      const o = last;
      out.push({ ts: ist(`${d} 00:00`) + m * MIN, open: o, high: Math.max(o, c) + 6, low: Math.min(o, c) - 6, close: c, volume: 100 });
      last = c;
    }
    for (let m = 930; m <= 970; m++) out.push({ ts: ist(`${d} 00:00`) + m * MIN, open: last, high: last, low: last, close: last, volume: 0 });
  }
  return out;
}

/** The five sessions before 2026-11-23 (Mon): 16–20 Nov. */
export const PRIOR_DAYS = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'] as const;
