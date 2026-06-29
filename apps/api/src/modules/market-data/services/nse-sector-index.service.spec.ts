import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { NseSectorIndexService } from './nse-sector-index.service';
import { YahooFinanceService } from './yahoo-finance.service';
import { StockSectorRepository } from '../repositories/stock-sector.repository';

/**
 * Broad NIFTY 500 constituent CSV — the new single source. Same column
 * layout as the legacy sectoral-index CSVs:
 *   Company Name,Industry,Symbol,Series,ISIN Code
 * Note the deliberate mix of mappable industries and an unmappable one
 * ("Diversified") plus a small/mid-cap (TANLA) that the old large-cap
 * static map would have missed.
 */
const NIFTY_500_CSV = `Company Name,Industry,Symbol,Series,ISIN Code
Infosys Ltd.,Information Technology,INFY,EQ,INE009A01021
HCL Technologies Ltd.,Information Technology,HCLTECH,EQ,INE860A01027
HDFC Bank Ltd.,Banks,HDFCBANK,EQ,INE040A01034
ICICI Bank Ltd.,Banks,ICICIBANK,EQ,INE090A01021
Sun Pharmaceutical Industries Ltd.,Pharmaceuticals & Biotechnology,SUNPHARMA,EQ,INE044A01036
Maruti Suzuki India Ltd.,Automobiles,MARUTI,EQ,INE585B01010
Tata Steel Ltd.,Ferrous Metals,TATASTEEL,EQ,INE081A01020
NTPC Ltd.,Power,NTPC,EQ,INE733E01010
Reliance Industries Ltd.,Petroleum Products,RELIANCE,EQ,INE002A01018
Tanla Platforms Ltd.,IT - Software,TANLA,EQ,INE483C01032
Vodafone Idea Ltd.,Telecom - Services,IDEA,EQ,INE669E01016
Bajaj Finance Ltd.,Finance,BAJFINANCE,EQ,INE296A01024
"Some, Diversified Holdco Ltd.",Diversified,DIVCO,EQ,INE000X01010`;

