import { readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyNews,
  classifyNseFiling,
  decodeEntities,
  filterColumns,
  parseNewsFilterMode,
  parseNseTitle,
  publishable,
  trackerUnderlying,
  universeKey,
  visibleNewsWhere,
  type NewsFilterInput,
} from './news-relevance';

const UNIVERSE = new Set(['SBIN', 'TATASTEEL', 'BAJAJ-AUTO', 'M&M', 'SURANAT&P']);

const nse = (symbol: string, subject: string, text = `${symbol} Limited has informed the Exchange about ${subject}`) =>
  `${symbol}: ${subject} — ${text}`;

const rss = (title: string, over: Partial<NewsFilterInput> = {}): NewsFilterInput => ({
  source: 'LiveMint Companies', title, summary: '', instruments: [], sectors: [], indices: [], markets: ['IN'], tagged: true, ...over,
});

describe('mode', () => {
  it.each([
    [undefined, 'observe'], ['', 'observe'], ['observe', 'observe'], ['on', 'on'], [' ON ', 'on'], ['off', 'off'], ['true', 'observe'], ['typo', 'observe'],
  ])('NEWS_FILTER=%p → %s', (raw, mode) => {
    expect(parseNewsFilterMode({ NEWS_FILTER: raw })).toBe(mode);
  });

  it('readers add {filtered:false} only when on, and never with includeFiltered', () => {
    expect(visibleNewsWhere({ NEWS_FILTER: 'on' })).toEqual({ filtered: false });
    expect(visibleNewsWhere({ NEWS_FILTER: 'on' }, true)).toEqual({});
    expect(visibleNewsWhere({ NEWS_FILTER: 'observe' })).toEqual({});
    expect(visibleNewsWhere({ NEWS_FILTER: 'off' })).toEqual({});
    expect(visibleNewsWhere({})).toEqual({});
  });

  it('insert columns: off writes nothing, observe only the would-be reason, on both', () => {
    const v = { filtered: true, reason: 'listicle' };
    expect(filterColumns('off', v)).toEqual({});
    expect(filterColumns('observe', v)).toEqual({ filterReason: 'listicle' });
    expect(filterColumns('on', v)).toEqual({ filtered: true, filterReason: 'listicle' });
    expect(filterColumns('on', { filtered: false, reason: null })).toEqual({ filtered: false, filterReason: null });
  });

  it('publishable: only a row stored as filtered=true is held back', () => {
    expect(publishable({ filtered: true })).toBe(false);
    expect(publishable({ filtered: false })).toBe(true);
    expect(publishable({})).toBe(true);
  });
});

describe('helpers', () => {
  it('parses the NSE title format', () => {
    expect(parseNseTitle('SBIN: Credit Rating- Revision — SBI has informed')).toEqual({ symbol: 'SBIN', subject: 'Credit Rating- Revision', text: 'SBI has informed' });
    expect(parseNseTitle('SBIN: Updates')).toEqual({ symbol: 'SBIN', subject: 'Updates', text: '' });
    expect(parseNseTitle('no colon here')).toBeNull();
  });
  it('universe keys strip a series suffix only', () => {
    expect(universeKey('AZAD-EQ')).toBe('AZAD');
    expect(universeKey('hfcl-be')).toBe('HFCL');
    expect(universeKey('BAJAJ-AUTO')).toBe('BAJAJ-AUTO');
    expect(universeKey('SURANAT&P-EQ')).toBe('SURANAT&P');
  });
  it('a tracker maps to its underlying', () => {
    expect(trackerUnderlying('NIFTY25NOV2524000CE', 'NFO')).toBe('NIFTY');
    expect(trackerUnderlying('CRUDEOIL19NOV26FUT', 'MCX')).toBe('CRUDEOIL');
    expect(trackerUnderlying('M&M25NOV253500PE', 'NFO')).toBe('M&M');
    expect(trackerUnderlying('OFSS-EQ', 'NSE')).toBe('OFSS');
  });
  it('decodes feed entities', () => {
    expect(decodeEntities('M&amp;M &#x2018;x&#x2019; &#39;y&#39; &quot;z&quot;')).toBe('M&M ‘x’ \'y\' "z"');
  });
});

