import { buildVocabulary } from '../domain/vocabulary';
import { SignalWatchService } from './signal-watch.service';

const NOW = new Date('2026-10-27T07:00:00Z'); // Tue 12:30 IST, NSE open
const vocab = buildVocabulary(['RADICO-EQ']);

function make(opts: { ltp?: number | null; open?: boolean; watches?: any[] } = {}) {
  const watches: any[] = opts.watches ?? [];
  const repo = {
    infosWithoutWatches: jest.fn(async () => [
      { messageId: 'm1', channelId: 'c1', postedAt: new Date('2026-10-27T06:22:00Z'), items: [{ underlying: 'RADICO', bias: 'BULL', levels: [4330], kind: 'WATCH' }, { underlying: 'RADICO', bias: 'BULL', levels: [4300], kind: 'VIEW' }] },
    ]),
    createWatches: jest.fn(async (rows: any[]) => {
      rows.forEach((r, i) => watches.push({ id: `w${i}`, ...r }));
      return rows.length;
    }),
    activeWatches: jest.fn(async () => watches.filter((w) => w.status === 'ACTIVE')),
    updateWatch: jest.fn(async (id: string, data: any) => Object.assign(watches.find((w) => w.id === id), data)),
    postText: jest.fn(async () => 'Radico breakout above 4330'),
    createSignal: jest.fn(async () => 'sig1'),
  };
  const clock = {
    isOpen: () => opts.open ?? true,
    nextOpen: (_ex: string, at: Date) => new Date(at.getTime() + 24 * 3_600_000),
    tradingWindow: () => ({ openMin: 555, closeMin: 930 }),
  };
  const instruments = { getInstrumentBySymbol: jest.fn(async () => ({ token: '2937', exchange: 'NSE' })), getNearestFuture: jest.fn(async () => null) };
  const feeds = { fetchQuote: jest.fn(async () => (opts.ltp === undefined || opts.ltp === null ? null : { ltp: opts.ltp })) };
  const emitter = { emit: jest.fn() };
  const svc = new SignalWatchService(repo as any, { get: async () => vocab }, clock, instruments as any, feeds as any, emitter);
  return { svc, repo, feeds, emitter, watches };
}

describe('SignalWatchService', () => {
  const env = process.env.HUB_OWNER_USER_ID;
  beforeAll(() => (process.env.HUB_OWNER_USER_ID = 'owner'));
  afterAll(() => (process.env.HUB_OWNER_USER_ID = env));

  it('a WATCH item becomes one ACTIVE watch on the stock\'s cash line (a VIEW item does not)', async () => {
    const t = make();
    expect(await t.svc.sync(NOW)).toBe(1);
    expect(t.watches).toEqual([expect.objectContaining({ underlying: 'RADICO', instrumentKind: 'EQ', side: 'BUY', level: 4330, token: '2937', exchange: 'NSE', status: 'ACTIVE' })]);
  });

  it('below the level: remembered, nothing fired', async () => {
    const t = make({ ltp: 4310 });
    await t.svc.sync(NOW);
    expect(await t.svc.poll(NOW)).toEqual({ checked: 1, fired: 0, expired: 0 });
    expect(t.watches[0]).toMatchObject({ status: 'ACTIVE', lastLtp: 4310 });
    expect(t.emitter.emit).not.toHaveBeenCalled();
  });

  it('crossed: a signal is created, the watch is FIRED and signal.ready goes to the trader', async () => {
    const t = make({ ltp: 4336 });
    await t.svc.sync(NOW);
    expect(await t.svc.poll(NOW)).toEqual({ checked: 1, fired: 1, expired: 0 });
    expect(t.repo.createSignal).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1:watch:0', underlying: 'RADICO', entryType: 'ABOVE', entryLow: 4330, tags: ['WATCH'] }));
    expect(t.watches[0]).toMatchObject({ status: 'FIRED', signalId: 'sig1', lastLtp: 4336 });
    expect(t.emitter.emit).toHaveBeenCalledWith('signal.ready', { signalId: 'sig1', clusterId: null, agreeCount: 1, conflict: false });
  });

  it('market closed: not quoted; past its expiry: EXPIRED', async () => {
    const closed = make({ ltp: 4336, open: false });
    await closed.svc.sync(NOW);
    expect((await closed.svc.poll(NOW)).checked).toBe(0);
    expect(closed.feeds.fetchQuote).not.toHaveBeenCalled();
    const late = make({ watches: [{ id: 'old', status: 'ACTIVE', expiresAt: new Date('2026-10-27T06:00:00Z'), lastLtp: 4300, underlying: 'RADICO' }] });
    expect(await late.svc.poll(NOW)).toEqual({ checked: 0, fired: 0, expired: 1 });
    expect(late.watches[0].status).toBe('EXPIRED');
  });
});
