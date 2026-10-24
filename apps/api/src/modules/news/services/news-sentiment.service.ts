import { Injectable, Logger } from '@nestjs/common';
import { extractSymbols } from './extract-symbols';
import { aliasSymbols } from './underlying-news-aliases';
import { NewsSymbolIndexService } from './news-symbol-index.service';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface SentimentResult {
  sentiment: 'bullish' | 'bearish' | 'neutral';
  score: number; // -1.0 to 1.0
  relatedSymbols: string[];
}

const BULLISH_KEYWORDS = [
  'rally', 'surge', 'gain', 'bullish', 'buy', 'upgrade', 'outperform',
  'beat', 'record high', 'breakout', 'positive', 'growth', 'profit',
  'strong', 'soar', 'jump', 'rise', 'climb', 'boost', 'optimism',
  'recovery', 'uptick', 'advance', 'upbeat', 'boom',
];

const BEARISH_KEYWORDS = [
  'crash', 'fall', 'decline', 'bearish', 'sell', 'downgrade', 'underperform',
  'miss', 'record low', 'breakdown', 'negative', 'loss', 'weak',
  'plunge', 'drop', 'sink', 'slump', 'tumble', 'pessimism',
  'recession', 'downturn', 'concern', 'risk', 'fear', 'warning',
];

/** After a failed AI-engine call, keyword analysis only for this long. */
export const ENGINE_BACKOFF_MS = 30 * 60_000;

@Injectable()
export class NewsSentimentService {
  private readonly logger = new Logger(NewsSentimentService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly symbolIndex: NewsSymbolIndexService,
  ) {}

  /**
   * The Python sentiment endpoint: AI_ENGINE_URL + /api/sentiment. Unset ⇒ never called (keyword
   * analysis only). It was a hardcoded localhost:5000 that no prod container serves, so every article
   * paid an ECONNREFUSED round trip. A failed call now also backs the engine off for
   * {@link ENGINE_BACKOFF_MS} (one log line per back-off), so a dead engine costs nothing per article.
   * Once the news-impact model has read a story, its impact overwrites this sentiment (news-impact module).
   */
  engineUrl: string | null = (process.env.AI_ENGINE_URL ?? '').trim().replace(/\/+$/, '') || null;
  private engineDownUntil = 0;
  /** Test seam. */
  now: () => number = () => Date.now();

  async analyzeSentiment(
    title: string,
    summary: string,
  ): Promise<SentimentResult> {
    let result: SentimentResult | null = null;
    if (this.engineUrl && this.now() >= this.engineDownUntil) {
      try {
        result = await this.callAIEngine(this.engineUrl, title, summary);
      } catch (error) {
        this.engineDownUntil = this.now() + ENGINE_BACKOFF_MS;
        this.logger.warn(
          `AI sentiment engine unavailable (${error instanceof Error ? error.message : String(error)}) — keyword analysis for the next ${ENGINE_BACKOFF_MS / 60_000} min`,
        );
      }
    }
    result ??= await this.keywordFallback(title, summary);
    // Commodity and index underlyings (CRUDEOIL, GOLD, BANKNIFTY…) are not in
    // the listed-symbol index, so neither path above can ever produce them.
    // Added on BOTH paths: the AI engine's own list would otherwise hide them.
    const merged = [...result.relatedSymbols];
    for (const s of aliasSymbols(title, summary)) if (!merged.includes(s)) merged.push(s);
    return { ...result, relatedSymbols: merged };
  }

  private async callAIEngine(
    base: string,
    title: string,
    summary: string,
  ): Promise<SentimentResult> {
    const response = await firstValueFrom(
      this.httpService.post<any>(`${base}/api/sentiment`, {
        title,
        summary,
      }, { timeout: 3_000 }),
    );

    const data = response.data;

    return {
      sentiment: data.sentiment ?? 'neutral',
      score: typeof data.score === 'number' ? data.score : 0,
      relatedSymbols: Array.isArray(data.relatedSymbols)
        ? data.relatedSymbols
        : await this.symbolsFor(title, summary),
    };
  }

  private async keywordFallback(title: string, summary: string): Promise<SentimentResult> {
    const text = `${title} ${summary ?? ''}`.toLowerCase();

    let bullishScore = 0;
    let bearishScore = 0;

    for (const keyword of BULLISH_KEYWORDS) {
      if (text.includes(keyword)) bullishScore++;
    }

    for (const keyword of BEARISH_KEYWORDS) {
      if (text.includes(keyword)) bearishScore++;
    }

    let sentiment: 'bullish' | 'bearish' | 'neutral';
    let score: number;

    if (bullishScore > bearishScore) {
      sentiment = 'bullish';
      score = Math.min(bullishScore / 5, 1.0);
    } else if (bearishScore > bullishScore) {
      sentiment = 'bearish';
      score = -Math.min(bearishScore / 5, 1.0);
    } else {
      sentiment = 'neutral';
      score = 0;
    }

    return {
      sentiment,
      score,
      relatedSymbols: await this.symbolsFor(title, summary),
    };
  }

  /**
   * The listed symbols this article mentions.
   *
   * This was a hardcoded list of 49 large-caps, which is why 82% of stored
   * articles carried no symbol at all and the sentinel's news sensor could
   * never fire for a mid-cap — KEI, MOTHERSON, HAL and BDL were all absent from
   * the list and all present in the instrument table.
   *
   * Now matched against that table's 18,949 listed symbols. See
   * `extract-symbols.ts` for the tokenise-and-intersect rule, and for why a
   * handful of ordinary English words that are also tickers are excluded.
   */
  private async symbolsFor(title: string, summary: string): Promise<string[]> {
    const known = await this.symbolIndex.symbols();
    return extractSymbols(title, summary, known);
  }

}
