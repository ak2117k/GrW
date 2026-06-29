import { Injectable, Logger } from '@nestjs/common';
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

const KNOWN_SYMBOLS = [
  'RELIANCE', 'TCS', 'HDFC', 'HDFCBANK', 'INFY', 'INFOSYS', 'ICICIBANK',
  'KOTAKBANK', 'BHARTIARTL', 'AIRTEL', 'ITC', 'HINDUNILVR', 'HUL',
  'SBIN', 'SBI', 'BAJFINANCE', 'LT', 'MARUTI', 'TATAMOTORS', 'TATA',
  'SUNPHARMA', 'AXISBANK', 'WIPRO', 'HCLTECH', 'ADANIENT', 'ADANI',
  'TECHM', 'ULTRACEMCO', 'TITAN', 'NESTLEIND', 'ASIANPAINT',
  'POWERGRID', 'NTPC', 'ONGC', 'COALINDIA', 'JSWSTEEL', 'TATASTEEL',
  'BAJAJFINSV', 'INDUSINDBK', 'HINDALCO', 'GRASIM', 'CIPLA',
  'DRREDDY', 'DIVISLAB', 'BRITANNIA', 'HEROMOTOCO', 'EICHERMOT',
  'NIFTY', 'SENSEX', 'BANKNIFTY',
];

@Injectable()
export class NewsSentimentService {
  private readonly logger = new Logger(NewsSentimentService.name);

  constructor(private readonly httpService: HttpService) {}

  async analyzeSentiment(
    title: string,
    summary: string,
  ): Promise<SentimentResult> {
    try {
      return await this.callAIEngine(title, summary);
    } catch (error) {
      this.logger.debug(
        `AI engine unavailable, falling back to keyword analysis: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return this.keywordFallback(title, summary);
    }
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
        : this.extractSymbols(title, summary),
    };
  }

  private keywordFallback(title: string, summary: string): SentimentResult {
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
      relatedSymbols: this.extractSymbols(title, summary),
    };
  }

  private extractSymbols(title: string, summary: string): string[] {
    const text = `${title} ${summary ?? ''}`.toUpperCase();
    const found: string[] = [];

    for (const symbol of KNOWN_SYMBOLS) {
      // Match as whole word (bounded by non-letter characters)
      const regex = new RegExp(`\\b${symbol}\\b`);
      if (regex.test(text)) {
        // Normalize common aliases
        const normalized = this.normalizeSymbol(symbol);
        if (!found.includes(normalized)) {
          found.push(normalized);
        }
      }
    }

    return found;
  }

  private normalizeSymbol(symbol: string): string {
    const aliases: Record<string, string> = {
      INFOSYS: 'INFY',
      SBI: 'SBIN',
      AIRTEL: 'BHARTIARTL',
      HUL: 'HINDUNILVR',
      TATA: 'TATAMOTORS',
      ADANI: 'ADANIENT',
    };
    return aliases[symbol] ?? symbol;
  }
}
