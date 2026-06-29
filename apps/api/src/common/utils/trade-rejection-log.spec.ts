import { formatTradeRejection } from './trade-rejection-log';

describe('formatTradeRejection', () => {
  it('renders all fields present', () => {
    const line = formatTradeRejection({
      symbol: 'RAYMOND',
      stage: 'scoring',
      reason: 'scored-low: score 40 below 60',
      scan: 'ANAND HIGH GAINER',
      hitPrice: 496.6,
      side: 'BUY',
      score: 40,
    });

    expect(line).toBe(
      '[trade-rejected] RAYMOND | scan="ANAND HIGH GAINER" hit=496.6 side=BUY score=40 | stage=scoring reason="scored-low: score 40 below 60"',
    );
  });

  it('renders only the ctx fields that are defined, in canonical order, with correct spacing', () => {
    const line = formatTradeRejection({
      symbol: 'GESHIP',
      stage: 'process',
      reason: 'mtf-misaligned: TF 1d=UP, 15m=DOWN',
      scan: 'ANAND HIGH GAINER',
      hitPrice: 1664,
    });

    expect(line).toBe(
      '[trade-rejected] GESHIP | scan="ANAND HIGH GAINER" hit=1664 | stage=process reason="mtf-misaligned: TF 1d=UP, 15m=DOWN"',
    );
  });

  it('renders a single ctx field without stray spaces', () => {
    const line = formatTradeRejection({
      symbol: 'TCS',
      stage: 'scoring',
      reason: 'error: indicator crash',
      score: 12,
    });

    expect(line).toBe(
      '[trade-rejected] TCS | score=12 | stage=scoring reason="error: indicator crash"',
    );
  });

  it('drops the ctx segment entirely when no ctx fields are defined', () => {
    const line = formatTradeRejection({
      symbol: 'INFY',
      stage: 'process',
      reason: 'no-direction: sector unclear; stock trend also unclear',
    });

    expect(line).toBe(
      '[trade-rejected] INFY | stage=process reason="no-direction: sector unclear; stock trend also unclear"',
    );
  });

  it('treats score=0 as a defined ctx field (not omitted)', () => {
    const line = formatTradeRejection({
      symbol: 'WIPRO',
      stage: 'scoring',
      reason: 'scored-low: score 0 below 60',
      score: 0,
    });

    expect(line).toBe(
      '[trade-rejected] WIPRO | score=0 | stage=scoring reason="scored-low: score 0 below 60"',
    );
  });
});
