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


@Injectable()
export class NewsSentimentService {
  private readonly logger = new Logger(NewsSentimentService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly symbolIndex: NewsSymbolIndexService,
  ) {}

  async analyzeSentiment(
    title: string,
    summary: string,
  ): Promise<SentimentResult> {
    let result: SentimentResult;
    try {
      result = await this.callAIEngine(title, summary);
    } catch (error) {
      this.logger.debug(
        `AI engine unavailable, falling back to keyword analysis: ${
          error instanceof Error ? error.message : error
        }`,
      );
      result = await this.keywordFallback(title, summary);
    }
    // Commodity and index underlyings (CRUDEOIL, GOLD, BANKNIFTY…) are not in
    // the listed-symbol index, so neither path above can ever produce them.
    // Added on BOTH paths: the AI engine's own list would otherwise hide them.
    const merged = [...result.relatedSymbols];
    for (const s of aliasSymbols(title, summary)) if (!merged.includes(s)) merged.push(s);
    return { ...result, relatedSymbols: merged };
  }

  private async callAIEngine(
    title: string,
    summary: string,
  ): Promise<SentimentResult> {
    const response = await firstValueFrom(
      this.httpService.post<any>('http://localhost:5000/api/sentiment', {
        title,
        summary,
      }),
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