describe('NSE filings', () => {
  it('a company outside the universe is hidden whatever the type', () => {
    expect(classifyNseFiling(nse('ANSALAPI', 'Outcome of Board Meeting'), '', UNIVERSE)).toEqual({ filtered: true, reason: 'nse_not_in_universe' });
    expect(classifyNseFiling(nse('CAPACITE', 'Bagging/Receiving of orders/contracts'), '', UNIVERSE).reason).toBe('nse_not_in_universe');
  });

  it('universe membership uses the series-stripped symbol', () => {
    expect(classifyNseFiling(nse('SURANAT&P', 'Acquisition'), '', UNIVERSE).filtered).toBe(false);
    expect(classifyNseFiling(nse('BAJAJ-AUTO', 'Buyback'), '', UNIVERSE).filtered).toBe(false);
  });

  it('universe unavailable (null) → the universe rule is skipped, type rules still apply', () => {
    expect(classifyNseFiling(nse('ANYCO', 'Outcome of Board Meeting'), '', null).filtered).toBe(false);
    expect(classifyNseFiling(nse('ANYCO', 'Trading Window'), '', null).reason).toBe('nse_routine:trading_window');
  });

  it.each([
    'Outcome of Board Meeting', 'Bagging/Receiving of orders/contracts', 'Awarding of order(s)/contract(s)', 'Acquisition',
    'Amalgamation/Merger', 'Buyback', 'Rights Issue', 'Credit Rating', 'Credit Rating- Revision', 'Credit Rating- New',
    'Corporate Insolvency Resolution Process', 'Action(s) taken or orders passed', 'Action(s) initiated or orders passed',
    'Pendency of Litigation(s)/dispute(s) or the outcome impacting the Company', 'Change in Management', 'Spurt in Volume',
    'Price movement', 'News Verification', 'Rumour Verification - Regulation 30(11)', 'Commencement of commercial production/operations',
    'Granting/withdrawal/surrender/cancellation/suspension of key licenses/ regulatory approvals', 'Disclosure under SEBI Takeover Regulations',
    'Public Announcement-Open Offer', 'Qualified Institutional Placement', 'Fraud/Default/Arrest', 'Resignation of Statutory Auditor',
    'General Updates', 'Updates', 'Press Release', 'Some Subject NSE Adds Next Year',
  ])('universe company: %s is KEPT', (subject) => {
    expect(classifyNseFiling(nse('SBIN', subject), '', UNIVERSE)).toEqual({ filtered: false, reason: null });
  });

  it.each([
    ['Analysts/Institutional Investor Meet/Con. Call Updates', 'nse_routine:analysts_institutional_investor_meet_con_call_updates'],
    ['Copy of Newspaper Publication', 'nse_routine:copy_of_newspaper_publication'],
    ['Shareholders meeting', 'nse_routine:shareholders_meeting'],
    ['ESOP/ESOS/ESPS', 'nse_routine:esop_esos_esps'],
    ['Trading Window', 'nse_routine:trading_window'],
    ['Change in Company Secretary/Compliance Officer', 'nse_routine:change_in_company_secretary_compliance_officer'],
    ['Investor Presentation', 'nse_routine:investor_presentation'],
    ['Record Date', 'nse_routine:record_date'],
  ])('universe company: routine %s is HIDDEN', (subject, reason) => {
    expect(classifyNseFiling(nse('SBIN', subject), '', UNIVERSE)).toEqual({ filtered: true, reason });
  });

  it('generic types are hidden only when their text is plainly routine', () => {
    expect(classifyNseFiling(nse('SBIN', 'Updates', "SBI has informed the Exchange regarding 'Grant of stock options under ESOS'"), '', UNIVERSE).reason)
      .toBe('nse_generic_routine_text');
    expect(classifyNseFiling(nse('SBIN', 'General Updates', 'Change in Corporate Office Address of Registrar and Share Transfer Agent'), '', UNIVERSE).reason)
      .toBe('nse_generic_routine_text');
    expect(classifyNseFiling(nse('SBIN', 'General Updates', 'Schedule of analyst(s)/institutional investor(s) meet'), '', UNIVERSE).reason)
      .toBe('nse_generic_routine_text');
    expect(classifyNseFiling(nse('SBIN', 'General Updates', 'SBI receives LOA for 2500 MW power supply'), '', UNIVERSE).filtered).toBe(false);
    expect(classifyNseFiling(nse('SBIN', 'Press Release', 'Classification of US FDA Inspection at Unit-VI'), '', UNIVERSE).filtered).toBe(false);
  });

  it('people changes: hidden only when the text names a non-key role and no key role; boilerplate is kept', () => {
    expect(classifyNseFiling(nse('SBIN', 'Resignation of Director/KMP/SMP'), '', UNIVERSE).filtered).toBe(false); // echo only → may be the MD
    expect(classifyNseFiling(nse('SBIN', 'Resignation of Director/KMP/SMP', 'Resignation of Mr X as Chief Financial Officer'), '', UNIVERSE).filtered).toBe(false);
    expect(classifyNseFiling(nse('SBIN', 'Cessation', 'Completion of Tenure of Independent Director'), '', UNIVERSE).reason).toBe('nse_non_key_role:cessation');
    expect(classifyNseFiling(nse('SBIN', 'Appointment', 'Appointment of Ms Y as part-time Chief Vigilance Officer'), '', UNIVERSE).reason).toBe('nse_non_key_role:appointment');
    expect(classifyNseFiling(nse('SBIN', 'Appointment', 'Appointment of Mr Z as Managing Director and CEO'), '', UNIVERSE).filtered).toBe(false);
  });

  it('allotment: kept only for a notable raise, never for an employee scheme', () => {
    expect(classifyNseFiling(nse('SBIN', 'Allotment of Securities', 'allotment of 166 securities pursuant to ESOP/ESPS'), '', UNIVERSE).reason).toBe('nse_routine_allotment');
    expect(classifyNseFiling(nse('SBIN', 'Allotment of Securities', 'allotment of Non Convertible Securities'), '', UNIVERSE).reason).toBe('nse_routine_allotment');
    expect(classifyNseFiling(nse('SBIN', 'Allotment of Securities', 'allotment of equity shares to QIBs under the Qualified Institutions Placement'), '', UNIVERSE).filtered).toBe(false);
    expect(classifyNseFiling(nse('SBIN', 'Allotment of Securities', 'allotment of warrants on preferential basis to promoters'), '', UNIVERSE).filtered).toBe(false);
  });

  it('classifyNews routes NSE rows by source', () => {
    expect(classifyNews(rss(nse('ANYCO', 'Acquisition'), { source: 'NSE Announcements' }), UNIVERSE).reason).toBe('nse_not_in_universe');
    // The same title from another source is not judged by the filing rules.
    expect(classifyNews(rss(nse('ANYCO', 'Acquisition'), { source: 'ET Stock News' }), UNIVERSE).filtered).toBe(false);
  });
});

