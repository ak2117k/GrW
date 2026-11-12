import { describe, expect, it } from 'vitest';
import { strategyLabel } from './strategyLabel';

describe('strategyLabel', () => {
  it('shows the real paper cause for Telegram signal paper trades', () => {
    expect(strategyLabel('TELEGRAM_SIGNAL_NO_FUNDS', ['telegram-signal', 'decision:d1', 'paper-why:gate-entry_tolerance'])).toBe('Telegram paper · price off the call');
    expect(strategyLabel('TELEGRAM_SIGNAL_NO_FUNDS', ['paper-why:no-funds'])).toBe('Telegram paper · no funds');
    expect(strategyLabel('TELEGRAM_SIGNAL_NO_FUNDS', ['paper-why:ai-skip'])).toBe('Telegram paper · AI skipped');
    expect(strategyLabel('TELEGRAM_SIGNAL_NO_FUNDS', ['paper-why:gate-some_new_check'])).toBe('Telegram paper · gate: some new check');
    expect(strategyLabel('TELEGRAM_SIGNAL_NO_FUNDS', ['paper-why:route-live_underlying'])).toBe('Telegram paper · not on live list');
  });

  it('older rows without a cause never claim "no funds"', () => {
    expect(strategyLabel('TELEGRAM_SIGNAL_NO_FUNDS', ['telegram-signal', 'no-funds', 'decision:d1'])).toBe('Telegram paper');
    expect(strategyLabel('TELEGRAM_SIGNAL_NO_FUNDS')).toBe('Telegram paper');
  });

  it('names the engine tracks and keeps the old kebab formatting', () => {
    expect(strategyLabel('ENGINE_ENTRY')).toBe('Entry engine');
    expect(strategyLabel('REENTRY_WATCH')).toBe('Re-entry watch');
    expect(strategyLabel('ema-crossover')).toBe('Ema Crossover');
  });
});