describe('NseSectorIndexService', () => {
  let service: NseSectorIndexService;
  let mockHttp: { get: jest.Mock };
  let yahoo: { getAssetProfile: jest.Mock };
  let repo: { upsertMany: jest.Mock; findBySymbol: jest.Mock; count: jest.Mock };

  beforeEach(async () => {
    mockHttp = { get: jest.fn() };
    yahoo = { getAssetProfile: jest.fn().mockResolvedValue(null) };
    repo = {
      // Real repo returns the number of rows it processed.
      upsertMany: jest.fn((rows: unknown[]) => Promise.resolve(rows.length)),
      findBySymbol: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    };
    const module = await Test.createTestingModule({
      providers: [
        NseSectorIndexService,
        { provide: HttpService, useValue: mockHttp },
        { provide: YahooFinanceService, useValue: yahoo },
        { provide: StockSectorRepository, useValue: repo },
      ],
    }).compile();
    module.useLogger(false);
    service = module.get(NseSectorIndexService);
  });

  // ─── refresh(): broad CSV → industry → token → DB upsert ────────────────

  it('fetches the broad NIFTY 500 CSV (single request, not 15)', async () => {
    mockHttp.get.mockReturnValue(of({ data: NIFTY_500_CSV }));
    await service.refresh();
    expect(mockHttp.get).toHaveBeenCalledTimes(1);
    const url = mockHttp.get.mock.calls[0][0] as string;
    expect(url).toContain('ind_nifty500list.csv');
  });

  it('upserts every CSV row with symbol + industry + resolved token', async () => {
    mockHttp.get.mockReturnValue(of({ data: NIFTY_500_CSV }));
    const n = await service.refresh();
    expect(n).toBe(13); // every data row in the fixture
    expect(repo.upsertMany).toHaveBeenCalledTimes(1);
    const rows = repo.upsertMany.mock.calls[0][0] as Array<{
      symbol: string;
      industry: string;
      sectorIndexToken: string | null;
    }>;
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    // Industry → sector-index token mapping
    expect(bySymbol.get('INFY')).toMatchObject({
      industry: 'Information Technology',
      sectorIndexToken: '99926013',
    });
    expect(bySymbol.get('HDFCBANK')?.sectorIndexToken).toBe('99926009');
    expect(bySymbol.get('SUNPHARMA')?.sectorIndexToken).toBe('99926017');
    expect(bySymbol.get('MARUTI')?.sectorIndexToken).toBe('99926021');
    expect(bySymbol.get('TATASTEEL')?.sectorIndexToken).toBe('99926023');
    expect(bySymbol.get('NTPC')?.sectorIndexToken).toBe('99926019');
    expect(bySymbol.get('RELIANCE')?.sectorIndexToken).toBe('99926019');
    expect(bySymbol.get('BAJFINANCE')?.sectorIndexToken).toBe('99926011');
    // "IT - Software" is an alias of the IT sector
    expect(bySymbol.get('TANLA')?.sectorIndexToken).toBe('99926013');
    // Telecom - Services maps to MEDIA (closest tracked index)
    expect(bySymbol.get('IDEA')?.sectorIndexToken).toBe('99926031');
  });

  it('persists null sectorIndexToken for industries with no clean sector index', async () => {
    mockHttp.get.mockReturnValue(of({ data: NIFTY_500_CSV }));
    await service.refresh();
    const rows = repo.upsertMany.mock.calls[0][0] as Array<{
      symbol: string;
      sectorIndexToken: string | null;
    }>;
    const divco = rows.find((r) => r.symbol === 'DIVCO');
    expect(divco?.sectorIndexToken).toBeNull();
  });

  it('parses quoted company names containing commas without breaking columns', async () => {
    mockHttp.get.mockReturnValue(of({ data: NIFTY_500_CSV }));
    await service.refresh();
    const rows = repo.upsertMany.mock.calls[0][0] as Array<{
      symbol: string;
      industry: string;
    }>;
    // "Some, Diversified Holdco Ltd." has an in-quote comma — Symbol must
    // still land in the right column.
    expect(rows.find((r) => r.symbol === 'DIVCO')?.industry).toBe('Diversified');
  });

  it('does not upsert and keeps previous state when the CSV fetch fails', async () => {
    mockHttp.get.mockReturnValue(throwError(() => new Error('NSE timeout')));
    const n = await service.refresh();
    expect(n).toBe(0);
    expect(repo.upsertMany).not.toHaveBeenCalled();
  });

  it('maps NSE rollup industry names to the right NIFTY sector token', async () => {
    // NSE migrated its `Industry` taxonomy to broader rollup names. Each row
    // here uses one of the seven rollups currently emitted by the NIFTY 500
    // CSV but historically unmapped by INDUSTRY_TO_SECTOR_TOKEN.
    const ROLLUP_CSV = `Company Name,Industry,Symbol,Series,ISIN Code
ABB India Ltd.,Capital Goods,ABB,EQ,INE117A01022
Mahindra CIE Automotive Ltd.,Automobile and Auto Components,MCIE,EQ,INE536H01010
ITC Ltd.,Fast Moving Consumer Goods,ITC,EQ,INE154A01025
Vedanta Ltd.,Metals & Mining,VEDL,EQ,INE205A01025
Reliance Industries Ltd.,Oil Gas & Consumable Fuels,RELIANCE,EQ,INE002A01018
Bharti Airtel Ltd.,Telecommunication,BHARTIARTL,EQ,INE397D01024
Sun TV Network Ltd.,Media Entertainment & Publication,SUNTV,EQ,INE424H01027`;
    mockHttp.get.mockReturnValue(of({ data: ROLLUP_CSV }));
    await service.refresh();
    const rows = repo.upsertMany.mock.calls[0][0] as Array<{
      symbol: string;
      sectorIndexToken: string | null;
    }>;
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    expect(bySymbol.get('ABB')?.sectorIndexToken).toBe('99926029'); // INFRA
    expect(bySymbol.get('MCIE')?.sectorIndexToken).toBe('99926021'); // AUTO
    expect(bySymbol.get('ITC')?.sectorIndexToken).toBe('99926015'); // FMCG
    expect(bySymbol.get('VEDL')?.sectorIndexToken).toBe('99926023'); // METAL
    expect(bySymbol.get('RELIANCE')?.sectorIndexToken).toBe('99926019'); // ENERGY
    expect(bySymbol.get('BHARTIARTL')?.sectorIndexToken).toBe('99926031'); // MEDIA
    expect(bySymbol.get('SUNTV')?.sectorIndexToken).toBe('99926031'); // MEDIA
  });

  // ─── getSectorIndexForSymbol(): Tier 1 = DB ─────────────────────────────

  it('Tier 1: resolves from the StockSector table', async () => {
    repo.findBySymbol.mockResolvedValue({
      symbol: 'TANLA',
      industry: 'IT - Software',
      sectorIndexToken: '99926013',
    });
    expect(await service.getSectorIndexForSymbol('TANLA')).toBe('99926013');
    expect(repo.findBySymbol).toHaveBeenCalledWith('TANLA');
  });

  it('Tier 1: strips series suffixes before the DB lookup', async () => {
    repo.findBySymbol.mockResolvedValue({
      symbol: 'INFY',
      industry: 'Information Technology',
      sectorIndexToken: '99926013',
    });
    expect(await service.getSectorIndexForSymbol('INFY-EQ')).toBe('99926013');
    expect(repo.findBySymbol).toHaveBeenCalledWith('INFY');
  });

  it('Tier 1: returns null (does NOT fall through) when the DB row has a null token', async () => {
    // A row exists for the symbol but its industry is unmapped — that is a
    // definitive "no clean sector index" answer, not a cache miss.
    repo.findBySymbol.mockResolvedValue({
      symbol: 'DIVCO',
      industry: 'Diversified',
      sectorIndexToken: null,
    });
    expect(await service.getSectorIndexForSymbol('DIVCO')).toBeNull();
    expect(yahoo.getAssetProfile).not.toHaveBeenCalled();
  });

  // ─── Tier 2: static fallback ────────────────────────────────────────────

  it('Tier 2: falls back to the static large-cap map when the DB has no row', async () => {
    repo.findBySymbol.mockResolvedValue(null);
    expect(await service.getSectorIndexForSymbol('RELIANCE')).toBe('99926019');
  });

  // ─── Tier 3: Yahoo Finance ──────────────────────────────────────────────

  it('Tier 3: falls back to Yahoo Finance when DB and static both miss', async () => {
    repo.findBySymbol.mockResolvedValue(null);
    yahoo.getAssetProfile.mockResolvedValue({ sector: 'Financial Services', industry: 'Banks' });
    const result = await service.getSectorIndexForSymbol('IFCI');
    expect(result).toBe('99926011');
    expect(yahoo.getAssetProfile).toHaveBeenCalledWith('IFCI');
  });

  it('Tier 3: caches Yahoo lookups (does not re-query within 24h)', async () => {
    repo.findBySymbol.mockResolvedValue(null);
    yahoo.getAssetProfile.mockResolvedValue({ sector: 'Technology', industry: 'Software' });
    await service.getSectorIndexForSymbol('SOMECO');
    await service.getSectorIndexForSymbol('SOMECO');
    expect(yahoo.getAssetProfile).toHaveBeenCalledTimes(1);
  });

  it('Tier 3: returns null when Yahoo sector is not in the NIFTY mapping', async () => {
    repo.findBySymbol.mockResolvedValue(null);
    yahoo.getAssetProfile.mockResolvedValue({ sector: 'Unknown Sector XYZ', industry: 'X' });
    expect(await service.getSectorIndexForSymbol('WEIRDCO')).toBeNull();
  });

  it('returns null for an empty/blank symbol', async () => {
    expect(await service.getSectorIndexForSymbol('')).toBeNull();
    expect(repo.findBySymbol).not.toHaveBeenCalled();
  });

  // ─── stats ──────────────────────────────────────────────────────────────

  it('reports stats including lastRefreshAt', async () => {
    repo.count.mockResolvedValue(13);
    mockHttp.get.mockReturnValue(of({ data: NIFTY_500_CSV }));
    expect((await service.getStats()).lastRefreshAt).toBeNull();
    await service.refresh();
    const stats = await service.getStats();
    expect(stats.count).toBe(13);
    expect(stats.lastRefreshAt).toBeInstanceOf(Date);
  });
});
