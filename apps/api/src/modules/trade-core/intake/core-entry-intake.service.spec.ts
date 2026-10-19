import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { marginFor } from '../execution/margin';
import type { CorePaperDefaultsService } from '../execution/services/core-paper-defaults.service';
import { paperSettings } from '../execution/testing/paper-fixtures';
import type { CoreTradeHistory } from '../journal/journal-ports';
import { FakeJournal } from '../journal/testing/fake-journal';
import type { CoreLifecycleService, CoreOpenRequest } from '../lifecycle/core-lifecycle.service';
import type { RiskVerdict } from '../risk-wall/risk-wall.types';
import type { RiskWallService } from '../risk-wall/services/risk-wall.service';
import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import type { StrategyBlocks } from '../strategies/blocks/block-types';
import type { CoreStrategySelectionRepository, LiveSelection } from '../strategies/repositories/core-strategy-selection.repository';
import { currentCoreAlertIntake, setCoreAlertIntake } from './alert-handoff';
import { CoreEntryIntake, INTAKE_MAX_PENDING } from './core-entry-intake.service';
import type { EntryMode } from './entry-config';
import type { AtrRead, EntryMarket, PriceRead } from './entry-market';
import { adaptiveSeedBlocks, hit, ist, plainBlocks } from './testing/intake-fixtures';
import { parseMbmConfig, type MbmConfig } from '../../mbm/mbm.config';

const NOW = ist('2026-10-13', '10:30');

function verdict(over: Partial<RiskVerdict> = {}): RiskVerdict {
  return {
    intentId: 'x', userId: 'user_A', intentKind: 'ENTRY', verdict: 'ALLOW', requestedQty: 400, qty: 400,
    reasons: [{ code: 'WITHIN_LIMITS', message: 'within limits' }], limits: limitsFixture(), state: null, dailyLoss: null,
    killSwitchActive: false, checkedAt: NOW.toISOString(), ...over,
  };
}

interface SetupOptions {
  mode?: EntryMode;
  users?: string[];
  blocks?: StrategyBlocks;
  strategyKey?: string;
  price?: PriceRead;
  atr?: AtrRead;
  verdict?: RiskVerdict;
  history?: Partial<CoreTradeHistory>;
  open?: jest.Mock;
  maxAlertAgeMs?: number;
  mbm?: { config: MbmConfig; client: { behaviour: jest.Mock } };
}

function setup(o: SetupOptions = {}) {
  const sel: LiveSelection = {
    userId: 'user_A', strategyId: 'cs_x', strategyKey: o.strategyKey ?? 'ungated', strategyVersionId: 'csv_x_v1',
    blocks: o.blocks ?? plainBlocks(), capitalAllocation: '200000.00',
  };
  const selections = { listEnabledPaper: jest.fn().mockResolvedValue([sel]) };
  const wall = { check: jest.fn().mockResolvedValue(o.verdict ?? verdict()) };
  const opened = new Set<string>();
  const open = o.open ?? jest.fn(async (req: CoreOpenRequest) => {
    opened.add(req.intent.intentId);
    return { id: 'pos_1' };
  });
  const lifecycle = { openPosition: open };
  const defaults = { settings: jest.fn().mockResolvedValue({ ok: true, settings: paperSettings() }) };
  const price = o.price ?? { ok: true as const, ltp: 500, at: NOW.getTime() };
  const market = {
    freshPrice: jest.fn().mockResolvedValue(price),
    release: jest.fn(),
    atr: jest.fn().mockResolvedValue(o.atr ?? { atr: null, source: 'none', detail: 'fixed stop' }),
    candlesFor: jest.fn().mockResolvedValue(null),
    mbm: jest.fn().mockReturnValue(o.mbm ?? null),
  };
  const history: CoreTradeHistory = {
    intentSeen: jest.fn(async (id: string) => opened.has(id)),
    lastOpenedAt: jest.fn().mockResolvedValue(null),
    lastClosedNetToday: jest.fn().mockResolvedValue(null),
    ...o.history,
  };
  const journal = new FakeJournal();
  const corpus = { entrySetup: jest.fn().mockResolvedValue(undefined), outcome: jest.fn().mockResolvedValue(undefined) };
  const intake = new CoreEntryIntake(
    { mode: o.mode ?? 'paper', userIds: new Set(o.users ?? ['user_A']), maxAlertAgeMs: o.maxAlertAgeMs ?? 180_000 },
    selections as unknown as CoreStrategySelectionRepository,
    wall as unknown as RiskWallService,
    lifecycle as unknown as CoreLifecycleService,
    defaults as unknown as CorePaperDefaultsService,
    market as unknown as EntryMarket,
    history,
    journal,
    corpus,
  );
  return { intake, selections, wall, open, defaults, market, history, journal, corpus };
}

