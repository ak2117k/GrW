import { buildBoard, callItem, ideaItem, setupItem, watchItem, type CallRow, type IdeaRow, type SetupRow, type WatchRow } from './signal-board';
import { boardWindow } from '../services/signal-board.service';

const at = (iso: string) => new Date(iso);

const setup = (o: Partial<SetupRow> = {}): SetupRow => ({
  id: 'st1',
  created_at: at('2026-10-27T18:20:08Z'),
  symbol: 'SAIL',
  instrument: 'SAIL23NOV26FUT (NFO futures, near month)',
  side: 'LONG',
  entry_rule: 'buy above the first 15m high',
  entry_ref: 171.2,
  stop: 165.06,
  target1: 180.41,
  target2: 186.54,
  outcome_status: null,
  outcome_r: null,
  idea_rationale: 'steel prices up',
  ...o,
});

const idea = (o: Partial<IdeaRow> = {}): IdeaRow => ({
  id: 'i1',
  created_at: at('2026-10-27T18:01:54Z'),
  symbol: 'LT',
  idea: 'NO_TRADE',
  rationale: 'gap-up already priced',
  what_to_do: 'Avoid chasing the gap-up',
  move_bp: null,
  ...o,
});

const call = (o: Partial<CallRow> = {}): CallRow => ({
  signal_id: 'sg1',
  created_at: at('2026-10-28T04:10:00Z'),
  channel: 'Stock Gainers',
  underlying: 'GOLD',
  tradingsymbol: 'GOLD25NOV26147000CE',
  side: 'BUY',
  entry_type: 'AT',
  entry_low: 250,
  entry_high: 250,
  sl: null,
  targets: [],
  raw_text: 'GOLD 147000 CE BUY AT 250',
  outcome_status: null,
  decision: 'PAPER',
  skip_reason: null,
  plan: { tradingsymbol: 'GOLD25NOV26147000CE', limitPrice: 251, sl: 230, slSource: 'engine', targets: [290, 320], targetSource: 'engine' },
  judge: { reasons: ['room 300 pts to the call wall', 'trend up'] },
  ai_check: null,
  ...o,
});

const watch = (o: Partial<WatchRow> = {}): WatchRow => ({
  id: 'w1',
  created_at: at('2026-10-28T03:50:00Z'),
  channel: 'Breakout Hub',
  underlying: 'TATASTEEL',
  side: 'BUY',
  level: 172,
  status: 'ACTIVE',
  last_ltp: 170.4,
  reason: null,
  ...o,
});

describe('signal board items', () => {
  it('a night setup: contract, levels, waiting until its outcome is filled', () => {
    const x = setupItem(setup());
    expect(x).toMatchObject({ source: 'NIGHT_SETUP', instrument: 'SAIL23NOV26FUT', side: 'BUY', entry: 171.2, sl: 165.06, targets: [180.41, 186.54], state: 'WAITING', status: 'PENDING', why: ['steel prices up'] });
    expect(setupItem(setup({ outcome_status: 'TARGET1', outcome_r: 1.5 }))).toMatchObject({ state: 'WON', result: { r: 1.5 } });
    expect(setupItem(setup({ outcome_status: 'STOP', outcome_r: -1 }))).toMatchObject({ state: 'LOST' });
    expect(setupItem(setup({ outcome_status: 'NOT_TRIGGERED' }))).toMatchObject({ state: 'SKIPPED' });
    expect(setupItem(setup({ outcome_status: 'TIME_EXIT', outcome_r: 0.02 }))).toMatchObject({ state: 'FLAT' });
  });

  it('a news idea is a view; CE / PE ideas carry a direction', () => {
    expect(ideaItem(idea())).toMatchObject({ source: 'NEWS_IDEA', state: 'VIEW', side: null, status: 'NO_TRADE', entryNote: 'Avoid chasing the gap-up' });
    expect(ideaItem(idea({ idea: 'PE_IDEA' })).side).toBe('SELL');
  });

  it('a Telegram call with no SL / target shows the engine ones, and the judge reasons', () => {
    const x = callItem(call());
    expect(x).toMatchObject({
      source: 'TELEGRAM',
      instrument: 'GOLD25NOV26147000CE',
      entry: 251,
      entryNote: 'at 250',
      sl: 230,
      slSource: 'engine',
      targets: [290, 320],
      targetSource: 'engine',
      state: 'OPEN',
      status: 'PAPER',
      why: ['room 300 pts to the call wall', 'trend up'],
    });
  });

  it('the channel\'s own SL / targets are shown as the channel\'s', () => {
    const x = callItem(call({ sl: 230, targets: [300, 350] }));
    expect(x).toMatchObject({ sl: 230, slSource: 'channel', targets: [300, 350], targetSource: 'channel' });
  });

  it('a skipped call says why; a closed learning trade carries its result and the AI check', () => {
    expect(callItem(call({ decision: 'SKIP', skip_reason: 'market_hours', judge: null, plan: null }))).toMatchObject({ state: 'SKIPPED', status: 'SKIP market_hours', why: ['market_hours'] });
    const won = callItem(call({ ai_check: { aiDecision: 'TAKE', movePct: 12.5, pnl: 3100, correct: true } }));
    expect(won).toMatchObject({ state: 'WON', result: { movePct: 12.5, pnl: 3100 }, aiCorrect: true });
  });

  it('a breakout watch waits while ACTIVE', () => {
    expect(watchItem(watch())).toMatchObject({ source: 'WATCH', state: 'WAITING', entry: 172, entryNote: 'breakout above 172 (last 170.4)' });
    expect(watchItem(watch({ status: 'EXPIRED' })).state).toBe('SKIPPED');
  });
});

describe('buildBoard', () => {
  it('merges every source newest first, hiding an idea that became a setup', () => {
    const b = buildBoard('2026-10-28', {
      setups: [setup()],
      ideas: [idea(), idea({ id: 'i2', symbol: 'SAIL', idea: 'CE_IDEA' })],
      ideaIdsWithSetup: new Set(['i2']),
      calls: [call()],
      watches: [watch()],
    });
    expect(b.items.map((x) => x.id)).toEqual(['call:sg1', 'watch:w1', 'setup:st1', 'idea:i1']);
    expect(b.counts).toEqual({ NIGHT_SETUP: 1, NEWS_IDEA: 1, TELEGRAM: 1, WATCH: 1 });
  });
});

describe('boardWindow', () => {
  it('opens at the previous day\'s 15:30 IST and closes at the day\'s end', () => {
    const w = boardWindow('2026-10-28');
    expect(w.from.toISOString()).toBe('2026-10-27T10:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-28T18:30:00.000Z');
  });
});
