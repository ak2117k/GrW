import { paperAlert, paperCause, paperEntryReason, paperSource, paperTags, PAPER_WHY_TAG } from './paper';

// 2026-11-12: NIFTY 24800 PE (LTP 43.5 vs the channel's 100) was refused by the live entry_tolerance
// gate and paper-traded — but labelled "no-funds" and "SIGNAL_TRADING=paper" while the account was live.
describe('paperCause — why a Telegram signal went to paper', () => {
  it('names a live gate refusal, with its detail', () => {
    const c = paperCause({
      trigger: 'paper_mode',
      mode: 'live',
      record: { liveGateBlocked: 'entry_tolerance', liveGateDetail: "LTP 43.5 is 56.5% below the channel's 100", aiDecision: 'TAKE', learnTaken: true },
    });
    expect(c.key).toBe('gate-entry_tolerance');
    expect(c.why).toContain('entry_tolerance');
    expect(c.why).toContain('56.5%');
  });

  it('names an AI skip on the learning track', () => {
    expect(paperCause({ trigger: 'paper_mode', mode: 'live', record: { learnTaken: true, aiDecision: 'SKIP', aiSkipReason: 'low_confidence' } })).toEqual({
      key: 'ai-skip',
      why: 'the AI judge did not take it (low_confidence) — learning paper',
    });
  });

  it('names the live allowlist route block', () => {
    const c = paperCause({ trigger: 'paper_mode', mode: 'live', record: { aiDecision: 'TAKE' }, routed: { reason: 'live_underlying', detail: 'X is not on SIGNAL_LIVE_UNDERLYINGS' } });
    expect(c).toEqual({ key: 'route-live_underlying', why: 'X is not on SIGNAL_LIVE_UNDERLYINGS' });
  });

  it('a gate refusal outranks the route block and the AI skip', () => {
    const c = paperCause({
      trigger: 'paper_mode',
      mode: 'live',
      record: { liveGateBlocked: 'sl_side', learnTaken: true, aiDecision: 'SKIP' },
      routed: { reason: 'live_kind', detail: 'x' },
    });
    expect(c.key).toBe('gate-sl_side');
  });

  it('paper mode, funds short and broker funds reject keep their own reasons', () => {
    expect(paperCause({ trigger: 'paper_mode', mode: 'paper', record: { liveGateBlocked: 'entry_tolerance' } }).key).toBe('paper-mode');
    expect(paperCause({ trigger: 'funds_check', mode: 'live' }).key).toBe('no-funds');
    expect(paperCause({ trigger: 'broker_reject', mode: 'live' }).key).toBe('broker-funds');
  });

  it('falls back to a neutral "paper" (never "no-funds") when nothing is recorded', () => {
    expect(paperCause({ trigger: 'paper_mode', mode: 'live', record: null }).key).toBe('paper');
  });
});

describe('paper labels carry the cause', () => {
  it('tags: no "no-funds" unless funds were the cause; the cause is tagged', () => {
    expect(paperTags('d1', undefined, false, 'gate-entry_tolerance')).toEqual(['telegram-signal', 'decision:d1', `${PAPER_WHY_TAG}gate-entry_tolerance`]);
    expect(paperTags('d1', undefined, false, 'no-funds')).toEqual(['telegram-signal', 'no-funds', 'decision:d1', `${PAPER_WHY_TAG}no-funds`]);
    // no cause given = the old label, unchanged
    expect(paperTags('d1')).toEqual(['telegram-signal', 'no-funds', 'decision:d1']);
  });

  it('source and entry reason name the cause', () => {
    expect(paperSource('gate-entry_tolerance')).toBe('telegram-signal / gate-entry_tolerance');
    expect(paperSource()).toBe('telegram-signal / no-funds');
    const plan = { limitPrice: 44, qty: 65, sl: 70, targets: [130] } as unknown as Parameters<typeof paperEntryReason>[0]['plan'];
    const r = paperEntryReason({ decisionId: 'd1', channel: 'C', what: 'BUY NIFTY 24800 PE', plan, why: 'live gate entry_tolerance refused it', source: paperSource('gate-entry_tolerance') });
    expect(r.startsWith('telegram-signal / gate-entry_tolerance (decision d1) — live gate entry_tolerance refused it.')).toBe(true);
  });

  it('the alert names the cause instead of "paper mode"', () => {
    const a = paperAlert({ required: null, available: null, what: 'BUY NIFTY 24800 PE', channel: 'C', result: 'ok', paperMode: true, cause: 'live gate entry_tolerance refused it' });
    expect(a.split('\n')[0]).toBe('PAPER (live gate entry_tolerance refused it) — BUY NIFTY 24800 PE (C)');
  });
});