beforeEach(() => jest.useFakeTimers({ now: NOW }));
afterEach(() => {
  jest.useRealTimers();
  setCoreAlertIntake(null);
});

describe('CoreEntryIntake — switch and scope (O2, J3)', () => {
  it('registers for the hand-off only when entries are not off', () => {
    const off = setup({ mode: 'off' });
    off.intake.onModuleInit();
    expect(currentCoreAlertIntake()).toBeNull();
    const on = setup({ mode: 'journal' });
    on.intake.onModuleInit();
    expect(currentCoreAlertIntake()).toBe(on.intake);
    on.intake.onModuleDestroy();
    expect(currentCoreAlertIntake()).toBeNull();
  });

  it('off mode processes nothing even when called directly (fail closed)', async () => {
    const s = setup({ mode: 'off' });
    expect(await s.intake.process(hit(), NOW)).toEqual([]);
    expect(s.selections.listEnabledPaper).not.toHaveBeenCalled();
    expect(s.journal.entries).toEqual([]);
    expect(s.open).not.toHaveBeenCalled();
  });

  it('a user outside CORE_ENTRY_USER_IDS gets nothing: no journal, no price read', async () => {
    const s = setup({ users: ['someone_else'] });
    expect(await s.intake.process(hit())).toEqual([]);
    expect(s.journal.entries).toEqual([]);
    expect(s.market.freshPrice).not.toHaveBeenCalled();
  });

  it("a hit that is not the strategy's is silent; unreadable selections skip the hit without throwing", async () => {
    const s = setup();
    expect(await s.intake.process(hit({ scanName: 'EMA breakout' }))).toEqual([]);
    expect(s.journal.entries).toEqual([]);
    s.selections.listEnabledPaper.mockRejectedValueOnce(new Error('db down'));
    await expect(s.intake.process(hit())).resolves.toEqual([]);
  });
});

