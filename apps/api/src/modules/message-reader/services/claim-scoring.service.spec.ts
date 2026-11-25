import { Logger } from '@nestjs/common';
import type { DailyBar } from '../../signal-intake/domain/info-outcome';
import type { IntradayBar } from '../domain/claim-outcome';
import type { Claim } from '../domain/reading.types';
import type { UnscoredReading } from '../repositories/message-reader.repository';
import { ClaimScoringService } from './claim-scoring.service';

const NOW = new Date('2026-11-25T13:00:00Z'); // Wed 18:30 IST
const AT_1525 = new Date('2026-11-25T09:55:00Z');

/** 29 flat sessions (range 100, close 26000) then 2026-11-25 closing at `close`. */
function daily(close: number): DailyBar[] {
  const out: DailyBar[] = [];
  const start = new Date('2026-10-15T00:00:00Z');
  for (let i = 0; out.length < 29; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    out.push({ day: d.toISOString().slice(0, 10), high: 26050, low: 25950, close: 26000 });
  }
  out.push({ day: '2026-11-25', high: 26150, low: 25990, close });
  return out;
}

/** 2026-11-25 NIFTY 15m bars from 09:15 IST, close 26000 then rising 4 per bar. */
const m15: IntradayBar[] = Array.from({ length: 25 }, (_, i) => {
  const close = 26000 + i * 4;
  return { ts: Date.parse('2026-11-25T03:45:00Z') + i * 900_000, open: close, high: close + 5, low: close - 5, close };
});

const claim = (c: Partial<Claim>): Claim => ({
  text: 'x', subject: 'MARKET', bias: 'BULL', horizon: 'INTRADAY', verdict: 'NOT_CHECKABLE', evidence: [], claimType: 'DIRECTION', ...c,
});

const row = (r: Partial<UnscoredReading>): UnscoredReading => ({
  messageId: 'm1',
  channelId: 'c1',
  postedAt: new Date('2026-11-25T04:50:00Z'), // 10:20 IST
  sessionDate: '2026-11-25',
  kind: 'INFO',
  scope: 'MARKET',
  claims: [],
  closeBreadth: null,
  ...r,
});

type Opts = { rows?: UnscoredReading[]; niftyClose?: number; owner?: string | null; breadth?: { adRatio: number; total: number }; noIntraday?: boolean };

function make(o: Opts = {}) {
  const repo = {
    unscored: jest.fn(async () => o.rows ?? []),
    fillOutcome: jest.fn(async () => undefined),
    storeCloseBreadth: jest.fn(async () => 4),
  };
  const bars = {
    daily: jest.fn(async (_ex: string, token: string) => (token === '99926000' ? daily(o.niftyClose ?? 26100) : token === '99926009' ? daily(25900) : [])),
    ...(o.noIntraday ? {} : { intraday15m: jest.fn(async () => m15) }),
  };
  const breadth = { getBreadth: jest.fn(async () => ({ advances: 0, declines: 0, unchanged: 0, ...(o.breadth ?? { adRatio: 0.8, total: 50 }) })) };
  const svc = new ClaimScoringService(repo, bars, breadth, { ownerUserId: o.owner === undefined ? 'owner-1' : o.owner });
  return { svc, repo, bars, breadth };
}

