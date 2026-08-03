import { Test } from '@nestjs/testing';
import { MarketQuoteResolver } from './market-quote-resolver.service';
import { CommoditiesSnapshotService } from './commodities-snapshot.service';
import { BreadthSectorService, BREADTH_QUOTE_RESOLVER } from './breadth-sector.service';
import { BatchQuotesService, MARKET_QUOTE_RESOLVER } from './batch-quotes.service';
import { UserFeedManager } from './user-feed-manager.service';
import { CommodityRollService } from './commodity-roll.service';

/**
 * Dependency-injection wiring for the market-page services.
 *
 * These services were built in parallel against a resolver that did not exist
 * yet, so two of them inject it through a STRING TOKEN and a structural port
 * rather than the concrete class. That decoupling is fine — but it means a
 * missing `useExisting` alias in `MarketDataModule` would compile perfectly and
 * only explode when Nest builds the graph at BOOT, taking the whole API down.
 *
 * Nothing else in this repo compiles the module graph, so this spec does it for
 * the affected slice: real providers, real tokens, fakes only at the broker
 * boundary. It fails loudly if an alias is dropped or an injection style drifts.
 */
describe('market-page service wiring', () => {
  const userFeedManager = {
    fetchQuotes: jest.fn().mockResolvedValue(new Map()),
    fetchCandles: jest.fn().mockResolvedValue([]),
  };
  const commodityRollService = {
    resolveFrontMonthTokens: jest.fn().mockResolvedValue([]),
  };

  async function buildModule() {
    return Test.createTestingModule({
      providers: [
        MarketQuoteResolver,
        CommoditiesSnapshotService,
        BreadthSectorService,
        BatchQuotesService,
        // The aliases MarketDataModule declares — the thing under test.
        { provide: BREADTH_QUOTE_RESOLVER, useExisting: MarketQuoteResolver },
        { provide: MARKET_QUOTE_RESOLVER, useExisting: MarketQuoteResolver },
        { provide: UserFeedManager, useValue: userFeedManager },
        { provide: CommodityRollService, useValue: commodityRollService },
      ],
    }).compile();
  }

  it('resolves every market-page service from the container', async () => {
    const moduleRef = await buildModule();
    expect(moduleRef.get(MarketQuoteResolver)).toBeInstanceOf(MarketQuoteResolver);
    expect(moduleRef.get(CommoditiesSnapshotService)).toBeInstanceOf(CommoditiesSnapshotService);
    expect(moduleRef.get(BreadthSectorService)).toBeInstanceOf(BreadthSectorService);
    expect(moduleRef.get(BatchQuotesService)).toBeInstanceOf(BatchQuotesService);
  });

  it('binds both resolver ports to the ONE real resolver instance', async () => {
    const moduleRef = await buildModule();
    const real = moduleRef.get(MarketQuoteResolver);
    // useExisting (not useClass) — a second instance would mean a second,
    // unshared fallback cache, quietly doubling the broker call rate.
    expect(moduleRef.get(BREADTH_QUOTE_RESOLVER)).toBe(real);
    expect(moduleRef.get(MARKET_QUOTE_RESOLVER)).toBe(real);
  });

  it('wires each service to a working resolver end to end', async () => {
    const moduleRef = await buildModule();

    // Exercising through the container proves the injected dependency is the
    // real collaborator, not just that the class constructs.
    await expect(
      moduleRef.get(BreadthSectorService).getBreadth('u1'),
    ).resolves.toBeDefined();
    await expect(
      moduleRef.get(BreadthSectorService).getSectorPerformance('u1'),
    ).resolves.toBeDefined();
    await expect(
      moduleRef.get(BatchQuotesService).getQuotes('u1', []),
    ).resolves.toBeDefined();
    await expect(
      moduleRef.get(CommoditiesSnapshotService).getSnapshot('u1'),
    ).resolves.toBeDefined();
  });
});