describe('CoreEntryIntake — the pipeline (J5)', () => {
  it('paper: an Ungated hit becomes an intent, passes the wall and opens a position; journaled and corpus-written', async () => {
    const s = setup();
    const [out] = await s.intake.process(hit(), NOW);
    expect(out).toMatchObject({ kind: 'OPENED', positionId: 'pos_1', qty: 400 });
    const intent = s.wall.check.mock.calls[0][0];
    expect(intent).toMatchObject({
      kind: 'ENTRY', userId: 'user_A', strategyId: 'cs_x', strategyVersionId: 'csv_x_v1', vehicle: 'CASH_INTRADAY', exchange: 'NSE',
      symbol: 'RELIANCE-EQ', underlying: 'RELIANCE', side: 'BUY', optionType: null, qty: 400, lotSize: 1, refPrice: 500, refPriceFresh: true,
      stopPrice: 492.5, capitalPerUnit: marginFor('CASH_INTRADAY', new Prisma.Decimal(500), paperSettings()).toNumber(), mtfLeverage: null,
    });
    expect(s.open).toHaveBeenCalledWith(
      { intent, qty: 400, instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null }, atr: null, limits: limitsFixture(), option: null },
      expect.any(Date),
    );
    expect(s.journal.types()).toEqual(['ALERT_RECEIVED']);
    expect(s.journal.entries[0]).toMatchObject({ dedupeKey: `alert:${intent.intentId}`, intentId: intent.intentId, strategyId: 'cs_x' });
    expect(s.corpus.entrySetup).toHaveBeenCalledWith(expect.objectContaining({
      intentId: intent.intentId, strategyKey: 'ungated', direction: 'LONG', ruleScore: 70, setupGroupKey: 'alert_1|RELIANCE|2026-10-13', decision: { taken: true, reason: 'opened pos_1 for 400' },
    }));
    expect(s.market.release).toHaveBeenCalledWith('user_A', { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' }, `core-intake:${intent.intentId}`);
  });

  it('a RESIZE opens the verdict quantity, never the requested one', async () => {
    const s = setup({ verdict: verdict({ verdict: 'RESIZE', qty: 133 }) });
    await s.intake.process(hit(), NOW);
    expect(s.open.mock.calls[0][0].qty).toBe(133);
  });

  it('journal mode runs the wall, opens nothing and writes no corpus row (J9)', async () => {
    const s = setup({ mode: 'journal' });
    const [out] = await s.intake.process(hit(), NOW);
    expect(out).toMatchObject({ kind: 'DRY_RUN', verdict: 'ALLOW', qty: 400 });
    expect(s.wall.check).toHaveBeenCalledTimes(1);
    expect(s.open).not.toHaveBeenCalled();
    expect(s.corpus.entrySetup).not.toHaveBeenCalled();
    expect(s.journal.ofType('INTENT_SKIPPED')[0].payload).toMatchObject({ reason: 'ENTRIES_DRY_RUN' });
  });

  it('journal mode writes no corpus row for an ordinary skip either (J9: the dry-run switch, not a trading mode)', async () => {
    const s = setup({ mode: 'journal', blocks: adaptiveSeedBlocks() });
    const [out] = await s.intake.process(hit({ scanName: 'any scan', score: 70 }), ist('2026-10-13', '12:00'));
    expect(out).toMatchObject({ kind: 'SKIPPED', reason: 'MIN_SCORE' });
    expect(s.corpus.entrySetup).not.toHaveBeenCalled();
  });

  it('a verdict quantity the wall could not have produced (0, or above the request) opens nothing (fail closed)', async () => {
    for (const qty of [0, 401]) {
      const s = setup({ verdict: verdict({ verdict: 'RESIZE', qty }) });
      const [out] = await s.intake.process(hit(), NOW);
      expect(out).toMatchObject({ kind: 'SKIPPED', reason: 'RISK_REJECT' });
      expect(s.open).not.toHaveBeenCalled();
    }
  });

  it('a corpus failure never affects the entry', async () => {
    const s = setup();
    s.corpus.entrySetup.mockRejectedValueOnce(new Error('corpus down'));
    expect((await s.intake.process(hit(), NOW))[0]).toMatchObject({ kind: 'OPENED' });
  });

  it('a throwing journal or duplicate check skips that selection and never throws', async () => {
    const s = setup({ history: { intentSeen: jest.fn().mockRejectedValue(new Error('db down')) } });
    await expect(s.intake.process(hit(), NOW)).resolves.toEqual([]);
    expect(s.open).not.toHaveBeenCalled();
    const j = setup();
    jest.spyOn(j.journal, 'record').mockImplementation(() => { throw new Error('journal broke'); });
    await expect(j.intake.process(hit(), NOW)).resolves.toEqual([]);
    expect(j.open).not.toHaveBeenCalled();
  });

  it('a wall REJECT is RISK_REJECT with the codes; the corpus records the skip', async () => {
    const s = setup({ verdict: verdict({ verdict: 'REJECT', qty: 0, reasons: [{ code: 'KILL_SWITCH', message: 'the kill switch is on: no new entries' }] }) });
    const [out] = await s.intake.process(hit(), NOW);
    expect(out).toMatchObject({ kind: 'SKIPPED', reason: 'RISK_REJECT', detail: 'KILL_SWITCH: the kill switch is on: no new entries' });
    expect(s.open).not.toHaveBeenCalled();
    expect(s.corpus.entrySetup).toHaveBeenCalledWith(expect.objectContaining({ decision: { taken: false, reason: 'RISK_REJECT: KILL_SWITCH: the kill switch is on: no new entries' } }));
  });

  it('MIN_SCORE is journaled before any price read (Adaptive-Stop at 12:00 needs 75)', async () => {
    const s = setup({ blocks: adaptiveSeedBlocks() });
    const [out] = await s.intake.process(hit({ scanName: 'any scan', score: 70 }), ist('2026-10-13', '12:00'));
    expect(out).toMatchObject({ kind: 'SKIPPED', reason: 'MIN_SCORE' });
    expect(s.journal.types()).toEqual(['ALERT_RECEIVED', 'INTENT_SKIPPED']);
    expect(s.market.freshPrice).not.toHaveBeenCalled();
  });

  it('cooldown and last loss are checked before the price; an unknown last trade fails closed', async () => {
    const cool = setup({ history: { lastOpenedAt: jest.fn().mockResolvedValue(ist('2026-10-13', '10:00')) } });
    expect((await cool.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'COOLDOWN' });
    expect(cool.market.freshPrice).not.toHaveBeenCalled();
    const lost = setup({ history: { lastClosedNetToday: jest.fn().mockResolvedValue(-120.5) } });
    expect((await lost.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'LAST_LOSS' });
    const unknown = setup({ history: { lastClosedNetToday: jest.fn().mockResolvedValue('UNKNOWN') } });
    expect((await unknown.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'HISTORY_UNKNOWN' });
  });

  it('no price source and a stale entry skip; the watch is always released', async () => {
    const none = setup({ price: { ok: false, reason: 'NO_PRICE_SOURCE', detail: 'owner-only hub' } });
    expect((await none.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'NO_PRICE_SOURCE' });
    expect(none.market.release).toHaveBeenCalledTimes(1);
    const stale = setup({ price: { ok: true, ltp: 505.5, at: NOW.getTime() } });
    expect((await stale.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'STALE_ENTRY', detail: 'moved 1.10% past the alert price ₹500 (max 1%)' });
    expect(stale.market.release).toHaveBeenCalledTimes(1);
  });

  it('Adaptive-Stop with no candles: the gate fails open as the seed says (O6) and the stop floors at minPct (O7)', async () => {
    const s = setup({ blocks: adaptiveSeedBlocks(), strategyKey: 'adaptive-stop', verdict: verdict({ qty: 200, requestedQty: 200 }) });
    const [out] = await s.intake.process(hit({ scanName: 'any scan', score: 70 }), NOW);
    expect(out).toMatchObject({ kind: 'OPENED', qty: 200 });
    expect(s.wall.check.mock.calls[0][0]).toMatchObject({ refPrice: 500, stopPrice: 496, qty: 200 }); // 0.8 % floor; ₹800 ÷ ₹4
    const setupRow = s.corpus.entrySetup.mock.calls[0][0];
    expect(setupRow.evidence).toMatchObject({ atrSource: 'none', stopPct: 0.8, gates: [expect.objectContaining({ pass: true, skipped: true })] });
  });

  describe('market-behaviour gate (MBM M3)', () => {
    const mbmBlocks = (skipRegimes = 'QUIET') => ({
      ...plainBlocks(),
      filters: { ...plainBlocks().filters, gates: [{ kind: 'evaluator' as const, evaluatorKey: 'market-behaviour', params: { skipRegimes, horizon: 'auto' } }] },
    });
    const quiet = {
      instrument: 'NIFTY', status: 'ok', asOf: '2026-10-13T04:59:00Z', featureSet: 'fs1', modelIds: { '60m': 'm60' },
      horizons: { '60m': { p: 0.12, regime: 'QUIET', q25Bp: 20, q50Bp: 28, q75Bp: 35 } },
    };
    const mbm = (gate: string, answer: unknown = quiet) => ({
      config: parseMbmConfig({ MBM_ENABLED: 'observe', MBM_ENTRY_GATE: gate, MBM_FEED_USER_ID: 'o' }),
      client: { behaviour: jest.fn().mockResolvedValue(answer) },
    });
    const niftyHit = () => hit({ symbol: 'NIFTY', tradingSymbol: 'NIFTY', exchange: 'NSE' });

    it('observe: a QUIET NIFTY entry still opens; the corpus row carries features / featureSet / mlScore', async () => {
      const m = mbm('observe');
      const s = setup({ blocks: mbmBlocks(), mbm: m });
      expect((await s.intake.process(niftyHit(), NOW))[0]).toMatchObject({ kind: 'OPENED' });
      expect(m.client.behaviour).toHaveBeenCalledTimes(1);
      expect(m.client.behaviour).toHaveBeenCalledWith('NIFTY');
      const row = s.corpus.entrySetup.mock.calls[0][0];
      expect(row.evidence.gates[0]).toMatchObject({ key: 'market-behaviour', pass: true, detail: { wouldSkip: true, regime: 'QUIET', p: 0.12 } });
      expect(row.mbm).toEqual({
        features: { instrument: 'NIFTY', horizon: '60m', regime: 'QUIET', p: 0.12, rangeBp: [20, 35], q50Bp: 28, asOf: '2026-10-13T04:59:00Z', modelId: 'm60', wouldSkip: true, mode: 'observe' },
        featureSet: 'fs1',
        mlScore: 0.12,
      });
    });

    it('on: a QUIET NIFTY entry is skipped as GATE, and the skip row still carries the MBM answer', async () => {
      const s = setup({ blocks: mbmBlocks(), mbm: mbm('on') });
      expect((await s.intake.process(niftyHit(), NOW))[0]).toMatchObject({ kind: 'SKIPPED', reason: 'GATE' });
      expect(s.corpus.entrySetup.mock.calls[0][0].mbm).toMatchObject({ mlScore: 0.12 });
    });

    it('a non-NIFTY entry, an absent answer, and MBM_ENABLED=off all open with no mbm on the row', async () => {
      const cases = [
        { m: mbm('on'), h: hit() },
        { m: mbm('on', { status: 'absent' }), h: niftyHit() },
        { m: { config: parseMbmConfig({ MBM_ENTRY_GATE: 'on' }), client: { behaviour: jest.fn() } }, h: niftyHit() },
      ];
      for (const c of cases) {
        const s = setup({ blocks: mbmBlocks(), mbm: c.m });
        expect((await s.intake.process(c.h, NOW))[0]).toMatchObject({ kind: 'OPENED' });
        expect('mbm' in s.corpus.entrySetup.mock.calls[0][0]).toBe(false);
      }
    });
  });

  it('an unknown gate key is GATE_UNKNOWN; settings missing is PAPER_SETTINGS_MISSING; a tiny budget is SIZE_ZERO', async () => {
    const blocks = { ...plainBlocks(), filters: { ...plainBlocks().filters, gates: [{ kind: 'evaluator' as const, evaluatorKey: 'nope', params: {} }] } };
    expect((await setup({ blocks }).intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'GATE_UNKNOWN' });
    const noSettings = setup();
    noSettings.defaults.settings.mockResolvedValueOnce({ ok: false, missing: ['intradayLeverage@CASH_INTRADAY'] });
    expect((await noSettings.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'PAPER_SETTINGS_MISSING' });
    const tiny = { ...plainBlocks(), sizing: { kind: 'notionalRupees' as const, amount: 100 } };
    expect((await setup({ blocks: tiny }).intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'SIZE_ZERO' });
  });

  it('openPosition refusing is OPEN_REFUSED; any throw inside the pipeline is INTERNAL_ERROR, never thrown', async () => {
    const refused = setup({ open: jest.fn().mockRejectedValue(new ConflictException('an active core position already exists')) });
    expect((await refused.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'OPEN_REFUSED' });
    const broken = setup({ history: { lastOpenedAt: jest.fn().mockRejectedValue(new Error('db down')) } });
    await expect(broken.intake.process(hit(), NOW)).resolves.toEqual([expect.objectContaining({ kind: 'SKIPPED', reason: 'INTERNAL_ERROR', detail: 'db down' })]);
  });
});

describe('CoreEntryIntake — idempotence and backpressure (Review Focus 1, 2)', () => {
  it('the same hit twice opens one position and journals once', async () => {
    const s = setup();
    await s.intake.process(hit(), NOW);
    const [again] = await s.intake.process(hit(), NOW);
    expect(again).toMatchObject({ kind: 'DUPLICATE' });
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.journal.ofType('ALERT_RECEIVED')).toHaveLength(1);
  });

  it(`a full backlog (${INTAKE_MAX_PENDING}) drops the hit and never throws`, () => {
    const s = setup();
    s.selections.listEnabledPaper.mockReturnValue(new Promise(() => undefined)); // the first hit never finishes
    for (let i = 0; i < INTAKE_MAX_PENDING + 2; i += 1) expect(() => s.intake.accept(hit({ alertId: `a${i}` }))).not.toThrow();
    expect(s.intake.status()).toMatchObject({ pending: INTAKE_MAX_PENDING, dropped: 1 });
  });

  it('accepted hits are processed in order, one at a time', async () => {
    const s = setup();
    s.intake.accept(hit({ alertId: 'a1' }));
    s.intake.accept(hit({ alertId: 'a2', token: '1594', tradingSymbol: 'INFY-EQ', symbol: 'INFY' }));
    await s.intake.idle();
    expect(s.open.mock.calls.map((c) => c[0].intent.symbol)).toEqual(['RELIANCE-EQ', 'INFY-EQ']);
  });
});

