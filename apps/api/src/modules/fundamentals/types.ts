/**
 * Public response shape for GET /api/fundamentals/:symbol.
 *
 * All fields except `symbol`, `exchange`, and `fetchedAt` are optional —
 * Yahoo's quoteSummary endpoint omits anything it doesn't have, so we mirror
 * that with optional chaining + undefined-fallthrough on the parser side.
 *
 * Numeric fields are kept in their native scale:
 *   - marketCap: raw INR (e.g. 1.95e13 for 19.5 lakh crore)
 *   - returnOnEquity / dividendYield: decimal (0.18 = 18%)
 *   - debtToEquity: as Yahoo reports (typically already a percentage-style
 *     number, e.g. 45.2 means 45.2%, NOT 0.452 — Yahoo's own quirk)
 *
 * The frontend (`FundamentalsCard.tsx`) handles all formatting.
 */
export interface FundamentalsResponse {
  symbol: string;
  exchange: string; // 'NSE' | 'BSE'
  fetchedAt: number; // unix ms

  // Profile (assetProfile module)
  sector?: string;
  industry?: string;

  // Valuation (summaryDetail / defaultKeyStatistics / financialData)
  marketCap?: number;
  trailingPE?: number;
  priceToBook?: number;
  trailingEPS?: number;
  forwardEPS?: number;

  // Profitability / leverage (financialData)
  returnOnEquity?: number;
  debtToEquity?: number;

  // 52-week range (summaryDetail)
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;

  // Income / risk (summaryDetail)
  dividendYield?: number;
  beta?: number;

  // Earnings (calendarEvents.earnings + earnings.earningsChart)
  nextEarningsDate?: string;
  recentEarnings?: Array<{
    quarter: string;
    date: string;
    reportedEPS?: number;
    estimateEPS?: number;
    surprise?: number;
  }>;
}
