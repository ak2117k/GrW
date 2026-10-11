import { usPhaseAt } from './market-cues.freshness';

describe('usPhaseAt — is a US index value mid-session or a completed close?', () => {
  it('a quote time inside 09:30–16:00 New York on a weekday is intraday', () => {
    expect(usPhaseAt('2026-10-12T18:10:00.000Z')).toBe('intraday'); // Mon 14:10 EDT = 23:40 IST
    expect(usPhaseAt('2026-10-12T13:30:00.000Z')).toBe('intraday'); // 09:30 EDT, the open
  });
  it('after 16:00 ET, before 09:30 ET, or at a weekend it is a close', () => {
    expect(usPhaseAt('2026-10-09T21:15:59.000Z')).toBe('close'); // Fri 17:15 EDT
    expect(usPhaseAt('2026-10-12T20:00:00.000Z')).toBe('close'); // 16:00 EDT exactly
    expect(usPhaseAt('2026-10-12T13:00:00.000Z')).toBe('close'); // 09:00 EDT, pre-market
    expect(usPhaseAt('2026-10-10T15:00:00.000Z')).toBe('close'); // Saturday
  });
  it('uses New York time, so winter (EST) shifts the hours', () => {
    expect(usPhaseAt('2026-12-14T14:45:00.000Z')).toBe('intraday'); // 09:45 EST
    expect(usPhaseAt('2026-12-14T14:15:00.000Z')).toBe('close'); // 09:15 EST
  });
  it('a bare session date is a close', () => {
    expect(usPhaseAt('2026-10-09')).toBe('close');
  });
});
