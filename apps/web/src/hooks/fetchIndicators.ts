import type { IndicatorReadings } from '@/components/stock-overview/SetupContextCard';

/** A stock with no stored candles waits on the broker: 63 s and 116 s on 2026-11-09, past the client's 30 s default. */
export const INDICATORS_TIMEOUT_MS = 150_000;
const TRIES = 3;
const RETRY_DELAY_MS = 15_000;

type Get = (
  url: string,
  config: { params: Params; timeout: number },
) => Promise<{ data?: { indicators?: IndicatorReadings | null } }>;
interface Params {
  token: string;
  exchange: string;
  timeframe: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Tries again after a failure or an empty answer, because the chart loading beside this card stores the same
 * candles, and the next read then comes from the database. Null when every try came back empty.
 */
export async function fetchIndicators(
  get: Get,
  params: Params,
  cancelled: () => boolean,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<IndicatorReadings | null> {
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const r = await get('/signals/indicators', { params, timeout: INDICATORS_TIMEOUT_MS });
      if (r.data?.indicators) return r.data.indicators;
    } catch {
      // the next try, or null below
    }
    if (cancelled() || attempt === TRIES) break;
    await wait(RETRY_DELAY_MS);
    if (cancelled()) break;
  }
  return null;
}
