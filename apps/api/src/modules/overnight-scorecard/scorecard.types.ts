export type FactorName = 'oi' | 'fii_dii' | 'vix' | 'expiry' | 'news' | 'indicators' | 'mood';
export interface FactorScore {
  name: FactorName;
  points: -2 | -1 | 0 | 1 | 2;   // + supports the position's direction (long CE/long fut = bullish; long PE = bearish)
  value: string;                 // compact raw reading, e.g. "PCR 2.1 (5d med 1.3), put build +18% @1260"
  reason: string;                // one line
  available: boolean;            // false ⇒ points 0 and reason says what was missing
}
export type Band = 'STRONG_AGAINST' | 'AGAINST' | 'NEUTRAL' | 'SUPPORTS' | 'STRONG_SUPPORTS'; // ≤-4 | -3..-1 | 0 | 1..3 | ≥4
export type ScoreWindow = 'OVERNIGHT' | 'PRE_OPEN' | 'NEWS_IDEA';
export interface Scorecard {
  id?: string; userId: string | null; symbol: string; exchange: string; underlying: string;
  side: 'BULLISH' | 'BEARISH';   // the direction the position/idea needs
  window: ScoreWindow; computedAt: string; factors: FactorScore[]; total: number; band: Band;
}
export type IdeaKind = 'CE_IDEA' | 'PE_IDEA' | 'NO_TRADE';
export interface NewsIdea {
  id?: string; createdAt: string; symbol: string; exchange: string; newsIds: string[]; headline: string;
  idea: IdeaKind; rationale: string; invalidation: string; whatToDo: string; scorecardId: string | null;
}
