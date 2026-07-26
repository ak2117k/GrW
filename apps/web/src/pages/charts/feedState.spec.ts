import { describe, it, expect } from 'vitest';
import { deriveBadge } from './feedState';

describe('deriveBadge', () => {
  it('shows Live when connected and ticking', () => {
    expect(
      deriveBadge({ feedState: 'live', marketOpen: true, brokerConnected: true })
        .label,
    ).toBe('Live');
  });

  it('shows Market closed outside hours', () => {
    expect(
      deriveBadge({
        feedState: 'closed',
        marketOpen: false,
        brokerConnected: true,
      }).label,
    ).toBe('Market closed');
  });

  it('shows Broker not connected when no creds', () => {
    expect(
      deriveBadge({
        feedState: 'error',
        marketOpen: true,
        brokerConnected: false,
      }).label,
    ).toBe('Broker not connected');
  });

  it('shows Reconnecting during a drop', () => {
    expect(
      deriveBadge({
        feedState: 'reconnecting',
        marketOpen: true,
        brokerConnected: true,
      }).label,
    ).toBe('Reconnecting');
  });

  it('shows Reconnecting while connecting', () => {
    expect(
      deriveBadge({
        feedState: 'connecting',
        marketOpen: true,
        brokerConnected: true,
      }).label,
    ).toBe('Reconnecting');
  });

  it('shows Delayed on feed error (broker connected, market open)', () => {
    expect(
      deriveBadge({ feedState: 'error', marketOpen: true, brokerConnected: true })
        .label,
    ).toBe('Delayed');
  });

  it('prioritises broker-not-connected over market-closed', () => {
    expect(
      deriveBadge({
        feedState: 'closed',
        marketOpen: false,
        brokerConnected: false,
      }).label,
    ).toBe('Broker not connected');
  });

  it('returns a tone for every branch', () => {
    const inputs = [
      { feedState: 'live', marketOpen: true, brokerConnected: true },
      { feedState: 'closed', marketOpen: false, brokerConnected: true },
      { feedState: 'error', marketOpen: true, brokerConnected: false },
      { feedState: 'reconnecting', marketOpen: true, brokerConnected: true },
      { feedState: 'error', marketOpen: true, brokerConnected: true },
    ] as const;
    for (const input of inputs) {
      expect(typeof deriveBadge(input).tone).toBe('string');
      expect(deriveBadge(input).tone.length).toBeGreaterThan(0);
    }
  });
});
