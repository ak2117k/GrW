import { pairId } from './limits/limit-keys';
import { checkRisk, decideDailyLoss, exposureOf, requiredLimitPairs } from './risk-wall';
import type { RiskVerdict } from './risk-wall.types';
import {
  ctxFixture,
  intentFixture,
  limitsFixture,
  mtfIntent,
  NOW,
  optionIntent,
  positionFixture,
  stateFixture,
} from './testing/risk-fixtures';

const codes = (v: RiskVerdict) => v.reasons.map((r) => r.code);
const at = (istHhmm: string) => {
  const [h, m] = istHhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 12, h, m) - 5.5 * 3600_000);
};
const deployed = (cash: number | null, mtf: number | null = 0, opt: number | null = 0) =>
  stateFixture({ deployedCapital: { CASH_INTRADAY: cash, MTF: mtf, OPTIONS_BUY: opt } });

describe('checkRisk: allow, snapshot, exits', () => {
  it('allows an entry within every limit and returns the limits, state and daily-loss decision it used', () => {
    const v = checkRisk(intentFixture(), ctxFixture());
    expect(v).toMatchObject({
      intentId: 'int_1', userId: 'user_A', intentKind: 'ENTRY', verdict: 'ALLOW',
      requestedQty: 50, qty: 50, killSwitchActive: false, checkedAt: NOW.toISOString(),
    });
    expect(codes(v)).toEqual(['WITHIN_LIMITS']);
    expect(v.limits).toHaveLength(21);
    expect(v.limits[0]).toEqual({ key: 'maxDailyLoss', scope: 'ALL', value: '5000.00', rowId: 'lim_maxDailyLoss@ALL', effectiveFrom: '2026-10-09T03:45:00.000Z', source: 'USER' });
    expect(v.state).toEqual({
      asOf: NOW.toISOString(), realisedPnlToday: '0.00', openPnl: '0.00', tradesToday: 0, openPositions: 0,
      openPositionsByVehicle: { CASH_INTRADAY: 0, MTF: 0, OPTIONS_BUY: 0 },
      deployedCapital: { CASH_INTRADAY: '0.00', MTF: '0.00', OPTIONS_BUY: '0.00' },
      dailyLossLatched: false,
    });
    expect(v.dailyLoss).toEqual({ status: 'OK', lossRupees: '0.00', limitRupees: '5000.00', action: 'BLOCK_ENTRIES', squareOffCore: false });
  });

  it('allows MTF and option entries within their limits', () => {
    expect(checkRisk(mtfIntent(), ctxFixture())).toMatchObject({ verdict: 'ALLOW', qty: 10 });
    expect(checkRisk(optionIntent(), ctxFixture())).toMatchObject({ verdict: 'ALLOW', qty: 75 });
  });

  it('exits pass even with the kill switch on, no limits, a closed session and unknown P&L', () => {
    const v = checkRisk(
      { kind: 'EXIT', intentId: 'x_1', userId: 'user_A', positionId: 'pos_1', qty: 30 },
      ctxFixture({ killSwitchActive: true, limits: [], sessionOpen: false, state: stateFixture({ openPnl: null }) }),
    );
    expect(v).toMatchObject({ verdict: 'ALLOW', qty: 30, requestedQty: 30, intentKind: 'EXIT', limits: [], state: null });
    expect(codes(v)).toEqual(['EXIT_NOT_CHECKED']);
  });
});

