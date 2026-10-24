import { classifyArticle, combineTypes, nseSubject, NSE_ANNOUNCEMENTS, type MaterialType } from './announcement-classifier';

const nse = (title: string) => classifyArticle({ title, source: NSE_ANNOUNCEMENTS });

/** Real-shaped NSE subjects (`SYM: subject — attachment text`). */
const FIXTURES: Array<[string, MaterialType]> = [
  ['VIJIFIN: Copy of Newspaper Publication — Viji Finance Limited has informed the Exchange about Copy of Newspaper Publication', 'BOILERPLATE'],
  ['TCS: Copy of Newspaper Publication — Publication of financial results for the quarter', 'BOILERPLATE'],
  ['INFY: Analysts/Institutional Investor Meet/Con. Call Updates — to discuss the financial results', 'BOILERPLATE'],
  ['AURUM: Investor Presentation — Aurum PropTech Limited has informed the Exchange about Investor Presentation', 'BOILERPLATE'],
  ['HDFCBANK: Trading Window-XBRL — Closure of trading window', 'BOILERPLATE'],
  ['SBIN: Certificate under SEBI (Depositories and Participants) Regulations, 2018 — Reg 74(5)', 'BOILERPLATE'],
  ['ITC: Loss of Share Certificates — intimation of loss of share certificates', 'BOILERPLATE'],
  ['LT: Allotment of ESOP / ESPS — allotment of 12,000 shares under ESOS 2018', 'BOILERPLATE'],
  ['ABC: Change in Registrar and Share Transfer Agent — change of RTA', 'BOILERPLATE'],
  ['XYZ: Board Meeting Intimation — to consider and approve the financial results', 'BOILERPLATE'],
  ['PQR: Shareholders meeting — Notice of AGM', 'BOILERPLATE'],
  ['RELIANCE: Outcome of Board Meeting — approved the audited financial results for the quarter ended September 2026', 'RESULTS'],
  ['WIPRO: Financial Result Updates — Q2 results', 'RESULTS'],
  ['LT: Bagging/Receiving of orders/contracts — L&T secures a significant order worth Rs 2,500 crore', 'ORDER_WIN'],
  ['BEL: Updates — BEL has received orders worth Rs 572 crore', 'ORDER_WIN'],
  ['TATASTEEL: Acquisition — acquisition of 100% stake in a subsidiary', 'M_AND_A'],
  ['ABB: Scheme of Arrangement — merger of wholly owned subsidiary', 'M_AND_A'],
  ['ADANIENT: Disclosure of creation/release/invocation of pledge — revocation of pledge on promoter shares', 'PLEDGE'],
  ['IDEA: Credit Rating — CRISIL reaffirmed the long-term rating', 'CREDIT_RATING'],
  ['ZOMATO: Block Deal — block deal disclosure', 'BLOCK_DEAL'],
  ['PAYTM: Resignation of Chief Financial Officer — resignation of CFO', 'MANAGEMENT_CHANGE'],
  ['INFY: Buyback — Board approves buyback of equity shares', 'BUYBACK'],
  ['YESBANK: Raising of Funds — QIP of up to Rs 5,000 crore', 'FUND_RAISING'],
  ['ITC: Corporate Action-Dividend — interim dividend of Rs 6 per share', 'CORPORATE_ACTION'],
  ['IRCTC: Corporate Action-Bonus — bonus issue 1:1', 'CORPORATE_ACTION'],
  ['DRREDDY: Updates — USFDA issued a warning letter for the Srikakulam plant', 'LITIGATION_REGULATORY'],
  ['VEDL: Litigation / Dispute — order of the Supreme Court', 'LITIGATION_REGULATORY'],
  ['MARUTI: Business Update — monthly sales for October 2026', 'GUIDANCE_UPDATE'],
  ['FOO: General Updates — the company has informed the Exchange about general updates', 'OTHER'],
];

describe('NSE announcement classifier', () => {
  it.each(FIXTURES)('%s → %s', (title, type) => {
    expect(nse(title).type).toBe(type);
  });

  it('has ≥ 25 fixtures and flags material / boilerplate consistently', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(25);
    expect(nse(FIXTURES[0][0])).toEqual({ type: 'BOILERPLATE', material: false, boilerplate: true });
    expect(nse('RELIANCE: Outcome of Board Meeting — approved financial results')).toMatchObject({ material: true, boilerplate: false });
  });

  it('subject decides boilerplate before the text can make it material', () => {
    expect(nse('X: Copy of Newspaper Publication — Publication of results and dividend').type).toBe('BOILERPLATE');
  });

  it('splits the stored NSE title into subject and text', () => {
    expect(nseSubject('TCS: Credit Rating — CRISIL AAA')).toEqual({ subject: 'Credit Rating', text: 'CRISIL AAA' });
  });

  it('RSS headlines: material keyword → that kind, else NEWS', () => {
    expect(classifyArticle({ title: 'L&T wins ₹7,000 crore order from NHAI', source: 'Economic Times' }).type).toBe('ORDER_WIN');
    expect(classifyArticle({ title: 'Sensex, Nifty open flat as investors await Fed', source: 'LiveMint' }).type).toBe('NEWS');
  });

  it('combines a cluster: material wins, all-boilerplate stays boilerplate', () => {
    expect(combineTypes(['NEWS', 'RESULTS']).type).toBe('RESULTS');
    expect(combineTypes(['BOILERPLATE', 'BOILERPLATE']).boilerplate).toBe(true);
    expect(combineTypes(['BOILERPLATE', 'NEWS']).type).toBe('NEWS');
  });
});
