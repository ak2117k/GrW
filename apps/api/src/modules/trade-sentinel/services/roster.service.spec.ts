import { RosterService, SENTINEL_MAX_WATCHED } from './roster.service';

const tracker = (id: string, kind: 'POSITION' | 'HOLDING', symbol = id) => ({
  id,
  kind,
  symbol,
  exchange: 'NSE',
  token: '1',
  entryPrice: 100,
  qty: 10,
});

describe('RosterService', () => {
  const list = jest.fn();
  const trackerService = { listOpen: list } as any;
  const ownedElsewhere = jest.fn().mockResolvedValue(new Set<string>());
  const svc = new RosterService(trackerService, {
    symbolsOwnedByOtherEngines: ownedElsewhere,
  } as any);

  beforeEach(() => {
    jest.clearAllMocks();
    ownedElsewhere.mockResolvedValue(new Set<string>());
  });

  it('caps watched entries at the configured maximum', async () => {
    list.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => tracker(`t${i}`, 'POSITION')),
    );
    const roster = await svc.build('u1');
    expect(roster.filter((r) => r.watched)).toHaveLength(SENTINEL_MAX_WATCHED);
  });

  it('lists the overflow explicitly rather than dropping it', async () => {
    list.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => tracker(`t${i}`, 'POSITION')),
    );
    const roster = await svc.build('u1');
    expect(roster).toHaveLength(8);
    const unwatched = roster.filter((r) => !r.watched);
    expect(unwatched).toHaveLength(3);
    expect(unwatched[0].reason).toMatch(/over capacity/i);
  });

  it('gives holdings observe-only ownership and never close authority', async () => {
    list.mockResolvedValue([tracker('h1', 'HOLDING')]);
    const roster = await svc.build('u1');
    expect(roster[0].ownership).toBe('OBSERVE_ONLY');
  });

  it('marks a position already managed by another engine as observe-only', async () => {
    list.mockResolvedValue([tracker('t1', 'POSITION', 'NIFTY24800CE')]);
    ownedElsewhere.mockResolvedValue(new Set(['NIFTY24800CE']));
    const roster = await svc.build('u1');
    expect(roster[0].ownership).toBe('OBSERVE_ONLY');
    expect(roster[0].reason).toMatch(/another engine/i);
  });

  it('claims an unowned position as the sentinel’s own', async () => {
    list.mockResolvedValue([tracker('t1', 'POSITION')]);
    ownedElsewhere.mockResolvedValue(new Set());
    const roster = await svc.build('u1');
    expect(roster[0].ownership).toBe('SENTINEL');
  });

  it('scopes both the tracker list and the ownership probe to the caller', async () => {
    list.mockResolvedValue([tracker('t1', 'POSITION')]);
    await svc.build('u42');
    expect(list).toHaveBeenCalledWith('u42');
    expect(ownedElsewhere).toHaveBeenCalledWith('u42');
  });

  it('carries the tracker id, symbol and kind onto the roster entry', async () => {
    list.mockResolvedValue([tracker('trk-9', 'HOLDING', 'RELIANCE')]);
    const roster = await svc.build('u1');
    expect(roster[0]).toMatchObject({
      trackerId: 'trk-9',
      symbol: 'RELIANCE',
      kind: 'HOLDING',
      watched: true,
    });
  });

  it('gives positions first claim on the watch slots ahead of holdings', async () => {
    // Holdings come FIRST out of the tracker store, so a roster that did not
    // reorder would spend three of the five slots on instruments that can never
    // gain close authority and leave two live positions unwatched.
    list.mockResolvedValue([
      tracker('h1', 'HOLDING'),
      tracker('h2', 'HOLDING'),
      tracker('h3', 'HOLDING'),
      tracker('p1', 'POSITION'),
      tracker('p2', 'POSITION'),
      tracker('p3', 'POSITION'),
      tracker('p4', 'POSITION'),
    ]);
    const roster = await svc.build('u1');

    const watched = roster.filter((r) => r.watched).map((r) => r.trackerId);
    expect(watched).toHaveLength(SENTINEL_MAX_WATCHED);
    expect(watched).toEqual(expect.arrayContaining(['p1', 'p2', 'p3', 'p4']));
    expect(roster.filter((r) => !r.watched).map((r) => r.trackerId)).toEqual([
      'h2',
      'h3',
    ]);
  });

  it('keeps the overflow entry’s ownership label, not just its unwatched flag', async () => {
    list.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => tracker(`t${i}`, 'POSITION')),
    );
    const roster = await svc.build('u1');
    const overflow = roster.find((r) => !r.watched)!;
    expect(overflow.ownership).toBe('SENTINEL');
  });

  it('reports over-capacity holdings as unwatched observe-only, not dropped', async () => {
    list.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => tracker(`h${i}`, 'HOLDING')),
    );
    const roster = await svc.build('u1');
    expect(roster).toHaveLength(7);
    const unwatched = roster.filter((r) => !r.watched);
    expect(unwatched).toHaveLength(2);
    for (const entry of unwatched) {
      expect(entry.ownership).toBe('OBSERVE_ONLY');
      expect(entry.reason).toMatch(/over capacity/i);
    }
  });

  it('reports an over-capacity other-engine position as unwatched observe-only', async () => {
    list.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => tracker(`t${i}`, 'POSITION', `S${i}`)),
    );
    ownedElsewhere.mockResolvedValue(
      new Set(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']),
    );
    const roster = await svc.build('u1');
    expect(roster.every((r) => r.ownership === 'OBSERVE_ONLY')).toBe(true);
    const unwatched = roster.filter((r) => !r.watched);
    expect(unwatched).toHaveLength(1);
    expect(unwatched[0].reason).toMatch(/over capacity/i);
  });

  it('separates the owned from the unowned within one book', async () => {
    list.mockResolvedValue([
      tracker('t1', 'POSITION', 'MINE'),
      tracker('t2', 'POSITION', 'THEIRS'),
    ]);
    ownedElsewhere.mockResolvedValue(new Set(['THEIRS']));
    const roster = await svc.build('u1');
    expect(roster.find((r) => r.symbol === 'MINE')!.ownership).toBe('SENTINEL');
    expect(roster.find((r) => r.symbol === 'THEIRS')!.ownership).toBe(
      'OBSERVE_ONLY',
    );
  });

  it('returns an empty roster for an empty book', async () => {
    list.mockResolvedValue([]);
    await expect(svc.build('u1')).resolves.toEqual([]);
  });
});