describe('checkRisk: fails closed', () => {
  it('the kill switch rejects every entry', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ killSwitchActive: true }));
    expect(v).toMatchObject({ verdict: 'REJECT', qty: 0, killSwitchActive: true });
    expect(codes(v)).toEqual(['KILL_SWITCH']);
  });

  it('fails closed on every limit the vehicle needs, and only those', () => {
    expect(requiredLimitPairs('CASH_INTRADAY')).toHaveLength(10);
    expect(requiredLimitPairs('MTF')).toHaveLength(12);
    expect(requiredLimitPairs('OPTIONS_BUY')).toHaveLength(11);
    for (const p of requiredLimitPairs('CASH_INTRADAY')) {
      const v = checkRisk(intentFixture(), ctxFixture({ limits: limitsFixture({ [pairId(p)]: null }) }));
      expect(v.verdict).toBe('REJECT');
      expect(v.reasons).toContainEqual({ code: 'LIMIT_MISSING', message: `no ${p.key} limit is in force for ${p.scope}` });
    }
    const others = limitsFixture({ 'mtfMaxLeverage@MTF': null, 'optionsMaxPremiumPerTrade@OPTIONS_BUY': null, 'maxCapitalDeployed@MTF': null });
    expect(checkRisk(intentFixture(), ctxFixture({ limits: others })).verdict).toBe('ALLOW');
  });

  it('rejects on a stale price, an unpriced open position or a closed session', () => {
    expect(codes(checkRisk(intentFixture({ refPriceFresh: false }), ctxFixture()))).toEqual(['STALE_PRICE']);
    const unpriced = stateFixture({ openPositions: [positionFixture({ priced: false })] });
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: unpriced })))).toEqual(['UNPRICED_POSITION']);
    expect(codes(checkRisk(intentFixture(), ctxFixture({ sessionOpen: false })))).toEqual(['SESSION_CLOSED']);
  });

  it('unknown P&L rejects but never squares off', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ openPnl: null }) }));
    expect(v.verdict).toBe('REJECT');
    expect(codes(v)).toEqual(['PNL_UNKNOWN']);
    expect(v.dailyLoss).toEqual({ status: 'UNKNOWN', lossRupees: null, limitRupees: '5000.00', action: 'BLOCK_ENTRIES', squareOffCore: false });
    const bso = limitsFixture({ 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' });
    expect(decideDailyLoss(bso, stateFixture({ realisedPnlToday: NaN })).squareOffCore).toBe(false);
  });

  it('a malformed limit value rejects instead of throwing', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ limits: limitsFixture({ 'maxDailyLoss@ALL': 'lots' }) }));
    expect(v).toMatchObject({ verdict: 'REJECT', qty: 0 });
    expect(codes(v)).toEqual(['CONTEXT_UNAVAILABLE']);
  });

  it('rejects an entry with no stop (risk unknown) or unknown deployed capital', () => {
    expect(codes(checkRisk(intentFixture({ stopPrice: null }), ctxFixture()))).toEqual(['RISK_UNKNOWN']);
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: deployed(null) })))).toEqual(['STATE_UNKNOWN']);
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ tradesToday: NaN }) })))).toEqual(['STATE_UNKNOWN']);
  });

  it('rejects a malformed intent and never resizes it', () => {
    const bad = [
      intentFixture({ qty: NaN }),
      intentFixture({ qty: 0 }),
      optionIntent({ qty: 100 }),
      intentFixture({ stopPrice: 2600 }),
      intentFixture({ exchange: 'NFO' }),
      intentFixture({ optionType: 'CE' }),
      optionIntent({ optionType: null }),
      mtfIntent({ mtfLeverage: null }),
      intentFixture({ capitalPerUnit: 0 }),
      intentFixture({ symbol: ' ' }),
    ];
    for (const intent of bad) {
      const v = checkRisk(intent, ctxFixture());
      expect(v.verdict).toBe('REJECT');
      expect(codes(v)).toContain('INVALID_INTENT');
    }
  });

  it('collects every failing reason, not just the first', () => {
    const v = checkRisk(intentFixture({ refPriceFresh: false }), ctxFixture({ killSwitchActive: true, sessionOpen: false }));
    expect(codes(v)).toEqual(['KILL_SWITCH', 'SESSION_CLOSED', 'STALE_PRICE']);
  });
});

