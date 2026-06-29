import { describe, it, expect } from 'vitest';
import { buildChartHref } from './chartHref';

describe('buildChartHref', () => {
  it('includes symbol, token and exchange when all are present', () => {
    expect(buildChartHref('RELIANCE', '2885', 'NSE')).toBe(
      '/charts?symbol=RELIANCE&token=2885&exchange=NSE',
    );
  });

  it('omits the token param when token is null/undefined/empty', () => {
    expect(buildChartHref('XYZ', null, 'NSE')).toBe('/charts?symbol=XYZ&exchange=NSE');
    expect(buildChartHref('XYZ', undefined, 'NSE')).toBe('/charts?symbol=XYZ&exchange=NSE');
    expect(buildChartHref('XYZ', '', 'NSE')).toBe('/charts?symbol=XYZ&exchange=NSE');
  });

  it('defaults exchange to NSE when not given or empty', () => {
    expect(buildChartHref('TCS', '11536')).toBe('/charts?symbol=TCS&token=11536&exchange=NSE');
    expect(buildChartHref('TCS', '11536', '')).toBe('/charts?symbol=TCS&token=11536&exchange=NSE');
  });

  it('honors a non-NSE exchange', () => {
    expect(buildChartHref('GOLD', '459277', 'MCX')).toBe(
      '/charts?symbol=GOLD&token=459277&exchange=MCX',
    );
  });

  it('URL-encodes symbols with special characters', () => {
    // M&M would otherwise break the query string at the ampersand.
    expect(buildChartHref('M&M', '123')).toBe('/charts?symbol=M%26M&token=123&exchange=NSE');
  });
});
