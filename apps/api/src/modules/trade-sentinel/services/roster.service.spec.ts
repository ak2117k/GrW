import { RosterService, SENTINEL_MAX_WATCHED } from './roster.service';

const tracker = (
  id: string,
  kind: 'POSITION' | 'HOLDING',
  symbol = id,
  entryTime?: Date,
) => ({
  id,
  kind,
  symbol,
  exchange: 'NSE',
  token: '1',
  entryPrice: 100,
  qty: 10,
  ...(entryTime ? { entryTime } : {}),
});

/** `day`-th of Jan 2026 — a legible entryTime for the ordering tests. */
const at = (day: number) => new Date(Date.UTC(2026, 0, day));

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

  // The watch-slot policy is the roster's own, NOT whatever order listOpen
  // happened to return. Every array below is deliberately shuffled, so these
  // pass only if RosterService sorts for itself.
  describe('watch-slot ordering policy', () => {
    it('gives the slots to the oldest positions when the store order is shuffled', async () => {
      list.mockResolvedValue([
        tracker('p-newest', 'POSITION', 'A', at(9)),
        tracker('p-2nd', 'POSITION', 'B', at(2)),
        tracker('p-oldest', 'POSITION', 'C', at(1)),
        tracker('p-5th', 'POSITION', 'D', at(5)),
        tracker('p-2nd-newest', 'POSITION', 'E', at(7)),
        tracker('p-3rd', 'POSITION', 'F', at(3)),
      ]);
      const roster = await svc.build('u1');

      expect(roster.filter((r) => r.watched).map((r) => r.trackerId)).toEqual([
        'p-oldest',
        'p-2nd',
        'p-3rd',
        'p-5th',
        'p-2nd-newest',
      ]);
      expect(roster.filter((r) => !r.watched).map((r) => r.trackerId)).toEqual([
        'p-newest',
      ]);
    });

    it('applies oldest-first within holdings too, after every position', async () => {
      list.mockResolvedValue([
        tracker('h-newest', 'HOLDING', 'A', at(8)),
        tracker('p-new', 'POSITION', 'B', at(6)),
        tracker('h-oldest', 'HOLDING', 'C', at(2)),
        tracker('h-mid', 'HOLDING', 'D', at(4)),
        tracker('p-old', 'POSITION', 'E', at(1)),
        tracker('h-2nd-newest', 'HOLDING', 'F', at(7)),
      ]);
      const roster = await svc.build('u1');

      // Positions first regardless of age, then holdings oldest-first.
      expect(roster.map((r) => r.trackerId)).toEqual([
        'p-old',
        'p-new',
        'h-oldest',
        'h-mid',
        'h-2nd-newest',
        'h-newest',
      ]);
      expect(roster.filter((r) => !r.watched).map((r) => r.trackerId)).toEqual([
        'h-newest',
      ]);
    });

    it('keeps a younger position ahead of every older holding', async () => {
      // The kind rank must dominate the age tie-break: a position opened today
      // outranks a holding held for a year, because only it is ever closable.
      list.mockResolvedValue([
        tracker('h-ancient', 'HOLDING', 'A', at(1)),
        tracker('p-today', 'POSITION', 'B', at(28)),
      ]);
      const roster = await svc.build('u1');
      expect(roster.map((r) => r.trackerId)).toEqual(['p-today', 'h-ancient']);
    });

    it('preserves store order for same-kind rows with no usable entryTime', async () => {
      list.mockResolvedValue([
        tracker('t3', 'POSITION'),
        tracker('t1', 'POSITION'),
        tracker('t2', 'POSITION'),
      ]);
      const roster = await svc.build('u1');
      expect(roster.map((r) => r.trackerId)).toEqual(['t3', 't1', 't2']);
    });

    it('does not let a dated row jump an undated one within a kind', async () => {
      // Mixed dated/undated is the only case where "compare equal" is
      // observable: any fallback constant would rank the dated row against it
      // and reorder the book on a field that is merely absent.
      // Asserted in BOTH input orders: any fallback constant ranks the dated
      // row consistently against it, so it must reorder one of the two.
      list.mockResolvedValue([
        tracker('undated', 'POSITION', 'A'),
        tracker('dated', 'POSITION', 'B', at(1)),
      ]);
      expect((await svc.build('u1')).map((r) => r.trackerId)).toEqual([
        'undated',
        'dated',
      ]);

      list.mockResolvedValue([
        tracker('dated', 'POSITION', 'B', at(1)),
        tracker('undated', 'POSITION', 'A'),
      ]);
      expect((await svc.build('u1')).map((r) => r.trackerId)).toEqual([
        'dated',
        'undated',
      ]);
    });
  });

  it('returns an empty roster for an empty book', async () => {
    list.mockResolvedValue([]);
    await expect(svc.build('u1')).resolves.toEqual([]);
  });
});