describe('checkRisk: daily loss (spec §5.3)', () => {
  const withPnl = (realised: number, open: number) =>
    checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ realisedPnlToday: realised, openPnl: open }) }));

  it('rejects once realised + open loss reaches maxDailyLoss, not before', () => {
    expect(withPnl(-3000, -1999.99).verdict).toBe('ALLOW');
    const v = withPnl(-3000, -2000);
    expect(v.verdict).toBe('REJECT');
    expect(codes(v)).toEqual(['DAILY_LOSS']);
    expect(v.dailyLoss).toEqual({ status: 'BREACHED', lossRupees: '5000.00', limitRupees: '5000.00', action: 'BLOCK_ENTRIES', squareOffCore: false });
  });

  it('stays blocked for the rest of the session once latched, even after P&L recovers', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ realisedPnlToday: 1000, dailyLossLatched: true }) }));
    expect(codes(v)).toEqual(['DAILY_LOSS']);
    expect(v.dailyLoss?.status).toBe('BREACHED');
  });

  it('only BLOCK_AND_SQUARE_OFF asks M4 to exit every core position', () => {
    const lossState = stateFixture({ realisedPnlToday: -6000 });
    expect(decideDailyLoss(limitsFixture(), lossState).squareOffCore).toBe(false);
    expect(decideDailyLoss(limitsFixture({ 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' }), lossState)).toEqual({
      status: 'BREACHED', lossRupees: '6000.00', limitRupees: '5000.00', action: 'BLOCK_AND_SQUARE_OFF', squareOffCore: true,
    });
    expect(decideDailyLoss(limitsFixture({ 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' }), stateFixture()).squareOffCore).toBe(false);
  });

  it('a profit or a flat day never breaches, even with a ₹0 limit; any loss does', () => {
    const zero = limitsFixture({ 'maxDailyLoss@ALL': '0.00' });
    expect(decideDailyLoss(zero, stateFixture()).status).toBe('OK');
    expect(decideDailyLoss(zero, stateFixture({ realisedPnlToday: 500 })).status).toBe('OK');
    expect(decideDailyLoss(zero, stateFixture({ openPnl: -0.01 })).status).toBe('BREACHED');
  });

  describe('owner ruling 2026-10-12: a realised loss past the limit breaches even with open P&L unknown', () => {
    const bso = limitsFixture({ 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' });
    const blind = (realised: number) => stateFixture({ realisedPnlToday: realised, openPnl: null, openPositions: [positionFixture({ priced: false })] });

    it('realised loss at exactly the limit (>=) with a blind position is BREACHED and asks for the square-off', () => {
      expect(decideDailyLoss(bso, blind(-5000))).toEqual({
        status: 'BREACHED', lossRupees: '5000.00', limitRupees: '5000.00', action: 'BLOCK_AND_SQUARE_OFF', squareOffCore: true,
      });
      expect(decideDailyLoss(limitsFixture(), blind(-6000))).toEqual({
        status: 'BREACHED', lossRupees: '6000.00', limitRupees: '5000.00', action: 'BLOCK_ENTRIES', squareOffCore: false,
      });
    });

    it('realised loss under the limit with open P&L unknown stays UNKNOWN and never squares off', () => {
      expect(decideDailyLoss(bso, blind(-4999.99))).toEqual({
        status: 'UNKNOWN', lossRupees: null, limitRupees: '5000.00', action: 'BLOCK_AND_SQUARE_OFF', squareOffCore: false,
      });
      expect(decideDailyLoss(bso, blind(800)).status).toBe('UNKNOWN');
      expect(decideDailyLoss(bso, stateFixture({ realisedPnlToday: NaN, openPnl: -9000 })).status).toBe('UNKNOWN');
    });

    it('with a ₹0 limit any realised loss breaches; a flat realised day with open P&L unknown does not', () => {
      const zero = limitsFixture({ 'maxDailyLoss@ALL': '0.00' });
      expect(decideDailyLoss(zero, blind(-0.01)).status).toBe('BREACHED');
      expect(decideDailyLoss(zero, blind(0)).status).toBe('UNKNOWN');
    });

    it('the entry check still rejects: DAILY_LOSS (realised) when breached, PNL_UNKNOWN otherwise', () => {
      const breached = checkRisk(intentFixture(), ctxFixture({ state: blind(-5000) }));
      expect(breached.verdict).toBe('REJECT');
      expect(codes(breached)).toEqual(['UNPRICED_POSITION', 'DAILY_LOSS']);
      expect(breached.reasons[1].message).toBe("today's realised loss ₹5000.00 has reached the ₹5000.00 daily limit (open P&L unknown)");
      const under = checkRisk(intentFixture(), ctxFixture({ state: blind(-4000) }));
      expect(under.verdict).toBe('REJECT');
      expect(codes(under)).toEqual(['UNPRICED_POSITION', 'PNL_UNKNOWN']);
    });
  });

  it('a strategy at its own daily loss limit is blocked; another strategy is not', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ pnlTodayByStrategy: { cs_ungated: -2500 } }) }));
    expect(codes(v)).toEqual(['STRATEGY_DAILY_LOSS']);
    const other = checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ pnlTodayByStrategy: { cs_adaptive_stop: -2500 } }) }));
    expect(other.verdict).toBe('ALLOW');
    const unknown = checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ pnlTodayByStrategy: { cs_ungated: NaN } }) }));
    expect(codes(unknown)).toEqual(['PNL_UNKNOWN']);
  });
});