describe('other sources', () => {
  it.each([
    ['Celestica Inc. (CLS) Stock Price, News, Quote &amp; History - Yahoo! Finance Canada', 'quote_page'],
    ['M&amp;M Share Price Live Updates: M&amp;M Stock Price History', 'quote_page'],
    ['META_TITLE_QUOTE - Yahoo Finance', 'quote_page'],
    ['5 Best American Stocks to Buy for 2027 - Yahoo Finance', 'listicle'],
    ['5 Unstoppable Stocks to Buy According to Analysts - Yahoo Finance', 'listicle'],
    ['The five best stocks to buy before year-end, according to Bank of America', 'listicle'],
    ['Top 3 stocks to buy: Axis Bank, Bajaj Finance, HDFC Life by Sumeet Bagadia | Targets, stop-loss', 'listicle'],
    ['Who is Prerna Jha? Former Zee5 executive returns to Jio Studios as AVP – Marketing; what did she say?', 'gossip'],
    ['Who is Aman Gupta? Shark Tank India judge joins Ranveer Singh to launch men’s grooming brand HIM', 'gossip'],
    ['Alice Huang in touch with Chinese spy agency during affair with Nvidia CEO: Report', 'gossip'],
  ])('%s → %s', (title, reason) => {
    expect(classifyOtherSource(title)).toEqual({ filtered: true, reason });
  });

  it.each([
    'Infosys, TCS, HCL Tech: Indian IT stocks buck global AI rout trend; Nifty IT jumps 2% - Key reasons | Top shares to buy',
    'Top stocks to watch today: Senco Gold, Adani Enterprises, BSE, Cipla shares in focus',
    'Jensen Huang breaks his silence ahead of Nvidia earnings — plus, 1 stock to buy on weakness',
    'Who is Krishna Rao? Meet the low-profile Indian-origin CFO behind Anthropic IPO',
    'Multiple affairs and a federal investigation: Why Nvidia and Silicon Valley want Jensen Huang back',
    'Gold prices near 1-year low as dollar hits 19-month high: Should you buy before wedding season or wait?',
    'Rupee rises 43 paise to close at 93.51 against US dollar',
  ])('kept: %s', (title) => {
    expect(classifyOtherSource(title).filtered).toBe(false);
  });

  it('untagged + no market word → hidden; a market word, any tag, an untagged run or a commodity feed → kept', () => {
    const title = 'Amitabh Bachchan’s KBC question, Saif Ali Khan’s reaction: How Gowardhan Ghee found its new face';
    const none = { instruments: [], sectors: [], indices: [], markets: [] };
    expect(classifyNews(rss(title, none), null)).toEqual({ filtered: true, reason: 'untagged_no_market_word' });
    expect(classifyNews(rss(title, { ...none, markets: ['IN'] }), null).filtered).toBe(false);
    expect(classifyNews(rss(title, { ...none, sectors: ['NIFTY FMCG'] }), null).filtered).toBe(false);
    expect(classifyNews(rss(title, { ...none, tagged: false }), null).filtered).toBe(false); // tagger never ran (v2 off)
    expect(classifyNews(rss('Oman, Iran foreign ministers discuss safeguarding maritime corridors', { ...none, source: 'Investing.com Commodities' }), null).filtered).toBe(false);
    expect(classifyNews(rss('EU imposes up to 9.5% anti-dumping duties on Indian steelmakers', none), null).filtered).toBe(false);
  });
});

it('the module stays pure (imports nothing)', () => {
  expect(readFileSync(join(__dirname, 'news-relevance.ts'), 'utf8')).not.toMatch(/^\s*import\s/m);
});

function classifyOtherSource(title: string) {
  return classifyNews(rss(title), null);
}
