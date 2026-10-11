import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { BOOT_JOBS_DISABLED } from '../../../common/utils/boot-jobs';
import type { CoreOrderRequest } from './execution.types';
import { PaperLedgerService, type PlaceContext } from './paper-ledger.service';
import { coreOrderOwner, MATCHER_SWEEP_MS, PaperMatcherService } from './paper-matcher.service';
import type { CorePaperDefaultsService } from './services/core-paper-defaults.service';
import { FakeHub, fakeHubSource, fakeModuleRef } from './testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, depth, hubPrice, NOW } from './testing/paper-fixtures';

const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
const SUB = NOW.getTime();

function setup(opts: { open?: boolean } = {}) {
  const store = new MemoryPaperStore(() => NOW);
  const defaults = fakeDefaults();
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, defaults);
  const hub = new FakeHub();
  const clock = { isOpen: jest.fn(() => opts.open ?? true) };
  const matcherWith = (h: FakeHub, d: CorePaperDefaultsService = defaults) =>
    new PaperMatcherService(ledger, d, fakeModuleRef(fakeHubSource({ user_A: h })) as unknown as ModuleRef, clock);
  const matcher = matcherWith(hub);
  const place = async (req: CoreOrderRequest = cashBuy(), at: Date = NOW) => {
    const r = await ledger.place(req, OPEN, at);
    matcher.track(r.order, 30_000, at.getTime());
    return r.order;
  };
  const stateOf = (id: string) => store.orders.find((o) => o.id === id);
  return { store, ledger, hub, clock, matcher, matcherWith, place, stateOf };
}

const slBuy = (over: Partial<CoreOrderRequest> = {}) =>
  cashBuy({ idempotencyKey: 'sl_1', type: 'SL_MARKET', triggerPrice: 510, refPrice: 510, ...over });

const infy = { exchange: 'NSE', token: '1594', symbol: 'INFY-EQ', lotSize: 1, underlying: null };