describe('checkRisk: counts, conflicts, time, vehicle rules', () => {
  it('rejects at maxTradesPerDay, not before', () => {
    expect(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ tradesToday: 19 }) })).verdict).toBe('ALLOW');
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ tradesToday: 20 }) })))).toEqual(['MAX_TRADES']);
  });

  it('counts open and pending positions against the total and the vehicle limits', () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((s, i) =>
      positionFixture({ positionId: `p${i}`, symbol: s, underlying: s, state: i === 0 ? 'PENDING_ENTRY' : 'OPEN' }),
    );
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ openPositions: five }) })))).toEqual([
      'MAX_OPEN_POSITIONS', 'MAX_OPEN_POSITIONS_VEHICLE',
    ]);
    const threeMtf = ['A', 'B', 'C'].map((s, i) => positionFixture({ positionId: `m${i}`, vehicle: 'MTF', symbol: s, underlying: s }));
    expect(codes(checkRisk(mtfIntent(), ctxFixture({ state: stateFixture({ openPositions: threeMtf }) })))).toEqual(['MAX_OPEN_POSITIONS_VEHICLE']);
    expect(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ openPositions: threeMtf }) })).verdict).toBe('ALLOW');
  });

  it('one core position per symbol per user', () => {
    const open = stateFixture({ openPositions: [positionFixture({ symbol: 'RELIANCE', underlying: 'RELIANCE', state: 'PENDING_ENTRY' })] });
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: open })))).toEqual(['CONFLICT_SAME_SYMBOL']);
  });

  it('never long and short on one underlying: a bought PE is short, a bought CE is long', () => {
    expect(exposureOf('OPTIONS_BUY', 'BUY', 'PE')).toBe('SHORT');
    expect(exposureOf('OPTIONS_BUY', 'BUY', 'CE')).toBe('LONG');
    expect(exposureOf('CASH_INTRADAY', 'SELL', null)).toBe('SHORT');
    const pe = positionFixture({ vehicle: 'OPTIONS_BUY', symbol: 'RELIANCE26OCT2500PE', underlying: 'RELIANCE', direction: 'SHORT' });
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ openPositions: [pe] }) })))).toEqual(['CONFLICT_OPPOSITE_DIRECTION']);
    const ce = positionFixture({ vehicle: 'OPTIONS_BUY', symbol: 'RELIANCE26OCT2500CE', underlying: 'RELIANCE', direction: 'LONG' });
    expect(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ openPositions: [ce] }) })).verdict).toBe('ALLOW');
  });

  it('rejects at or after the vehicle’s lastEntryTime and squareOffTime (IST)', () => {
    expect(checkRisk(intentFixture(), ctxFixture({ now: at('14:59') })).verdict).toBe('ALLOW');
    expect(codes(checkRisk(intentFixture(), ctxFixture({ now: at('15:00') })))).toEqual(['AFTER_LAST_ENTRY']);
    expect(codes(checkRisk(optionIntent(), ctxFixture({ now: at('14:30') })))).toEqual(['AFTER_LAST_ENTRY']);
    const late = limitsFixture({ 'lastEntryTime@CASH_INTRADAY': '15:29' });
    expect(codes(checkRisk(intentFixture(), ctxFixture({ now: at('15:15'), limits: late })))).toEqual(['AFTER_SQUARE_OFF']);
  });

  it('MTF is long only and capped by mtfMaxLeverage; options are buy only', () => {
    expect(codes(checkRisk(mtfIntent({ side: 'SELL', stopPrice: 4120 }), ctxFixture()))).toEqual(['VEHICLE_SIDE']);
    expect(codes(checkRisk(mtfIntent({ mtfLeverage: 2.5 }), ctxFixture()))).toEqual(['MTF_LEVERAGE']);
    expect(codes(checkRisk(optionIntent({ side: 'SELL', stopPrice: 150 }), ctxFixture()))).toEqual(['VEHICLE_SIDE']);
  });
});