describe('ClaimScoringService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('storeCloseBreadth (15:25 IST)', () => {
    it("stores the owner's A/D ratio on today's unscored rows", async () => {
      const m = make();
      await expect(m.svc.storeCloseBreadth(AT_1525)).resolves.toBe(0.8);
      expect(m.breadth.getBreadth).toHaveBeenCalledWith('owner-1');
      expect(m.repo.storeCloseBreadth).toHaveBeenCalledWith('2026-11-25', 0.8, AT_1525);
    });

    it('stores nothing when no quote priced (an outage is not a flat market)', async () => {
      const m = make({ breadth: { adRatio: 0, total: 0 } });
      await expect(m.svc.storeCloseBreadth(AT_1525)).resolves.toBeNull();
      expect(m.repo.storeCloseBreadth).not.toHaveBeenCalled();
    });

    it('stores nothing without an owner session', async () => {
      const m = make({ owner: null });
      await expect(m.svc.storeCloseBreadth(AT_1525)).resolves.toBeNull();
      expect(m.breadth.getBreadth).not.toHaveBeenCalled();
    });
  });

  describe('scoreNight (18:30 IST)', () => {
    it('scores every claim of a finished session and fills outcomes', async () => {
      const claims = [
        claim({ claimType: 'RELATIVE_BREADTH', text: 'index strong, stocks weak', bias: 'NEUTRAL' }),
        claim({ claimType: 'DIRECTION', subject: 'MARKET', bias: 'BULL' }),
        claim({ claimType: 'FLOW', subject: 'MARKET' }),
      ];
      const m = make({ rows: [row({ claims, closeBreadth: { session: '2026-11-25', adAtClose: 0.8 } })] });
      await expect(m.svc.scoreNight(NOW)).resolves.toEqual({ filled: 1, pending: 0 });
      expect(m.repo.unscored).toHaveBeenCalledWith(new Date(NOW.getTime() - 20 * 86_400_000));
      const [id, outcomes, at] = m.repo.fillOutcome.mock.calls[0] as unknown as [string, Array<Record<string, unknown>>, Date];
      expect(id).toBe('m1');
      expect(at).toBe(NOW);
      expect(outcomes.map((x) => x.status)).toEqual(['RIGHT', 'RIGHT', 'NOT_SCORED']);
      expect(outcomes[0]).toMatchObject({ claimType: 'RELATIVE_BREADTH', subject: 'MARKET', session: '2026-11-25', why: expect.stringContaining('A/D 0.8') });
    });

    it("takes the session's 15:25 A/D from a sibling row when this row has none (posted after 15:25)", async () => {
      const rb = [claim({ claimType: 'RELATIVE_BREADTH' })];
      const m = make({
        rows: [
          row({ messageId: 'a', closeBreadth: { session: '2026-11-25', adAtClose: 0.8 } }),
          row({ messageId: 'b', postedAt: new Date('2026-11-25T09:57:00Z'), claims: rb }),
        ],
      });
      await m.svc.scoreNight(NOW);
      const b = m.repo.fillOutcome.mock.calls.find((c) => (c as unknown[])[0] === 'b') as unknown as [string, Array<{ status: string }>];
      expect(b[1][0].status).toBe('RIGHT'); // 15:27 post: NIFTY 26092 → 26100, A/D 0.8 from row a (without it: NOT_SCORED)
    });

    it('leaves a row posted after the close for the next session', async () => {
      const m = make({ rows: [row({ postedAt: new Date('2026-11-25T11:00:00Z'), claims: [claim({})] })] });
      await expect(m.svc.scoreNight(NOW)).resolves.toEqual({ filled: 0, pending: 1 });
      expect(m.repo.fillOutcome).not.toHaveBeenCalled();
    });

    it('waits for a DAYS horizon', async () => {
      const m = make({ rows: [row({ claims: [claim({ horizon: 'DAYS' })] })] });
      await expect(m.svc.scoreNight(NOW)).resolves.toEqual({ filled: 0, pending: 1 });
      expect(m.repo.fillOutcome).not.toHaveBeenCalled();
    });

    it('a subject that resolves to no instrument is NOT_SCORED at once', async () => {
      const m = make({ rows: [row({ scope: 'INSTRUMENT', claims: [claim({ subject: 'NOSUCH', horizon: 'WEEKS' })] })] });
      await expect(m.svc.scoreNight(NOW)).resolves.toEqual({ filled: 1, pending: 0 });
      const outs = (m.repo.fillOutcome.mock.calls[0] as unknown as [string, Array<{ status: string; why: string }>])[1];
      expect(outs[0]).toMatchObject({ status: 'NOT_SCORED', why: expect.stringContaining('NOSUCH') });
    });

    it('a pending claim older than 12 days is filled NOT_SCORED', async () => {
      const old = row({ postedAt: new Date('2026-11-12T04:50:00Z'), sessionDate: '2026-11-12', claims: [claim({ horizon: 'WEEKS' })] });
      const m = make({ rows: [old], niftyClose: 26000 });
      // drop the bars after 11-13 so the 5-session horizon is never reached
      m.bars.daily.mockImplementation(async () => daily(26000).filter((b) => b.day <= '2026-11-13'));
      await expect(m.svc.scoreNight(NOW)).resolves.toEqual({ filled: 1, pending: 0 });
      const outs = (m.repo.fillOutcome.mock.calls[0] as unknown as [string, Array<{ status: string; why: string }>])[1];
      expect(outs[0]).toMatchObject({ status: 'NOT_SCORED', why: expect.stringContaining('pending') });
    });

    it('judges an index subject on its own daily bars', async () => {
      const m = make({ rows: [row({ scope: 'INSTRUMENT', claims: [claim({ subject: 'BANKNIFTY', bias: 'BEAR' })] })] });
      await m.svc.scoreNight(NOW);
      expect(m.bars.daily).toHaveBeenCalledWith('NSE', '99926009', expect.any(Date), NOW);
      const outs = (m.repo.fillOutcome.mock.calls[0] as unknown as [string, Array<{ status: string }>])[1];
      expect(outs[0].status).toBe('RIGHT');
    });

    it('a sector claim reads the sector index', async () => {
      const m = make({ rows: [row({ scope: 'SECTOR', claims: [claim({ claimType: 'SECTOR', subject: 'IT' })] })] });
      await m.svc.scoreNight(NOW);
      expect(m.bars.daily).toHaveBeenCalledWith('NSE', '99926013', expect.any(Date), NOW);
    });

    it('without a 15m source the post-time rules are NOT_SCORED, never guessed', async () => {
      const m = make({ noIntraday: true, rows: [row({ claims: [claim({ claimType: 'RELATIVE_BREADTH' })], closeBreadth: { session: '2026-11-25', adAtClose: 0.8 } })] });
      await m.svc.scoreNight(NOW);
      const outs = (m.repo.fillOutcome.mock.calls[0] as unknown as [string, Array<{ status: string }>])[1];
      expect(outs[0].status).toBe('NOT_SCORED');
    });

    it('a row with no claims is filled with an empty list', async () => {
      const m = make({ rows: [row({ kind: 'NOISE' })] });
      await m.svc.scoreNight(NOW);
      expect(m.repo.fillOutcome).toHaveBeenCalledWith('m1', [], NOW);
    });

    it('nothing to score: no bar fetch', async () => {
      const m = make({ rows: [] });
      await expect(m.svc.scoreNight(NOW)).resolves.toEqual({ filled: 0, pending: 0 });
      expect(m.bars.daily).not.toHaveBeenCalled();
    });
  });
});
