import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { NightReportStore } from '../repositories/night-report.repository';
import type { TradeSetupsReportSource } from '../../trade-setup/services/trade-setup.service';
import { NightReportService, type MoodSource } from './night-report.service';

const NOW = new Date('2026-10-21T02:30:00Z');
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const store = new Proxy({}, { get: (_t, k) => (k === 'dailyCandles' ? async () => ({ newest: null, countAtDay: 0 }) : async () => (k === 'cashTokens' ? new Map() : k.toString().startsWith('newest') || k === 'lastOvernightReviewAt' ? null : [])) }) as NightReportStore;
const mood: MoodSource = { behaviour: async () => ({ status: 'absent' }) };

describe('NightReportService — tradeSetups section', () => {
  it("asks for the CALLER's setups only (rows are sized on that user's margin)", async () => {
    const forNextSession = jest.fn<ReturnType<TradeSetupsReportSource['forNextSession']>, Parameters<TradeSetupsReportSource['forNextSession']>>(
      async (userId) => ({ sessionDate: '2026-10-21', setups: userId === 'userA' ? ([{ symbol: 'RELIANCE', marginAvailable: 500_000 }] as never) : [], advisory: 'x' }),
    );
    const make = () => new NightReportService(store, mood, { clock, hold: [] }, undefined, undefined, undefined, { forNextSession });
    const b = await make().build('userB', NOW);
    expect(forNextSession).toHaveBeenLastCalledWith('userB', NOW);
    expect(b.tradeSetups).toEqual({ sessionDate: '2026-10-21', setups: [], advisory: 'x' });
    const a = await make().build('userA', NOW);
    expect((a.tradeSetups as { setups: unknown[] }).setups).toHaveLength(1);
  });

  it('fails soft into { error }; null when the module is not loaded', async () => {
    const failing = new NightReportService(store, mood, { clock, hold: [] }, undefined, undefined, undefined, {
      forNextSession: async () => {
        throw new Error('relation "trade_setups" does not exist');
      },
    });
    expect((await failing.build('u1', NOW)).tradeSetups).toEqual({ error: 'relation "trade_setups" does not exist' });
    expect((await new NightReportService(store, mood, { clock, hold: [] }).build('u1', NOW)).tradeSetups).toBeNull();
  });
});