describe('checkRisk: sizing reduces only', () => {
  it('resizes down to the risk cap, and leaves a smaller request alone', () => {
    const v = checkRisk(intentFixture({ qty: 100 }), ctxFixture()); // 3000 / 37.5 = 80
    expect(v).toMatchObject({ verdict: 'RESIZE', qty: 80, requestedQty: 100 });
    expect(codes(v)).toEqual(['CAP_RISK_PER_TRADE']);
    expect(checkRisk(intentFixture({ qty: 10 }), ctxFixture())).toMatchObject({ verdict: 'ALLOW', qty: 10 });
  });

  it('resizes to the vehicle’s remaining capital', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ state: deployed(990000) })); // 10,000 / 500 = 20
    expect(v).toMatchObject({ verdict: 'RESIZE', qty: 20 });
    expect(codes(v)).toEqual(['CAP_CAPITAL_DEPLOYED']);
  });

  it('rounds options down to whole lots and applies the premium cap', () => {
    // premium: 50,000 / 120 = 416 units → 5 lots = 375; risk: 3000 / 1 = 3000; capital: 100,000 / 120 = 833 → 11 lots
    const v = checkRisk(optionIntent({ qty: 750, stopPrice: 119 }), ctxFixture());
    expect(v).toMatchObject({ verdict: 'RESIZE', qty: 375 });
    expect(codes(v)).toEqual(['CAP_OPTIONS_PREMIUM']);
  });

  it('rejects when a cap leaves less than one lot, or no capital is left', () => {
    const tooRisky = checkRisk(optionIntent({ stopPrice: 50 }), ctxFixture()); // 3000 / 70 = 42 units < 75
    expect(tooRisky).toMatchObject({ verdict: 'REJECT', qty: 0 });
    expect(codes(tooRisky)).toEqual(['CAP_RISK_PER_TRADE']);
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: deployed(1_000_000) })))).toEqual(['CAP_CAPITAL_DEPLOYED']);
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: deployed(1_200_000) })))).toEqual(['CAP_CAPITAL_DEPLOYED']);
  });

  it('never returns more than was asked, whatever the caps', () => {
    for (const qty of [1, 7, 80, 81, 5000]) {
      for (const cash of [0, 999_500, 2_000_000]) {
        const v = checkRisk(intentFixture({ qty }), ctxFixture({ state: deployed(cash) }));
        expect(v.qty).toBeLessThanOrEqual(qty);
        if (v.verdict === 'REJECT') expect(v.qty).toBe(0);
        if (v.verdict === 'RESIZE') expect(v.qty).toBeLessThan(qty);
        if (v.verdict === 'ALLOW') expect(v.qty).toBe(qty);
      }
    }
  });
});

describe('checkRisk: reconciliation block (M5 J12, O10)', () => {
  it('blocks the blocked strategy only; a user-wide block blocks every strategy', () => {
    const blocked = ctxFixture({ state: stateFixture({ reconBlocked: { all: false, strategyIds: ['cs_ungated'] } }) });
    expect(codes(checkRisk(intentFixture({ strategyId: 'cs_ungated' }), blocked))).toEqual(['RECON_BLOCKED']);
    expect(checkRisk(intentFixture({ strategyId: 'cs_adaptive_stop', strategyVersionId: 'csv_adaptive_stop_v1' }), blocked).verdict).not.toBe('REJECT');
    const all = ctxFixture({ state: stateFixture({ reconBlocked: { all: true, strategyIds: [] } }) });
    expect(codes(checkRisk(intentFixture({ strategyId: 'cs_adaptive_stop' }), all))).toContain('RECON_BLOCKED');
  });
});

describe('checkRisk: exits are never blocked by M5 inputs (recon block, daily-loss latch)', () => {
  it('an EXIT passes with a user-wide recon block and the daily-loss latch set', () => {
    const v = checkRisk(
      { kind: 'EXIT', intentId: 'x_1', userId: 'user_A', positionId: 'pos_1', qty: 30 },
      ctxFixture({ state: stateFixture({ reconBlocked: { all: true, strategyIds: ['cs_ungated'] }, dailyLossLatched: true }) }),
    );
    expect(v).toMatchObject({ verdict: 'ALLOW', qty: 30, intentKind: 'EXIT' });
    expect(codes(v)).toEqual(['EXIT_NOT_CHECKED']);
  });
});

describe('checkRisk: an unreadable journal (M5)', () => {
  it('rejects every entry JOURNAL_UNAVAILABLE; an exit still passes', () => {
    const ctx = ctxFixture({ state: stateFixture({ journalUnreadable: true }) });
    expect(codes(checkRisk(intentFixture(), ctx))).toEqual(['JOURNAL_UNAVAILABLE']);
    expect(codes(checkRisk({ kind: 'EXIT', intentId: 'x_1', userId: 'user_A', positionId: 'pos_1', qty: 30 }, ctx))).toEqual(['EXIT_NOT_CHECKED']);
  });
});