describe('CoreEntryIntake — alert age (review fix 2: stale / re-processed alerts never open)', () => {
  const at = (msBeforeNow: number) => new Date(NOW.getTime() - msBeforeNow);

  it('an alert older than the max age (default 180 s) is STALE_ALERT: journaled, no price read, no order', async () => {
    const s = setup();
    const [out] = await s.intake.process(hit({ alertAt: at(180_001) }), NOW);
    expect(out).toMatchObject({ kind: 'SKIPPED', reason: 'STALE_ALERT' });
    expect(s.open).not.toHaveBeenCalled();
    expect(s.wall.check).not.toHaveBeenCalled();
    expect(s.market.freshPrice).not.toHaveBeenCalled();
    expect(s.journal.types()).toEqual(['ALERT_RECEIVED', 'INTENT_SKIPPED']);
    expect(s.journal.entries[1].payload).toMatchObject({ reason: 'STALE_ALERT' });
  });

  it('an alert whose creation time is unknown fails closed (STALE_ALERT)', async () => {
    const s = setup();
    const [out] = await s.intake.process(hit({ alertAt: null }), NOW);
    expect(out).toMatchObject({ kind: 'SKIPPED', reason: 'STALE_ALERT' });
    expect(s.open).not.toHaveBeenCalled();
  });

  it('a fresh alert (inside the max age) proceeds and opens', async () => {
    const s = setup();
    const [out] = await s.intake.process(hit({ alertAt: at(179_000) }), NOW);
    expect(out).toMatchObject({ kind: 'OPENED' });
  });

  it('the max age is configurable', async () => {
    const s = setup({ maxAlertAgeMs: 60_000 });
    const [out] = await s.intake.process(hit({ alertAt: at(61_000) }), NOW);
    expect(out).toMatchObject({ kind: 'SKIPPED', reason: 'STALE_ALERT' });
  });

  it('an alert that ages past the max while it is being processed does not open (checked again before the order)', async () => {
    const s = setup();
    s.defaults.settings.mockImplementationOnce(async () => {
      jest.setSystemTime(NOW.getTime() + 120_000); // gates / candles took two minutes
      return { ok: true, settings: paperSettings() };
    });
    const [out] = await s.intake.process(hit({ alertAt: at(90_000) }), NOW);
    expect(out).toMatchObject({ kind: 'SKIPPED', reason: 'STALE_ALERT' });
    expect(s.open).not.toHaveBeenCalled();
  });
});
