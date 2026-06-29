import { Test } from '@nestjs/testing';
import { MarketContextService } from './market-context.service';
import { YahooFinanceService } from './yahoo-finance.service';
import { MarketFeedService } from './market-feed.service';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';

describe('MarketContextService', () => {
  let service: MarketContextService;
  let yahoo: jest.Mocked<Pick<YahooFinanceService, 'getIndiaVix'>>;
  let feed: jest.Mocked<Pick<MarketFeedService, 'getQuote' | 'getBreadth'>>;
  let chain: jest.Mocked<
    Pick<OptionsChainService, 'getOptionsChainWithSpot' | 'getExpiries' | 'getPCR' | 'getMaxPain'>
  >;

  beforeEach(async () => {
    const yahooMock = { getIndiaVix: jest.fn() };
    const feedMock = { getQuote: jest.fn(), getBreadth: jest.fn() };
    const chainMock = {
      getOptionsChainWithSpot: jest.fn(),
      getExpiries: jest.fn(),
      getPCR: jest.fn(),
      getMaxPain: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MarketContextService,
        { provide: YahooFinanceService, useValue: yahooMock },
        { provide: MarketFeedService, useValue: feedMock },
        { provide: OptionsChainService, useValue: chainMock },
      ],
    }).compile();

    service = moduleRef.get(MarketContextService);
    yahoo = moduleRef.get(YahooFinanceService) as any;
    feed = moduleRef.get(MarketFeedService) as any;
    chain = moduleRef.get(OptionsChainService) as any;
  });

  describe('classifyVixRegime', () => {
    it('classifies <12 as LOW', () => {
      expect(service.classifyVixRegime(11.9)).toBe('LOW');
    });
    it('classifies 12-18 as NORMAL', () => {
      expect(service.classifyVixRegime(12)).toBe('NORMAL');
      expect(service.classifyVixRegime(17.99)).toBe('NORMAL');
    });
    it('classifies 18-25 as ELEVATED', () => {
      expect(service.classifyVixRegime(18)).toBe('ELEVATED');
      expect(service.classifyVixRegime(24.99)).toBe('ELEVATED');
    });
    it('classifies >=25 as HIGH', () => {
      expect(service.classifyVixRegime(25)).toBe('HIGH');
      expect(service.classifyVixRegime(40)).toBe('HIGH');
    });
    it('classifies null/undefined/NaN as UNKNOWN', () => {
      expect(service.classifyVixRegime(null)).toBe('UNKNOWN');
      expect(service.classifyVixRegime(undefined)).toBe('UNKNOWN');
      expect(service.classifyVixRegime(Number.NaN)).toBe('UNKNOWN');
    });
  });

  describe('snapshot', () => {
    it('aggregates all context sources', async () => {
      yahoo.getIndiaVix.mockResolvedValue(14.5);
      feed.getBreadth.mockReturnValue({
        advances: 30,
        declines: 20,
        unchanged: 5,
        adRatio: 1.5,
        total: 55,
      });
      feed.getQuote.mockReturnValue({
        symbol: 'NIFTY',
        token: '99926000',
        exchange: 'NSE' as any,
        ltp: 22500,
        open: 22400,
        high: 22550,
        low: 22380,
        close: 22400,
        volume: 0,
        change: 100,
        changePercent: 0.45,
        timestamp: new Date(),
      });
      chain.getExpiries.mockResolvedValue(['2026-04-30']);
      chain.getOptionsChainWithSpot.mockResolvedValue({
        chain: [{ strikePrice: 22500, expiryDate: '2026-04-30', ceData: null, peData: null }],
        spotPrice: 22500,
      });
      chain.getPCR.mockReturnValue(1.12);
      chain.getMaxPain.mockReturnValue(22400);

      const ctx = await service.snapshot('NIFTY');

      expect(ctx).toMatchObject({
        underlying: 'NIFTY',
        spot: 22500,
        vix: 14.5,
        vixRegime: 'NORMAL',
        pcr: 1.12,
        maxPain: 22400,
        adRatio: 1.5,
      });
      expect(ctx.capturedAt).toBeInstanceOf(Date);
    });

    it('tolerates partial failures (returns nulls for failed fetches)', async () => {
      yahoo.getIndiaVix.mockResolvedValue(null);
      feed.getBreadth.mockImplementation(() => {
        throw new Error('feed not connected');
      });
      feed.getQuote.mockReturnValue({
        symbol: 'NIFTY',
        token: '99926000',
        exchange: 'NSE' as any,
        ltp: 22500,
        open: 22400,
        high: 22550,
        low: 22380,
        close: 22400,
        volume: 0,
        change: 100,
        changePercent: 0.45,
        timestamp: new Date(),
      });
      chain.getExpiries.mockRejectedValue(new Error('chain unavailable'));
      chain.getPCR.mockReturnValue(0);
      chain.getMaxPain.mockReturnValue(0);

      const ctx = await service.snapshot('NIFTY');

      expect(ctx.spot).toBe(22500);
      expect(ctx.vix).toBeNull();
      expect(ctx.vixRegime).toBe('UNKNOWN');
      expect(ctx.adRatio).toBeNull();
      expect(ctx.pcr).toBeNull();
      expect(ctx.maxPain).toBeNull();
    });

    it('returns null spot when getQuote returns no entry', async () => {
      yahoo.getIndiaVix.mockResolvedValue(13.0);
      feed.getBreadth.mockReturnValue({
        advances: 1, declines: 1, unchanged: 0, adRatio: 1, total: 2,
      });
      feed.getQuote.mockReturnValue(null);
      chain.getExpiries.mockResolvedValue([]);
      chain.getPCR.mockReturnValue(0);
      chain.getMaxPain.mockReturnValue(0);

      const ctx = await service.snapshot('UNKNOWNSYM');

      expect(ctx.spot).toBeNull();
      expect(ctx.vix).toBe(13.0);
      expect(ctx.vixRegime).toBe('NORMAL');
      expect(ctx.pcr).toBeNull();
      expect(ctx.maxPain).toBeNull();
    });
  });
});