describe('PaperMatcherService', () => {
  beforeEach(() => {
    // Pristine output: tests that assert on a log line spy on it themselves.
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tracks an open order: watches its ref at priority 0 as core-order:<id>, one price subscription per hub', async () => {
    const { hub, matcher, place } = setup();
    const a = await place();
    const b = await place(cashBuy({ idempotencyKey: 'k2' }));
    expect(hub.watches).toEqual([
      { key: 'NSE:2885', priority: 0, owner: coreOrderOwner(a.id) },
      { key: 'NSE:2885', priority: 0, owner: coreOrderOwner(b.id) },
    ]);
    expect(coreOrderOwner(a.id)).toBe(`core-order:${a.id}`);
    expect(hub.listenerCount()).toBe(1);
    expect(matcher.openCount()).toBe(2);
  });

  it('a push stamped at the submission instant does not fill; the next one does', async () => {
    const { hub, matcher, place, stateOf } = setup();
    const o = await place();
    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB, depth([[500, 100]])), SUB + 5);
    expect(stateOf(o.id)?.state).toBe('OPEN');
    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]])), SUB + 6);
    expect(stateOf(o.id)).toMatchObject({ state: 'FILLED', filledQty: 100, avgFillPrice: 500 });
    expect(matcher.isTracked(o.id)).toBe(false);
    expect(hub.unwatches).toEqual([{ key: 'NSE:2885', owner: coreOrderOwner(o.id) }]);
  });

  it('a push delivered through the hub listener fills (the event-driven path)', async () => {
    const { hub, place, stateOf } = setup();
    const o = await place(cashBuy(), new Date(Date.now() - 1_000));
    hub.push(hubPrice(cashBuy(), 500, Date.now(), depth([[500, 100]])));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stateOf(o.id)?.state).toBe('FILLED');
  });

  it("the sweep fills from the hub's book when no push came", async () => {
    const { hub, matcher, place, stateOf } = setup();
    const o = await place();
    hub.setFresh(hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]])));
    await matcher.sweep(SUB + 10);
    expect(stateOf(o.id)?.state).toBe('FILLED');
  });

  it('a partial fill stays tracked and the next price fills the rest', async () => {
    const { store, hub, matcher, place, stateOf } = setup();
    const o = await place();
    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 40]])), SUB + 2);
    expect(stateOf(o.id)).toMatchObject({ state: 'PARTIAL', filledQty: 40 });
    expect(matcher.isTracked(o.id)).toBe(true);
    await matcher.onPrice(hub, hubPrice(cashBuy(), 501, SUB + 3, depth([[501, 100]])), SUB + 4);
    expect(stateOf(o.id)).toMatchObject({ state: 'FILLED', filledQty: 100 });
    expect(store.fills.map((f) => f.qty)).toEqual([40, 60]);
  });

  it('a user the hub does not serve is rejected "no fresh price" at the deadline, and the margin comes back', async () => {
    const { store, matcher, place, stateOf } = setup();
    const o = await place(cashBuy({ userId: 'user_B', idempotencyKey: 'kb' }));
    await matcher.sweep(SUB + 29_999);
    expect(stateOf(o.id)?.state).toBe('OPEN');
    await matcher.sweep(SUB + 30_001);
    expect(stateOf(o.id)).toMatchObject({ state: 'REJECTED', rejectReason: 'no fresh price after submission (waited 30000 ms)' });
    expect(store.ledger.filter((r) => r.userId === 'user_B').reduce((a, r) => a + r.amount.toNumber(), 0)).toBe(1_000_000);
    expect(matcher.openCount()).toBe(0);
  });

  it('a container without the market hub never fills and rejects at the deadline', async () => {
    const { ledger, stateOf } = setup();
    const blind = new PaperMatcherService(ledger, fakeDefaults(), fakeModuleRef(null) as unknown as ModuleRef, { isOpen: () => true });
    const r = await ledger.place(cashBuy(), OPEN, NOW);
    blind.track(r.order, 30_000, SUB);
    await blind.onPrice(new FakeHub(), hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]])), SUB + 2);
    await blind.sweep(SUB + 29_999);
    expect(stateOf(r.order.id)?.state).toBe('OPEN');
    await blind.sweep(SUB + 30_001);
    expect(stateOf(r.order.id)?.state).toBe('REJECTED');
  });

  it('a stale price never fills; the order is rejected at the deadline', async () => {
    const { hub, matcher, place, stateOf } = setup();
    const o = await place();
    hub.setFresh(hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]])));
    await matcher.sweep(SUB + 1 + 15_001);
    expect(stateOf(o.id)?.state).toBe('OPEN');
    await matcher.sweep(SUB + 30_001);
    expect(stateOf(o.id)?.state).toBe('REJECTED');
    expect(hub.unwatches).toEqual([{ key: 'NSE:2885', owner: coreOrderOwner(o.id) }]);
  });

  describe('the no-price deadline across restarts and closed sessions (ruling P16a)', () => {
    it('a restart while the session is closed rejects nothing however long it stays closed; open-session time then counts', async () => {
      const { clock, hub, matcherWith, place, stateOf } = setup();
      const o = await place();
      clock.isOpen.mockReturnValue(false);
      const restarted = matcherWith(new FakeHub());
      await restarted.sweep(SUB + 3); // reload: the countdown starts at SUB + 3 (P4)
      await restarted.sweep(SUB + 31_000);
      await restarted.sweep(SUB + 10 * 3_600_000); // ten hours closed
      expect(stateOf(o.id)?.state).toBe('OPEN');
      expect(restarted.isTracked(o.id)).toBe(true);

      clock.isOpen.mockReturnValue(true);
      const opened = SUB + 10 * 3_600_000;
      await restarted.sweep(opened + 29_999);
      expect(stateOf(o.id)?.state).toBe('OPEN');
      await restarted.sweep(opened + 30_001);
      expect(stateOf(o.id)).toMatchObject({ state: 'REJECTED', rejectReason: 'no fresh price after submission (waited 30000 ms)' });
      expect(hub.unwatches).toEqual([]); // the old instance's hub is untouched
    });

    it('time while the session is closed does not count, also without a restart', async () => {
      const { clock, matcher, place, stateOf } = setup();
      const o = await place();
      await matcher.sweep(SUB + 10_000); // 10 s open
      clock.isOpen.mockReturnValue(false);
      await matcher.sweep(SUB + 100_000); // 90 s closed: not counted
      clock.isOpen.mockReturnValue(true);
      await matcher.sweep(SUB + 119_999); // 10 s + 19.999 s open
      expect(stateOf(o.id)?.state).toBe('OPEN');
      await matcher.sweep(SUB + 120_001);
      expect(stateOf(o.id)?.state).toBe('REJECTED');
    });

    it('a reloaded PARTIAL order counts as priced and is never no-price rejected', async () => {
      const { ledger, hub, matcher, matcherWith, place, stateOf } = setup();
      const o = await place();
      await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 40]])), SUB + 2);
      const close = jest.spyOn(ledger, 'close');
      const restarted = matcherWith(new FakeHub());
      await restarted.sweep(SUB + 3);
      await restarted.sweep(SUB + 3_600_000);
      expect(close).not.toHaveBeenCalled(); // no reject is even attempted
      expect(stateOf(o.id)).toMatchObject({ state: 'PARTIAL', filledQty: 40 });
      expect(restarted.isTracked(o.id)).toBe(true);
    });

    it('a reloaded triggered stop counts as priced and is never no-price rejected', async () => {
      const { hub, matcher, matcherWith, place, stateOf } = setup();
      const o = await place(slBuy());
      await matcher.onPrice(hub, hubPrice(cashBuy(), 511, SUB + 1, depth([], [[511, 100]])), SUB + 2);
      const restarted = matcherWith(new FakeHub());
      await restarted.sweep(SUB + 3);
      await restarted.sweep(SUB + 3_600_000);
      expect(stateOf(o.id)).toMatchObject({ state: 'OPEN', triggeredAt: new Date(SUB + 1) });
      expect(restarted.isTracked(o.id)).toBe(true);
    });
  });

  it('out of session nothing fills, even on a fresh push', async () => {
    const { hub, matcher, place, stateOf } = setup({ open: false });
    const o = await place();
    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]])), SUB + 2);
    expect(stateOf(o.id)?.state).toBe('OPEN');
  });

  it('a push and a sweep at once fill once', async () => {
    const { store, hub, matcher, place, stateOf } = setup();
    const o = await place();
    const p = hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]]));
    hub.setFresh(p);
    await Promise.all([matcher.onPrice(hub, p, SUB + 2), matcher.sweep(SUB + 2), matcher.onPrice(hub, p, SUB + 2)]);
    expect(store.fills).toHaveLength(1);
    expect(stateOf(o.id)?.state).toBe('FILLED');
  });

  it('a recreated matcher reloads open orders, re-watches them and fills only what is left', async () => {
    const { store, hub, matcher, matcherWith, place, stateOf } = setup();
    const o = await place();
    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 40]])), SUB + 2);
    expect(stateOf(o.id)?.state).toBe('PARTIAL');

    const hub2 = new FakeHub();
    const restarted = matcherWith(hub2);
    await restarted.sweep(SUB + 3);
    expect(restarted.isTracked(o.id)).toBe(true);
    expect(hub2.watches).toEqual([{ key: 'NSE:2885', priority: 0, owner: coreOrderOwner(o.id) }]);
    hub2.setFresh(hubPrice(cashBuy(), 502, SUB + 4, depth([[502, 500]])));
    await restarted.sweep(SUB + 5);
    expect(stateOf(o.id)).toMatchObject({ state: 'FILLED', filledQty: 100 });

    // The old instance still holds the PARTIAL copy (filledQty 40): its fill is refused by the guard.
    await matcher.onPrice(hub, hubPrice(cashBuy(), 503, SUB + 6, depth([[503, 500]])), SUB + 7);
    expect(store.fills.map((f) => f.qty)).toEqual([40, 60]);
    expect(matcher.isTracked(o.id)).toBe(false);
  });

  it('the boot reload waits for the settings and never tracks without them', async () => {
    const { ledger, hub, matcherWith } = setup();
    await ledger.place(cashBuy(), OPEN, NOW);
    const blind = matcherWith(hub, fakeDefaults(null));
    await blind.sweep(SUB + 1);
    expect(blind.openCount()).toBe(0);
    const seeing = matcherWith(hub);
    await seeing.sweep(SUB + 1);
    expect(seeing.openCount()).toBe(1);
  });

  it('module destroy stops the sweep and unsubscribes from every hub', async () => {
    const { hub, matcher, place } = setup();
    matcher.onModuleInit();
    await place();
    expect(hub.listenerCount()).toBe(1);
    matcher.onModuleDestroy();
    expect(hub.listenerCount()).toBe(0);
  });

  it('sweeps every MATCHER_SWEEP_MS while the module lives, and not after destroy (fake timers)', () => {
    jest.useFakeTimers();
    try {
      const { matcher } = setup();
      const sweep = jest.spyOn(matcher, 'sweep').mockResolvedValue(undefined);
      matcher.onModuleInit();
      jest.advanceTimersByTime(MATCHER_SWEEP_MS * 3);
      expect(sweep).toHaveBeenCalledTimes(3);
      matcher.onModuleDestroy();
      jest.advanceTimersByTime(MATCHER_SWEEP_MS * 3);
      expect(sweep).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('BOOT_JOBS=false (a one-shot script process)', () => {
    const saved = process.env.BOOT_JOBS;
    afterEach(() => {
      if (saved === undefined) delete process.env.BOOT_JOBS;
      else process.env.BOOT_JOBS = saved;
    });

    it('starts no sweep, reloads nothing and touches no ledger; says why once', () => {
      jest.useFakeTimers();
      try {
        process.env.BOOT_JOBS = 'false';
        const { ledger, matcher } = setup();
        const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        const sweep = jest.spyOn(matcher, 'sweep');
        const reload = jest.spyOn(matcher, 'reload');
        const openOrders = jest.spyOn(ledger, 'openOrders');
        matcher.onModuleInit();
        jest.advanceTimersByTime(MATCHER_SWEEP_MS * 5);
        expect(jest.getTimerCount()).toBe(0);
        expect(sweep).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(openOrders).not.toHaveBeenCalled();
        expect(logged).toHaveBeenCalledTimes(1);
        expect(logged).toHaveBeenCalledWith(BOOT_JOBS_DISABLED);
        matcher.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('with BOOT_JOBS unset the sweep starts as before', () => {
      jest.useFakeTimers();
      try {
        delete process.env.BOOT_JOBS;
        const { matcher } = setup();
        const sweep = jest.spyOn(matcher, 'sweep').mockResolvedValue(undefined);
        matcher.onModuleInit();
        jest.advanceTimersByTime(MATCHER_SWEEP_MS * 2);
        expect(sweep).toHaveBeenCalledTimes(2);
        matcher.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('SL_MARKET trigger persistence (ruling P10)', () => {
    it('a trigger reached with no fill persists triggeredAt; the stop then fills as MARKET below the trigger', async () => {
      const { ledger, hub, matcher, place, stateOf } = setup();
      const markTriggered = jest.spyOn(ledger, 'markTriggered');
      const o = await place(slBuy());
      await matcher.onPrice(hub, hubPrice(cashBuy(), 505, SUB + 1, depth([[505, 100]])), SUB + 2);
      expect(stateOf(o.id)).toMatchObject({ state: 'OPEN', triggeredAt: null });
      expect(markTriggered).not.toHaveBeenCalled();

      // The trigger is reached but the book has no asks: NONE + triggered.
      await matcher.onPrice(hub, hubPrice(cashBuy(), 511, SUB + 3, depth([], [[511, 100]])), SUB + 4);
      expect(markTriggered).toHaveBeenCalledWith('user_A', o.id, expect.objectContaining({ filledQty: 0, qty: 100, limitPrice: null, triggerPrice: 510 }), new Date(SUB + 3));
      expect(stateOf(o.id)).toMatchObject({ state: 'OPEN', filledQty: 0, triggeredAt: new Date(SUB + 3) });

      // A stop never un-triggers: a price back below the trigger fills it.
      await matcher.onPrice(hub, hubPrice(cashBuy(), 505, SUB + 5, depth([[505, 100]])), SUB + 6);
      expect(stateOf(o.id)).toMatchObject({ state: 'FILLED', filledQty: 100, avgFillPrice: 505, triggeredAt: new Date(SUB + 3) });
    });

    it('the persisted trigger survives a restart: the reloaded stop fills below its trigger', async () => {
      const { hub, matcher, matcherWith, place, stateOf } = setup();
      const o = await place(slBuy());
      await matcher.onPrice(hub, hubPrice(cashBuy(), 511, SUB + 1, depth([], [[511, 100]])), SUB + 2);
      expect(stateOf(o.id)?.triggeredAt).toEqual(new Date(SUB + 1));

      const hub2 = new FakeHub();
      const restarted = matcherWith(hub2);
      await restarted.sweep(SUB + 3);
      hub2.setFresh(hubPrice(cashBuy(), 504, SUB + 4, depth([[504, 100]])));
      await restarted.sweep(SUB + 5);
      expect(stateOf(o.id)).toMatchObject({ state: 'FILLED', avgFillPrice: 504 });
    });

    it('a trigger reached with a fill persists triggeredAt in the same write as the fill', async () => {
      const { ledger, hub, matcher, place, stateOf } = setup();
      const applyFill = jest.spyOn(ledger, 'applyFill');
      const markTriggered = jest.spyOn(ledger, 'markTriggered');
      const o = await place(slBuy());
      await matcher.onPrice(hub, hubPrice(cashBuy(), 511, SUB + 1, depth([[511, 100]])), SUB + 2);
      expect(applyFill).toHaveBeenCalledWith('user_A', o.id, expect.objectContaining({ filledQty: 0, qty: 100, limitPrice: null, triggerPrice: 510 }), expect.objectContaining({ qty: 100, priceAt: new Date(SUB + 1), triggered: true }), new Date(SUB + 2));
      expect(markTriggered).not.toHaveBeenCalled();
      expect(stateOf(o.id)).toMatchObject({ state: 'FILLED', triggeredAt: new Date(SUB + 1) });
    });
  });

  it('an order whose fill throws is logged and retried; the other orders keep matching', async () => {
    const { ledger, hub, matcher, place, stateOf } = setup();
    const a = await place();
    const b = await place(cashBuy({ idempotencyKey: 'k2' }));
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const real = ledger.applyFill.bind(ledger);
    let thrown = false;
    jest.spyOn(ledger, 'applyFill').mockImplementation(async (...args: Parameters<PaperLedgerService['applyFill']>) => {
      if (args[1] === a.id && !thrown) {
        thrown = true;
        throw new Error('paper settings are unreadable');
      }
      return real(...args);
    });

    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 500]])), SUB + 2);
    expect(stateOf(a.id)?.state).toBe('OPEN');
    expect(stateOf(b.id)?.state).toBe('FILLED');
    expect(matcher.isTracked(a.id)).toBe(true);
    expect(logged).toHaveBeenCalledWith(`core order ${a.id}: evaluation failed: paper settings are unreadable`);

    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 3, depth([[500, 500]])), SUB + 4);
    expect(stateOf(a.id)?.state).toBe('FILLED');
    expect(matcher.openCount()).toBe(0);
  });

  it('leaks no watch: every order that reaches a terminal state is unwatched exactly once', async () => {
    const { ledger, hub, matcher, place, stateOf } = setup();
    const filled = await place();
    const unpriced = await place(cashBuy({ idempotencyKey: 'k2', instrument: infy }));
    const cancelled = await place(cashBuy({ idempotencyKey: 'k3', instrument: infy }));

    matcher.refresh(await ledger.close('user_A', cancelled.id, 'CANCEL', 'user cancelled'));
    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]])), SUB + 2);
    await matcher.sweep(SUB + 30_001);

    expect(stateOf(filled.id)?.state).toBe('FILLED');
    expect(stateOf(unpriced.id)?.state).toBe('REJECTED');
    expect(stateOf(cancelled.id)?.state).toBe('CANCELLED');
    expect(matcher.openCount()).toBe(0);
    const pairs = (xs: Array<{ key: string; owner: string }>) => xs.map((x) => `${x.key}|${x.owner}`).sort();
    expect(pairs(hub.unwatches)).toEqual(pairs(hub.watches));
    expect(hub.watches).toHaveLength(3);
  });

  describe('a modify racing an evaluation (ruling P17)', () => {
    const limitBuy = () => cashBuy({ idempotencyKey: 'lim_1', type: 'LIMIT', limitPrice: 500, refPrice: 500 });
    const older = <T extends { updatedAt: Date }>(o: T): T => ({ ...o, updatedAt: new Date(o.updatedAt.getTime() - 1) });

    it('a modify that lands between the decision and applyFill: no fill at the old limit; the next price meets the new limit', async () => {
      const { store, ledger, hub, matcher, place, stateOf } = setup();
      const o = await place(limitBuy());
      const real = ledger.applyFill.bind(ledger);
      const applyFill = jest.spyOn(ledger, 'applyFill').mockImplementationOnce(async (...args: Parameters<PaperLedgerService['applyFill']>) => {
        // The user lowers the limit 500 -> 498 after the matcher decided on 500.
        await ledger.modify('user_A', o.id, { limitPrice: 498 }, NOW);
        return real(...args);
      });

      await matcher.onPrice(hub, hubPrice(cashBuy(), 499, SUB + 1, depth([[499, 100]])), SUB + 2);
      expect(applyFill).toHaveBeenCalledTimes(1);
      expect(store.fills).toEqual([]);
      expect(stateOf(o.id)).toMatchObject({ state: 'OPEN', filledQty: 0, limitPrice: 498 });

      // The held copy now carries the new limit: a trade at 499 is not even sent to the ledger.
      await matcher.onPrice(hub, hubPrice(cashBuy(), 499, SUB + 3, depth([[499, 100]])), SUB + 4);
      expect(applyFill).toHaveBeenCalledTimes(1);
      expect(stateOf(o.id)?.state).toBe('OPEN');

      await matcher.onPrice(hub, hubPrice(cashBuy(), 497, SUB + 5, depth([[497, 100]])), SUB + 6);
      expect(stateOf(o.id)).toMatchObject({ state: 'FILLED', filledQty: 100, avgFillPrice: 498 });
    });

    it('refresh with an older copy keeps the newer held copy', async () => {
      const { ledger, hub, matcher, place, stateOf } = setup();
      const o = await place(limitBuy());
      const modified = await ledger.modify('user_A', o.id, { limitPrice: 498 }, NOW);
      matcher.refresh(modified);
      matcher.refresh(older({ ...modified, limitPrice: 500 })); // a late, older copy
      const applyFill = jest.spyOn(ledger, 'applyFill');

      await matcher.onPrice(hub, hubPrice(cashBuy(), 499, SUB + 1, depth([[499, 100]])), SUB + 2);
      expect(applyFill).not.toHaveBeenCalled();
      expect(stateOf(o.id)).toMatchObject({ state: 'OPEN', filledQty: 0 });

      // An equal-or-newer copy still replaces it.
      matcher.refresh({ ...modified, limitPrice: 500 });
      await matcher.onPrice(hub, hubPrice(cashBuy(), 499, SUB + 3, depth([[499, 100]])), SUB + 4);
      expect(applyFill).toHaveBeenCalledTimes(1);
    });

    it('the null-path re-read resolving after a newer refresh does not overwrite it', async () => {
      const { ledger, hub, matcher, place, stateOf } = setup();
      const o = await place(limitBuy());
      const stale = older(o); // what an out-of-lock read could still return
      const applyFill = jest.spyOn(ledger, 'applyFill').mockImplementationOnce(async () => {
        // The modify commits and the adapter refreshes the matcher before the re-read resolves.
        matcher.refresh(await ledger.modify('user_A', o.id, { limitPrice: 498 }, NOW));
        return null;
      });
      jest.spyOn(ledger, 'findOrder').mockResolvedValueOnce(stale);

      await matcher.onPrice(hub, hubPrice(cashBuy(), 499, SUB + 1, depth([[499, 100]])), SUB + 2);
      expect(applyFill).toHaveBeenCalledTimes(1);

      // Still matched against 498: a trade at 499 is not sent to the ledger.
      await matcher.onPrice(hub, hubPrice(cashBuy(), 499, SUB + 3, depth([[499, 100]])), SUB + 4);
      expect(applyFill).toHaveBeenCalledTimes(1);
      expect(stateOf(o.id)).toMatchObject({ state: 'OPEN', filledQty: 0, limitPrice: 498 });
    });
  });
});
