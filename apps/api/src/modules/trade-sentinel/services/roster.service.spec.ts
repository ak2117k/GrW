import { RosterService, SENTINEL_MAX_WATCHED } from './roster.service';
import { segmentFor } from '../charges';

/**
 * DEFAULTS TO A DERIVATIVE, because F&O is the roster's first-ranked group and a
 * cash fixture would drag the equity ranking rule into tests not about it. `NFO` with an
 * unparsed suffix classifies as OPT (the conservative read in `segmentFor`),
 * which is what these tests want: a watchable contract whose SYMBOL is then free
 * to exercise the ownership-normalisation rules without also having to be a
 * plausible tradingsymbol.
 *
 * `exchange` is passed explicitly by the tests that care about scope.
 */
const tracker = (
  id: string,
  kind: 'POSITION' | 'HOLDING',
  symbol = id,
  entryTime?: Date,
  exchange = 'NFO',
) => ({
  id,
  kind,
  symbol,
  exchange,
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

  it('leaves holdings out of the roster entirely — not observed, not listed', async () => {
    // THE POLICY THIS ENFORCES. A real book is a handful of positions and
    // DOZENS of holdings, and once the cap binds, holdings would fill the five
    // watch slots with long-term equity while the option positions opened that
    // morning went unwatched. Spending the cap on the wrong five is worse than
    // spending it on none.
    list.mockResolvedValue([tracker('h1', 'HOLDING'), tracker('t1', 'POSITION')]);
    const roster = await svc.build('u1');
    expect(roster.map((r) => r.trackerId)).toEqual(['t1']);
  });

  it('never lets a holding take a watch slot from a position', async () => {
    // Holdings come FIRST out of the tracker store, and there are more of them
    // than the cap. A roster that merely REORDERED would still be correct here;
    // one that counted them at all would not.
    list.mockResolvedValue([
      ...Array.from({ length: 20 }, (_, i) => tracker(`h${i}`, 'HOLDING')),
      tracker('p1', 'POSITION'),
      tracker('p2', 'POSITION'),
    ]);
    const roster = await svc.build('u1');

    expect(roster.filter((r) => r.watched).map((r) => r.trackerId)).toEqual(['p1', 'p2']);
    // And nothing is reported as unwatched: 2 positions is under the cap, so
    // the over-capacity path must not fire on an ordinary book.
    expect(roster.filter((r) => !r.watched)).toHaveLength(0);
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
    list.mockResolvedValue([tracker('trk-9', 'POSITION', 'RELIANCE')]);
    const roster = await svc.build('u1');
    expect(roster[0]).toMatchObject({
      trackerId: 'trk-9',
      symbol: 'RELIANCE',
      kind: 'POSITION',
      watched: true,
    });
  });

  it('stamps the tenant on every entry, whatever branch built it', async () => {
    // All three construction branches, in one assertion. Everything downstream
    // of the roster is tenant-scoped, so an entry that reaches ThesisService
    // without a userId writes a row nobody owns — and the branch that forgets
    // it would be the one nothing else covers.
    list.mockResolvedValue([
      tracker('t1', 'POSITION'), // sentinel-claimed
      tracker('t2', 'POSITION', 'NIFTY24800CE'), // owned elsewhere
    ]);
    ownedElsewhere.mockResolvedValue(new Set(['NIFTY24800CE']));

    const roster = await svc.build('u42');

    expect(roster.map((r) => r.userId)).toEqual(['u42', 'u42']);
    // Guard against the guard: the fixture must really have exercised both
    // surviving branches. The holding branch is unreachable now — holdings are
    // filtered before construction — so there is no third label to assert.
    expect(roster.map((r) => `${r.kind}/${r.ownership}`).sort()).toEqual([
      'POSITION/OBSERVE_ONLY',
      'POSITION/SENTINEL',
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

  it('reports over-capacity POSITIONS as unwatched, not dropped', async () => {
    // Over capacity is now only reachable with more than five real positions —
    // an unusual book, and one the user should be told about rather than have
    // silently trimmed.
    list.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => tracker(`t${i}`, 'POSITION', `S${i}`)),
    );
    const roster = await svc.build('u1');
    expect(roster).toHaveLength(7);
    const unwatched = roster.filter((r) => !r.watched);
    expect(unwatched).toHaveLength(2);
    for (const entry of unwatched) {
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

    it('drops holdings from the ordering rather than ranking them last', async () => {
      // The old rule ranked holdings after positions. That was not enough: with
      // enough holdings they still reached the cap. They are now removed before
      // the sort runs, so the ordering only ever decides between positions.
      list.mockResolvedValue([
        tracker('h-newest', 'HOLDING', 'A', at(8)),
        tracker('p-new', 'POSITION', 'B', at(6)),
        tracker('h-oldest', 'HOLDING', 'C', at(2)),
        tracker('h-mid', 'HOLDING', 'D', at(4)),
        tracker('p-old', 'POSITION', 'E', at(1)),
        tracker('h-2nd-newest', 'HOLDING', 'F', at(7)),
      ]);
      const roster = await svc.build('u1');

      expect(roster.map((r) => r.trackerId)).toEqual(['p-old', 'p-new']);
      expect(roster.every((r) => r.watched)).toBe(true);
    });

    it('keeps a position opened today, however old the holdings beside it', async () => {
      list.mockResolvedValue([
        tracker('h-ancient', 'HOLDING', 'A', at(1)),
        tracker('p-today', 'POSITION', 'B', at(28)),
      ]);
      const roster = await svc.build('u1');
      expect(roster.map((r) => r.trackerId)).toEqual(['p-today']);
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

/**
 * The failure this guards against is SILENT AND IT FAILS OPEN: a spelling
 * mismatch means the probe's set never matches, so the sentinel labels
 * `SENTINEL` a position `watch-monitor` is already managing. In Stage 0 that is
 * a mislabelled row; in Stage 1 it is two engines racing to exit one position.
 */
describe('RosterService — ownership across two symbol spellings', () => {
  const list = jest.fn();
  const ownedElsewhere = jest.fn();
  const svc = new RosterService({ listOpen: list } as any, {
    symbolsOwnedByOtherEngines: ownedElsewhere,
  } as any);

  beforeEach(() => jest.clearAllMocks());

  it('matches a suffixed broker symbol against a stripped engine symbol', async () => {
    // Exactly the real pair: `trade_trackers.symbol` is Angel One's
    // tradingsymbol, `watch_entries.symbol` is the Chartink base symbol.
    list.mockResolvedValue([tracker('t1', 'POSITION', 'SUZLON-EQ')]);
    ownedElsewhere.mockResolvedValue(new Set(['SUZLON']));

    const [entry] = await svc.build('u1');

    expect(entry.ownership).toBe('OBSERVE_ONLY');
    expect(entry.reason).toContain('another engine');
    // The entry keeps the BROKER's spelling — normalisation is for the compare
    // only. A verdict row carrying a symbol the broker never used would be
    // unjoinable against the tracker it came from.
    expect(entry.symbol).toBe('SUZLON-EQ');
  });

  it('matches when the mismatch runs the OTHER way — an un-normalised probe', async () => {
    // The literal reverse: a suffixed symbol in the PROBE's set against a bare
    // one on the tracker. The probe's contract says its set is normalised, but
    // a contract is a comment — and a probe that breaks it fails OPEN, which is
    // the dangerous direction. So the roster normalises the incoming set too.
    list.mockResolvedValue([tracker('t1', 'POSITION', 'SUZLON')]);
    ownedElsewhere.mockResolvedValue(new Set(['SUZLON-EQ']));

    const [entry] = await svc.build('u1');
    expect(entry.ownership).toBe('OBSERVE_ONLY');
  });

  it('matches when BOTH sides are un-normalised in different series', async () => {
    list.mockResolvedValue([tracker('t1', 'POSITION', 'SUZLON-EQ')]);
    ownedElsewhere.mockResolvedValue(new Set(['SUZLON-BE']));

    const [entry] = await svc.build('u1');
    expect(entry.ownership).toBe('OBSERVE_ONLY');
  });

  it('still claims a position no engine holds, so normalisation is not blanket-matching', async () => {
    // Without this the test above passes for a `build` that marked EVERYTHING
    // OBSERVE_ONLY, which would be the opposite bug and just as wrong.
    list.mockResolvedValue([
      tracker('t1', 'POSITION', 'SUZLON-EQ'),
      tracker('t2', 'POSITION', 'RELIANCE-EQ'),
    ]);
    ownedElsewhere.mockResolvedValue(new Set(['SUZLON']));

    const roster = await svc.build('u1');
    expect(roster.map((r) => r.ownership)).toEqual(['OBSERVE_ONLY', 'SENTINEL']);
  });

  it('does not let one option strike claim another on the same underlying', async () => {
    // Normalisation must not reach derivative tradingsymbols: owning the 24000
    // call says nothing about the 24500 call.
    list.mockResolvedValue([tracker('t1', 'POSITION', 'NIFTY28AUG2524500CE')]);
    ownedElsewhere.mockResolvedValue(new Set(['NIFTY28AUG2524000CE']));

    const [entry] = await svc.build('u1');
    expect(entry.ownership).toBe('SENTINEL');
  });
});

/**
 * SENTINEL_WATCH_EQUITY_INTRADAY=off: THE PRE-2026-10-29 REMIT, F&O ONLY.
 *
 * The rollback must restore that roster exactly, so these are the original
 * F&O-only tests, unchanged except that the roster is built with the switch
 * off. With it on (the default) intraday cash joins — see the next block.
 */
describe('RosterService — F&O only (SENTINEL_WATCH_EQUITY_INTRADAY=off)', () => {
  const list = jest.fn();
  const ownedElsewhere = jest.fn().mockResolvedValue(new Set<string>());
  const svc = new RosterService(
    { listOpen: list } as any,
    { symbolsOwnedByOtherEngines: ownedElsewhere } as any,
    { SENTINEL_WATCH_EQUITY_INTRADAY: 'off' },
  );

  beforeEach(() => {
    jest.clearAllMocks();
    ownedElsewhere.mockResolvedValue(new Set<string>());
  });

  it('watches an NFO option and leaves the cash position out', async () => {
    list.mockResolvedValue([
      tracker('opt', 'POSITION', 'KEI29SEP265800CE', undefined, 'NFO'),
      tracker('eq', 'POSITION', 'MOTHERSON-EQ', undefined, 'NSE'),
    ]);
    const roster = await svc.build('u1');
    expect(roster.map((r) => r.trackerId)).toEqual(['opt']);
  });

  it('watches an MCX commodity option', async () => {
    // The remit is the SEGMENT, not the exchange — MCX derivatives count.
    list.mockResolvedValue([
      tracker('c', 'POSITION', 'CRUDEOIL17AUG267800CE', undefined, 'MCX'),
    ]);
    expect((await svc.build('u1')).map((r) => r.trackerId)).toEqual(['c']);
  });

  it('classifies a future by suffix even off a cash exchange', async () => {
    // `segmentFor` reads the exchange first and the suffix second, so a
    // mislabelled row still lands in the right bucket rather than being dropped.
    list.mockResolvedValue([
      tracker('f', 'POSITION', 'RELIANCE28AUG25FUT', undefined, 'NSE'),
    ]);
    expect((await svc.build('u1')).map((r) => r.trackerId)).toEqual(['f']);
  });

  it('returns an EMPTY roster for a book of nothing but equities', async () => {
    // Stated behaviour, not a silent failure. The cycle reports having watched
    // nothing, which is correct — the alternative is spending agent calls and
    // the user's money judging trades the sentinel has no remit over.
    list.mockResolvedValue([
      tracker('a', 'POSITION', 'MOTHERSON-EQ', undefined, 'NSE'),
      tracker('b', 'POSITION', 'LTF-EQ', undefined, 'NSE'),
      tracker('c', 'HOLDING', 'SUZLON-EQ', undefined, 'NSE'),
    ]);
    expect(await svc.build('u1')).toEqual([]);
  });

  it('does not let cash positions consume the watch cap', async () => {
    // The failure this prevents: eight equities ahead of one option in store
    // order would have taken all five slots and left the option UNWATCHED —
    // the same inversion holdings caused before they were excluded.
    list.mockResolvedValue([
      ...Array.from({ length: 8 }, (_, i) =>
        tracker(`eq${i}`, 'POSITION', `EQ${i}-EQ`, undefined, 'NSE'),
      ),
      tracker('opt', 'POSITION', 'KEI29SEP265800CE', undefined, 'NFO'),
    ]);
    const roster = await svc.build('u1');
    expect(roster.map((r) => r.trackerId)).toEqual(['opt']);
    expect(roster[0].watched).toBe(true);
  });
});

/**
 * INTRADAY CASH EQUITY (owner request 2026-10-29, default on).
 *
 * An MIS position has a deadline — the broker squares it off before the close —
 * so it is a today-decision like an option and is watched. Observe-only: the
 * executor refuses NSE/BSE (sentinel-executor `equity-observe-only.spec.ts`).
 * F&O ALWAYS outranks equity for the five slots.
 */
describe('RosterService — intraday cash equity', () => {
  const list = jest.fn();
  const ownedElsewhere = jest.fn().mockResolvedValue(new Set<string>());
  const build = (env: Record<string, string | undefined> = {}) =>
    new RosterService({ listOpen: list } as any, { symbolsOwnedByOtherEngines: ownedElsewhere } as any, env).build('u1');

  beforeEach(() => {
    jest.clearAllMocks();
    ownedElsewhere.mockResolvedValue(new Set<string>());
  });

  it('watches the owner’s open JPL-EQ position by default', async () => {
    list.mockResolvedValue([tracker('jpl', 'POSITION', 'JPL-EQ', at(29), 'NSE')]);
    expect(await build()).toEqual([
      expect.objectContaining({ trackerId: 'jpl', symbol: 'JPL-EQ', exchange: 'NSE', kind: 'POSITION', watched: true }),
    ]);
  });

  it('watches a BSE cash position too', async () => {
    list.mockResolvedValue([tracker('b', 'POSITION', 'JPL', undefined, 'BSE')]);
    expect((await build()).map((r) => r.trackerId)).toEqual(['b']);
  });

  it('still leaves holdings (delivery) out', async () => {
    list.mockResolvedValue([
      tracker('h', 'HOLDING', 'SUZLON-EQ', at(1), 'NSE'),
      tracker('jpl', 'POSITION', 'JPL-EQ', at(2), 'NSE'),
    ]);
    expect((await build()).map((r) => r.trackerId)).toEqual(['jpl']);
  });

  it('F&O outranks equity for the slots, whatever the entry times', async () => {
    // Six equities, every one OLDER than the two F&O contracts and listed first:
    // the contracts still take the first two slots, the oldest equities the rest.
    list.mockResolvedValue([
      ...Array.from({ length: 6 }, (_, i) => tracker(`eq${i}`, 'POSITION', `EQ${i}-EQ`, at(1 + i), 'NSE')),
      tracker('opt-new', 'POSITION', 'KEI29SEP265800CE', at(20), 'NFO'),
      tracker('fut-old', 'POSITION', 'CRUDEOIL19NOV26FUT', at(10), 'MCX'),
    ]);
    const roster = await build();
    expect(roster.filter((r) => r.watched).map((r) => r.trackerId)).toEqual(['fut-old', 'opt-new', 'eq0', 'eq1', 'eq2']);
    expect(roster.filter((r) => !r.watched).map((r) => r.trackerId)).toEqual(['eq3', 'eq4', 'eq5']);
    expect(roster.find((r) => r.trackerId === 'eq5')!.reason).toMatch(/over capacity/i);
  });

  it('an equity position never takes a slot from an F&O one', async () => {
    list.mockResolvedValue([
      tracker('eq', 'POSITION', 'JPL-EQ', at(1), 'NSE'),
      ...Array.from({ length: 5 }, (_, i) => tracker(`o${i}`, 'POSITION', `NIFTY${i}CE`, at(10 + i), 'NFO')),
    ]);
    const roster = await build();
    expect(roster.filter((r) => r.watched).map((r) => r.trackerId)).toEqual(['o0', 'o1', 'o2', 'o3', 'o4']);
    expect(roster.find((r) => r.trackerId === 'eq')).toMatchObject({ watched: false, reason: expect.stringMatching(/over capacity/i) });
  });

  it('within equity, oldest first', async () => {
    list.mockResolvedValue([
      tracker('new', 'POSITION', 'A-EQ', at(9), 'NSE'),
      tracker('old', 'POSITION', 'B-EQ', at(1), 'NSE'),
    ]);
    expect((await build()).map((r) => r.trackerId)).toEqual(['old', 'new']);
  });

  it('an equity managed by another engine is observed only, like any position', async () => {
    ownedElsewhere.mockResolvedValue(new Set(['JPL']));
    list.mockResolvedValue([tracker('jpl', 'POSITION', 'JPL-EQ', undefined, 'NSE')]);
    expect((await build())[0]).toMatchObject({ ownership: 'OBSERVE_ONLY', watched: true });
  });

  it.each([['off'], [' OFF '], ['Off']])('SENTINEL_WATCH_EQUITY_INTRADAY=%j drops equity again', async (v) => {
    list.mockResolvedValue([
      tracker('jpl', 'POSITION', 'JPL-EQ', at(1), 'NSE'),
      tracker('opt', 'POSITION', 'KEI29SEP265800CE', at(2), 'NFO'),
    ]);
    expect((await build({ SENTINEL_WATCH_EQUITY_INTRADAY: v })).map((r) => r.trackerId)).toEqual(['opt']);
  });

  it.each([[undefined], [''], ['on'], ['true'], ['of']])('SENTINEL_WATCH_EQUITY_INTRADAY=%j keeps equity on', async (v) => {
    list.mockResolvedValue([tracker('jpl', 'POSITION', 'JPL-EQ', at(1), 'NSE')]);
    expect((await build({ SENTINEL_WATCH_EQUITY_INTRADAY: v })).map((r) => r.trackerId)).toEqual(['jpl']);
  });

  it('off is exactly the on roster minus the equity rows', async () => {
    list.mockResolvedValue([
      tracker('eq', 'POSITION', 'JPL-EQ', at(1), 'NSE'),
      tracker('o2', 'POSITION', 'NIFTY2CE', at(5), 'NFO'),
      tracker('o1', 'POSITION', 'NIFTY1CE', at(3), 'NFO'),
    ]);
    const on = await build();
    const off = await build({ SENTINEL_WATCH_EQUITY_INTRADAY: 'off' });
    expect(off).toEqual(on.filter((r) => r.exchange !== 'NSE'));
  });
});

describe('segmentFor never reads an executable exchange as intraday cash', () => {
  // The other half of sentinel-executor's equity-observe-only.spec.ts: the
  // executor acts only on NFO/BFO/MCX, and no row on those exchanges can enter
  // the roster's equity group, whatever its symbol says.
  it.each([['NFO'], ['BFO'], ['MCX'], ['nfo']])('%s → a derivative segment', (exchange) => {
    for (const symbol of ['JPL-EQ', 'JPL', 'RELIANCE']) {
      expect(segmentFor({ exchange, symbol, kind: 'POSITION' })).not.toMatch(/^EQ_/);
    }
  });
  it('NSE / BSE cash positions are EQ_INTRADAY', () => {
    expect(segmentFor({ exchange: 'NSE', symbol: 'JPL-EQ', kind: 'POSITION' })).toBe('EQ_INTRADAY');
    expect(segmentFor({ exchange: 'BSE', symbol: 'JPL', kind: 'POSITION' })).toBe('EQ_INTRADAY');
  });
});
