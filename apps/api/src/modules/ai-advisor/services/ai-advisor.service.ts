import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SYSTEM_USER_ID } from '../../../common/tenant/tenant.constants';
import { firstValueFrom } from 'rxjs';

export interface AIResponse {
  answer: string;
  confidence: number;
  relatedInsights: string[];
  suggestedActions: string[];
}

export interface AIInsightResult {
  id: string;
  type: 'suggestion' | 'warning' | 'analysis' | 'report';
  title: string;
  content: string;
  actionable: boolean;
  createdAt: Date;
}

export interface PerformanceSummaryResult {
  summary: string;
  winRate: number;
  totalPnl: number;
  totalTrades: number;
  bestStrategy: string | null;
  worstStrategy: string | null;
  recentStreak: string;
}

export interface TradingSuggestion {
  id: string;
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  category: string;
}

@Injectable()
export class AIAdvisorService {
  private readonly logger = new Logger(AIAdvisorService.name);
  private readonly aiEngineUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.aiEngineUrl =
      this.configService.get<string>('AI_ENGINE_URL') ||
      'http://localhost:5000';
  }

  /**
   * Send a question to the Python AI engine with trading context
   */
  async askQuestion(question: string): Promise<AIResponse> {
    const context = await this.buildTradingContext();

    try {
      const response = await firstValueFrom(
        this.httpService.post<AIResponse>(
          `${this.aiEngineUrl}/api/ask-advisor`,
          { question, context },
          { timeout: 30000 },
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.warn(
        'AI engine unreachable — using built-in advisor fallback',
        error?.message ?? error,
      );
      return this.generateBuiltInResponse(question, context);
    }
  }

  // ---------------------------------------------------------------------------
  // Built-in rule-based advisor (fallback when Python engine is unavailable)
  // ---------------------------------------------------------------------------

  private generateBuiltInResponse(
    question: string,
    context: Record<string, any>,
  ): AIResponse {
    const q = question.toLowerCase().trim();

    if (this.matchesTradeAssessment(q)) {
      return this.assessTrade(context);
    }
    if (this.matchesLossAnalysis(q)) {
      return this.analyzeLosses(context.recent_trades ?? []);
    }
    if (this.matchesPerformanceQuery(q)) {
      return this.summarizePerformance(context);
    }
    if (this.matchesImprovementQuery(q)) {
      return this.suggestImprovements(context);
    }
    return this.handleGeneralQuestion(question, context);
  }

  // --- Pattern matchers ---

  private matchesTradeAssessment(q: string): boolean {
    return [
      /should i (take|enter|buy|sell)/,
      /is this.*(good|bad).*(trade|setup|signal)/,
      /(take|enter) this trade/,
      /trade (worth|good)/,
    ].some((p) => p.test(q));
  }

  private matchesLossAnalysis(q: string): boolean {
    return [
      /why.*(lose|lost|losing|loss)/,
      /what went wrong/,
      /losing trades/,
      /why.*(down|red|negative)/,
      /analyze.*(losses|losing)/,
    ].some((p) => p.test(q));
  }

  private matchesPerformanceQuery(q: string): boolean {
    return [
      /how am i doing/,
      /(my|overall).*(performance|results|stats)/,
      /how.*(performing|going)/,
      /(show|tell).*(performance|summary|stats)/,
      /am i.*(profit|doing well|doing good)/,
    ].some((p) => p.test(q));
  }

  private matchesImprovementQuery(q: string): boolean {
    return [
      /what should i (improve|change|fix)/,
      /how.*(improve|better|get better)/,
      /(tips|advice|suggestions)/,
      /what.*(wrong|change|optimize)/,
      /best strategy/,
    ].some((p) => p.test(q));
  }

  // --- Response generators ---

  private assessTrade(context: Record<string, any>): AIResponse {
    const stats = context.stats ?? {};
    const recentTrades: any[] = context.recent_trades ?? [];

    const insights: string[] = [];
    const actions: string[] = [];
    let confidence = 0.5;

    const winRate = stats.win_rate ?? 50;
    if (winRate < 40) {
      insights.push(
        `Your recent win rate is low (${winRate}%), so be selective with entries.`,
      );
      confidence -= 0.15;
      actions.push('Wait for higher-confidence setups');
    } else if (winRate > 60) {
      insights.push(
        `Your win rate is strong at ${winRate}%. Current form supports taking trades.`,
      );
      confidence += 0.1;
    }

    // Losing streak check
    let recentLosses = 0;
    for (const t of recentTrades.slice(0, 5)) {
      if ((t.pnl ?? 0) < 0 && t.status === 'CLOSED') recentLosses++;
      else break;
    }
    if (recentLosses >= 3) {
      insights.push(
        `You are on a ${recentLosses}-trade losing streak. Consider pausing.`,
      );
      confidence -= 0.2;
      actions.push('Take a break and review recent losses before entering');
    } else if (recentLosses === 0 && recentTrades.length >= 3) {
      insights.push(
        'You are on a winning streak. Stay disciplined with your stops.',
      );
      confidence += 0.05;
    }

    const openPositions = stats.open_positions ?? 0;
    if (openPositions >= 4) {
      insights.push(
        `You have ${openPositions} open positions. Adding more increases concentration risk.`,
      );
      actions.push('Consider closing an existing position first');
      confidence -= 0.1;
    }

    let answer: string;
    if (confidence >= 0.6) {
      answer =
        'Based on your recent performance, conditions look favorable for taking a trade. ' +
        'Make sure it fits your risk management rules: proper stop-loss, position sizing, ' +
        'and a minimum 1:2 risk-reward ratio.';
    } else if (confidence >= 0.4) {
      answer =
        'The situation is neutral. While there is no strong reason to avoid trading, ' +
        'be selective and only enter on high-confidence signals. ' +
        'Ensure your stop-loss is tight and position size is conservative.';
    } else {
      answer =
        'I would recommend caution right now. Your recent trading patterns suggest ' +
        'it may be better to sit this one out or reduce size. ' +
        'Focus on reviewing what is not working before adding new positions.';
    }

    if (insights.length === 0) {
      insights.push(
        'Limited context available — trade with standard risk parameters.',
      );
    }
    if (actions.length === 0) {
      actions.push('Verify signal confidence is HIGH or VERY_HIGH before entering');
      actions.push('Set stop-loss and target before placing the order');
    }

    return {
      answer,
      confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100,
      relatedInsights: insights,
      suggestedActions: actions,
    };
  }

  private analyzeLosses(trades: any[]): AIResponse {
    const closedTrades = trades.filter((t: any) => t.status === 'CLOSED');
    const losingTrades = closedTrades.filter((t: any) => (t.pnl ?? 0) < 0);

    if (losingTrades.length === 0) {
      return {
        answer:
          'Great news — you have no losing trades in the recent period! Keep up the discipline.',
        confidence: 0.9,
        relatedInsights: ['No losses detected in recent trades'],
        suggestedActions: ['Continue current strategy execution'],
      };
    }

    const totalLoss = losingTrades.reduce(
      (s: number, t: any) => s + (t.pnl ?? 0),
      0,
    );
    const avgLoss = totalLoss / losingTrades.length;

    const insights: string[] = [];
    const actions: string[] = [];

    // Strategy breakdown
    const stratLosses: Record<string, number> = {};
    for (const t of losingTrades) {
      const strat = t.strategy ?? 'unknown';
      stratLosses[strat] = (stratLosses[strat] ?? 0) + 1;
    }
    const worstStrat = Object.entries(stratLosses).sort(
      (a, b) => b[1] - a[1],
    )[0];
    if (worstStrat && worstStrat[1] >= 2) {
      insights.push(
        `Strategy "${worstStrat[0]}" has ${worstStrat[1]} losing trades — it may need parameter tuning.`,
      );
      actions.push(`Review "${worstStrat[0]}" entry and exit criteria`);
    }

    // Time-of-day analysis
    const hourLosses: Record<number, number> = {};
    for (const t of losingTrades) {
      if (t.entry_time) {
        try {
          const h = new Date(t.entry_time).getHours();
          hourLosses[h] = (hourLosses[h] ?? 0) + 1;
        } catch {
          // ignore parse errors
        }
      }
    }
    const worstHourEntry = Object.entries(hourLosses).sort(
      (a, b) => Number(b[1]) - Number(a[1]),
    )[0];
    if (worstHourEntry && Number(worstHourEntry[1]) >= 2) {
      insights.push(
        `Multiple losses around ${worstHourEntry[0]}:00 — market conditions at this time may not suit your approach.`,
      );
      actions.push(`Consider avoiding trades around ${worstHourEntry[0]}:00`);
    }

    // Side analysis
    const buyLosses = losingTrades.filter((t: any) => t.side === 'BUY').length;
    const sellLosses = losingTrades.filter(
      (t: any) => t.side === 'SELL',
    ).length;
    if (buyLosses > sellLosses * 2 && buyLosses >= 3) {
      insights.push(
        `Most losses (${buyLosses}) are on the BUY side. The market may be in a downtrend — consider more SELL-side setups.`,
      );
      actions.push('Check if market bias aligns with your trade direction');
    }

    const answerParts = [
      `You have ${losingTrades.length} losing trades out of ${closedTrades.length} recent closed trades.`,
      `Total loss: ${totalLoss.toFixed(2)} | Average loss per trade: ${avgLoss.toFixed(2)}.`,
    ];
    if (insights.length > 0) {
      answerParts.push('Here is what I found:');
      insights.forEach((ins, i) => answerParts.push(`${i + 1}. ${ins}`));
    }

    if (actions.length === 0) {
      actions.push('Review your stop-loss placement for recent losing trades');
      actions.push(
        'Consider reducing position size until win rate improves',
      );
    }

    return {
      answer: answerParts.join(' '),
      confidence: 0.75,
      relatedInsights:
        insights.length > 0
          ? insights
          : ['No clear pattern detected in losses'],
      suggestedActions: actions,
    };
  }

  private summarizePerformance(context: Record<string, any>): AIResponse {
    const stats = context.stats ?? {};
    const totalTrades = stats.total_trades ?? 0;
    const winRate = stats.win_rate ?? 0;
    const totalPnl = stats.total_pnl ?? 0;
    const openPositions = stats.open_positions ?? 0;

    if (totalTrades === 0) {
      return {
        answer:
          'You have not closed any trades recently. Start trading to get personalized performance analysis and insights from the AI advisor.',
        confidence: 0.9,
        relatedInsights: ['No recent trading data available'],
        suggestedActions: ['Begin trading to enable AI analysis'],
      };
    }

    const insights: string[] = [];
    const actions: string[] = [];

    const pnlStr = totalPnl >= 0 ? `+${totalPnl.toFixed(2)}` : totalPnl.toFixed(2);
    const rating =
      winRate > 65 ? 'Excellent' : winRate > 50 ? 'Good' : 'Needs Work';

    const answerParts = [
      'Here is your recent performance overview:',
      '',
      `**Trades:** ${totalTrades} closed | **Win Rate:** ${winRate}% | **P&L:** ${pnlStr}`,
      `**Open Positions:** ${openPositions} | **Rating:** ${rating}`,
    ];

    if (winRate >= 60) {
      insights.push(`Strong win rate of ${winRate}% — you are trading well`);
      actions.push('Consider slightly increasing position sizes');
    } else if (winRate >= 45) {
      insights.push(`Decent win rate of ${winRate}% — room for improvement`);
      actions.push('Focus on filtering out low-confidence signals');
    } else {
      insights.push(
        `Win rate of ${winRate}% is below target — review your setup criteria`,
      );
      actions.push('Reduce position sizes and trade only A+ setups');
    }

    if (totalPnl >= 0) {
      insights.push(`Net profitable with ${pnlStr}`);
    } else {
      insights.push(`Currently in drawdown: ${pnlStr}`);
      actions.push('Review risk management rules');
    }

    const dailyPerf: any[] = context.daily_performance ?? [];
    if (dailyPerf.length > 0) {
      const profitDays = dailyPerf.filter((d: any) => (d.pnl ?? 0) > 0).length;
      const lossDays = dailyPerf.filter((d: any) => (d.pnl ?? 0) < 0).length;
      answerParts.push(
        `**Trading Days:** ${dailyPerf.length} | **Green Days:** ${profitDays} | **Red Days:** ${lossDays}`,
      );
    }

    return {
      answer: answerParts.join('\n'),
      confidence: 0.85,
      relatedInsights: insights,
      suggestedActions: actions,
    };
  }

  private suggestImprovements(context: Record<string, any>): AIResponse {
    const trades: any[] = context.recent_trades ?? [];
    const strategies: string[] = context.active_strategies ?? [];
    const closedTrades = trades.filter((t: any) => t.status === 'CLOSED');

    if (closedTrades.length < 3) {
      return {
        answer:
          'I need more trade data to provide meaningful improvement suggestions. ' +
          'Keep logging your trades and I will analyze patterns as they emerge.',
        confidence: 0.5,
        relatedInsights: ['Insufficient data for pattern analysis'],
        suggestedActions: ['Continue trading to build analysis dataset'],
      };
    }

    const insights: string[] = [];
    const actions: string[] = [];

    // Per-strategy stats
    const stratStats: Record<
      string,
      { wins: number; losses: number; pnl: number }
    > = {};
    for (const t of closedTrades) {
      const strat = t.strategy ?? 'unknown';
      if (!stratStats[strat]) stratStats[strat] = { wins: 0, losses: 0, pnl: 0 };
      if ((t.pnl ?? 0) > 0) stratStats[strat].wins++;
      else stratStats[strat].losses++;
      stratStats[strat].pnl += t.pnl ?? 0;
    }

    let bestStrat: string | null = null;
    let bestWr = -1;
    let worstStrat: string | null = null;
    let worstWr = 101;

    for (const [name, s] of Object.entries(stratStats)) {
      const total = s.wins + s.losses;
      if (total >= 3) {
        const wr = (s.wins / total) * 100;
        if (wr > bestWr) { bestWr = wr; bestStrat = name; }
        if (wr < worstWr) { worstWr = wr; worstStrat = name; }
      }
    }

    const answerParts = ['Here are my suggestions to improve your trading:'];

    if (bestStrat) {
      answerParts.push(
        `\n**Best Strategy:** ${bestStrat} (${bestWr.toFixed(0)}% win rate) — consider allocating more capital here.`,
      );
      insights.push(`"${bestStrat}" is your strongest strategy`);
      actions.push(`Increase allocation to "${bestStrat}"`);
    }
    if (worstStrat && worstStrat !== bestStrat && worstWr < 40) {
      answerParts.push(
        `\n**Weakest Strategy:** ${worstStrat} (${worstWr.toFixed(0)}% win rate) — review parameters or reduce usage.`,
      );
      insights.push(`"${worstStrat}" is underperforming`);
      actions.push(`Review or pause "${worstStrat}"`);
    }

    // Risk-reward ratio
    const winningTrades = closedTrades.filter((t: any) => (t.pnl ?? 0) > 0);
    const losingTrades = closedTrades.filter((t: any) => (t.pnl ?? 0) < 0);
    if (winningTrades.length > 0 && losingTrades.length > 0) {
      const avgWin =
        winningTrades.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0) /
        winningTrades.length;
      const avgLoss = Math.abs(
        losingTrades.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0) /
          losingTrades.length,
      );
      const rrRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

      if (rrRatio < 1.0) {
        answerParts.push(
          `\n**Risk-Reward:** Your average win (${avgWin.toFixed(2)}) is smaller than your average loss (${avgLoss.toFixed(2)}). Aim for at least 1:2 risk-reward.`,
        );
        insights.push('Risk-reward ratio is below 1:1');
        actions.push('Set wider targets or tighter stop-losses');
      } else if (rrRatio >= 2.0) {
        answerParts.push(
          `\n**Risk-Reward:** Excellent ratio of ${rrRatio.toFixed(1)}:1. Your winners are significantly larger than losers.`,
        );
        insights.push(`Strong risk-reward ratio of ${rrRatio.toFixed(1)}:1`);
      }
    }

    // Unused strategies
    const usedStrats = new Set(Object.keys(stratStats));
    const unused = strategies.filter((s) => !usedStrats.has(s));
    if (unused.length > 0) {
      answerParts.push(
        `\n**Unused Strategies:** ${unused.join(', ')} — consider testing them to diversify your approach.`,
      );
      actions.push(`Paper-trade ${unused[0]} to evaluate its performance`);
    }

    if (actions.length === 0) {
      actions.push('Maintain current discipline and continue logging trades');
    }

    return {
      answer: answerParts.join('\n'),
      confidence: 0.8,
      relatedInsights:
        insights.length > 0
          ? insights
          : ['Trading patterns look reasonable overall'],
      suggestedActions: actions,
    };
  }

  private handleGeneralQuestion(
    question: string,
    context: Record<string, any>,
  ): AIResponse {
    const stats = context.stats ?? {};
    const recentTrades: any[] = context.recent_trades ?? [];
    const strategies: string[] = context.active_strategies ?? [];

    const totalTrades = stats.total_trades ?? 0;
    const winRate = stats.win_rate ?? 0;
    const totalPnl = stats.total_pnl ?? 0;

    const q = question.toLowerCase();
    const insights: string[] = [];
    const actions: string[] = [];
    let answer: string;

    if (/risk|stop|stoploss/.test(q)) {
      answer =
        'Risk management is the most important factor in long-term trading success. ' +
        'Here are key principles:\n\n' +
        '1. Never risk more than 1-2% of your capital on a single trade\n' +
        '2. Always place stop-losses before entering a trade\n' +
        '3. Maintain a minimum risk-reward ratio of 1:2\n' +
        '4. Set a daily loss limit and stop trading when hit\n' +
        '5. Reduce position sizes during losing streaks';
      insights.push(
        'Risk management is the foundation of consistent profits',
      );
      actions.push('Review your current stop-loss placement strategy');
    } else if (/strateg(y|ies)/.test(q)) {
      const active =
        strategies.length > 0 ? strategies.join(', ') : 'none configured';
      answer = `Your active strategies: ${active}.\n\nRecent performance: ${totalTrades} trades with ${winRate}% win rate.`;
      if (totalTrades > 0) {
        answer +=
          ' I recommend focusing on strategies that show consistent results in the current market regime and reducing exposure to underperformers.';
      }
      insights.push(`Active strategies: ${active}`);
      actions.push('Review strategy performance in the Portfolio tab');
    } else if (/market|trend|direction/.test(q)) {
      answer =
        'I analyze your trading data and patterns rather than predicting market direction. ' +
        'Based on your recent trades, I can tell you:\n\n';
      if (recentTrades.length > 0) {
        const buyCount = recentTrades.filter(
          (t: any) => t.side === 'BUY',
        ).length;
        const sellCount = recentTrades.filter(
          (t: any) => t.side === 'SELL',
        ).length;
        const pnlLabel = totalPnl >= 0 ? '+' : '';
        answer +=
          `- Recent trade bias: ${buyCount} BUY vs ${sellCount} SELL\n` +
          `- Win rate: ${winRate}%\n` +
          `- P&L: ${pnlLabel}${totalPnl.toFixed(2)}\n\n` +
          'Align your trade direction with market structure for better results.';
      } else {
        answer += 'No recent trade data available to analyze bias.';
      }
      insights.push(
        'Trade direction should align with market structure',
      );
      actions.push(
        'Check signal confidence before entering directional trades',
      );
    } else {
      answer =
        'I am your AI trading advisor. Here is what I can help with:\n\n' +
        '- **"How am I doing?"** — Performance summary\n' +
        '- **"Why did I lose?"** — Loss pattern analysis\n' +
        '- **"Should I take this trade?"** — Trade assessment\n' +
        '- **"What should I improve?"** — Improvement suggestions\n\n' +
        'You can also ask about risk management, strategies, or specific trades.';
      if (totalTrades > 0) {
        const pnlLabel = totalPnl >= 0 ? '+' : '';
        answer += `\n\nQuick stats: ${totalTrades} trades | ${winRate}% win rate | P&L: ${pnlLabel}${totalPnl.toFixed(2)}`;
      }
      insights.push('Try asking specific questions for better insights');
      actions.push('Ask about your performance or recent losses');
    }

    return {
      answer,
      confidence: 0.6,
      relatedInsights: insights,
      suggestedActions: actions,
    };
  }

  /**
   * Generate current insights based on recent trading data
   */
  async getInsights(): Promise<AIInsightResult[]> {
    const insights: AIInsightResult[] = [];
    const now = new Date();

    // Fetch recent trades (last 7 days)
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const recentTrades = await this.prisma.trade.findMany({
      where: { createdAt: { gte: weekAgo }, status: 'CLOSED' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    if (recentTrades.length === 0) {
      insights.push({
        id: 'no-trades',
        type: 'suggestion',
        title: 'No recent trades detected',
        content:
          'Start trading to receive personalized insights and performance analysis from the AI advisor.',
        actionable: false,
        createdAt: now,
      });
      return insights;
    }

    // Win rate insight
    const wins = recentTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    const winRate =
      recentTrades.length > 0
        ? Math.round((wins / recentTrades.length) * 100)
        : 0;

    if (winRate < 40) {
      insights.push({
        id: 'low-winrate',
        type: 'warning',
        title: 'Win rate below 40%',
        content: `Your win rate this week is ${winRate}%. Consider reviewing your entry criteria and risk management. Focus on higher-confidence setups.`,
        actionable: true,
        createdAt: now,
      });
    } else if (winRate > 65) {
      insights.push({
        id: 'high-winrate',
        type: 'analysis',
        title: 'Strong win rate this week',
        content: `Excellent performance with a ${winRate}% win rate across ${recentTrades.length} trades. Keep executing your current approach consistently.`,
        actionable: false,
        createdAt: now,
      });
    }

    // P&L insight
    const totalPnl = recentTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    insights.push({
      id: 'weekly-pnl',
      type: totalPnl >= 0 ? 'analysis' : 'warning',
      title: `Weekly P&L: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`,
      content:
        totalPnl >= 0
          ? `You have earned ${totalPnl.toFixed(2)} this week from ${recentTrades.length} closed trades. Your average win is consistent.`
          : `You are down ${Math.abs(totalPnl).toFixed(2)} this week. Review losing trades for common patterns and consider reducing position sizes.`,
      actionable: totalPnl < 0,
      createdAt: now,
    });

    // Strategy diversity insight
    const strategies = new Set(recentTrades.map((t) => t.strategy).filter(Boolean));
    if (strategies.size === 1) {
      insights.push({
        id: 'single-strategy',
        type: 'suggestion',
        title: 'Diversify your strategies',
        content:
          'All recent trades use a single strategy. Consider exploring other strategies to reduce risk concentration.',
        actionable: true,
        createdAt: now,
      });
    }

    // Losing streak detection
    const sortedTrades = [...recentTrades].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    let losingStreak = 0;
    for (const trade of sortedTrades) {
      if ((trade.pnl ?? 0) < 0) losingStreak++;
      else break;
    }
    if (losingStreak >= 3) {
      insights.push({
        id: 'losing-streak',
        type: 'warning',
        title: `${losingStreak}-trade losing streak`,
        content: `You have ${losingStreak} consecutive losses. Consider pausing to reassess market conditions and your strategy parameters before taking the next trade.`,
        actionable: true,
        createdAt: now,
      });
    }

    return insights;
  }

  /**
   * Deep analysis of a specific trade via the Python AI engine
   */
  async analyzeTrade(tradeId: string) {
    const trade = await this.prisma.trade.findUnique({
      where: { id: tradeId },
      include: { instrument: true, signal: true },
    });

    if (!trade) {
      throw new Error(`Trade ${tradeId} not found`);
    }

    // Fetch recent candles for market context
    const candles = trade.instrument
      ? await this.prisma.candle.findMany({
          where: {
            instrumentId: trade.instrumentId,
            timeframe: '5m',
            timestamp: {
              gte: new Date(
                (trade.entryTime ?? trade.createdAt).getTime() -
                  60 * 60 * 1000,
              ),
              lte: trade.entryTime ?? trade.createdAt,
            },
          },
          orderBy: { timestamp: 'asc' },
          take: 20,
        })
      : [];

    const tradeInput = {
      symbol: trade.instrument?.symbol ?? 'UNKNOWN',
      side: trade.side,
      entry_price: trade.entryPrice ?? 0,
      exit_price: trade.exitPrice ?? 0,
      entry_time: trade.entryTime?.toISOString() ?? '',
      exit_time: trade.exitTime?.toISOString() ?? '',
      pnl: trade.pnl ?? 0,
      strategy: trade.strategy ?? 'unknown',
      stoploss_price: trade.stoploss ?? null,
      target_price: trade.target ?? null,
    };

    const marketContext = {
      candles_at_entry: candles.map((c) => ({
        timestamp: c.timestamp.toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: Number(c.volume),
      })),
      market_regime: 'unknown',
      volume_at_entry: candles.length > 0 ? Number(candles[candles.length - 1].volume) : 0,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post<any>(
          `${this.aiEngineUrl}/api/analyze-trade`,
          { trade: tradeInput, market_context: marketContext },
          { timeout: 30000 },
        ),
      );

      // Store analysis in DB
      await this.prisma.aITradeAnalysis.create({
        data: {
          // Engine-generated analysis runs with no tenant context → stamp the
          // ADMIN owner so the NOT NULL userId column (TDA-001) is satisfied.
          userId: SYSTEM_USER_ID,
          tradeId,
          analysis: JSON.stringify(response.data.analysis),
          suggestions: JSON.stringify(
            response.data.analysis?.improvement_suggestions ?? [],
          ),
          patterns: JSON.stringify(response.data.patterns_detected ?? []),
          score: response.data.score ?? 0,
        },
      });

      return response.data;
    } catch (error) {
      this.logger.error(`Failed to analyze trade ${tradeId}`, error);
      throw new Error('AI engine is unavailable. Please try again later.');
    }
  }

  /**
   * Natural language summary of recent performance
   */
  async getPerformanceSummary(): Promise<PerformanceSummaryResult> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const recentTrades = await this.prisma.trade.findMany({
      where: { createdAt: { gte: weekAgo }, status: 'CLOSED' },
      include: { instrument: true },
    });

    const totalPnl = recentTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const wins = recentTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    const winRate =
      recentTrades.length > 0
        ? Math.round((wins / recentTrades.length) * 100)
        : 0;

    // Strategy performance
    const stratMap = new Map<string, { pnl: number; count: number }>();
    for (const t of recentTrades) {
      const strat = t.strategy ?? 'unknown';
      const current = stratMap.get(strat) ?? { pnl: 0, count: 0 };
      current.pnl += t.pnl ?? 0;
      current.count += 1;
      stratMap.set(strat, current);
    }

    let bestStrategy: string | null = null;
    let worstStrategy: string | null = null;
    let bestPnl = -Infinity;
    let worstPnl = Infinity;
    for (const [name, stats] of stratMap) {
      if (stats.pnl > bestPnl) {
        bestPnl = stats.pnl;
        bestStrategy = name;
      }
      if (stats.pnl < worstPnl) {
        worstPnl = stats.pnl;
        worstStrategy = name;
      }
    }

    // Recent streak
    const sorted = [...recentTrades].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    let streak = 0;
    let streakType: 'winning' | 'losing' | 'none' = 'none';
    if (sorted.length > 0) {
      const firstPnl = sorted[0].pnl ?? 0;
      streakType = firstPnl >= 0 ? 'winning' : 'losing';
      for (const t of sorted) {
        const isWin = (t.pnl ?? 0) >= 0;
        if ((streakType === 'winning' && isWin) || (streakType === 'losing' && !isWin)) {
          streak++;
        } else break;
      }
    }

    const summaryParts: string[] = [];
    if (recentTrades.length === 0) {
      summaryParts.push('No trades closed this week yet.');
    } else {
      summaryParts.push(
        `This week you closed ${recentTrades.length} trade${recentTrades.length !== 1 ? 's' : ''} with a ${totalPnl >= 0 ? 'profit' : 'loss'} of ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}.`,
      );
      summaryParts.push(`Your win rate stands at ${winRate}%.`);
      if (bestStrategy && stratMap.size > 1) {
        summaryParts.push(
          `Best performing strategy: ${bestStrategy} (+${bestPnl.toFixed(2)}).`,
        );
      }
      if (streak >= 3) {
        summaryParts.push(
          `You are on a ${streak}-trade ${streakType} streak.`,
        );
      }
    }

    return {
      summary: summaryParts.join(' '),
      winRate,
      totalPnl: Number(totalPnl.toFixed(2)),
      totalTrades: recentTrades.length,
      bestStrategy,
      worstStrategy,
      recentStreak: streak >= 2 ? `${streak} ${streakType}` : 'none',
    };
  }

  /**
   * Actionable suggestions based on trading patterns
   */
  async getTradingSuggestions(): Promise<TradingSuggestion[]> {
    const suggestions: TradingSuggestion[] = [];
    const now = new Date();
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const trades = await this.prisma.trade.findMany({
      where: { createdAt: { gte: twoWeeksAgo }, status: 'CLOSED' },
      include: { instrument: true },
    });

    if (trades.length < 3) {
      suggestions.push({
        id: 'more-data',
        title: 'More trades needed',
        description:
          'Execute more trades so the AI can identify patterns and provide actionable suggestions.',
        priority: 'low',
        category: 'general',
      });
      return suggestions;
    }

    // Analyze by strategy
    const stratMap = new Map<
      string,
      { wins: number; losses: number; totalPnl: number }
    >();
    for (const t of trades) {
      const strat = t.strategy ?? 'unknown';
      const cur = stratMap.get(strat) ?? { wins: 0, losses: 0, totalPnl: 0 };
      if ((t.pnl ?? 0) > 0) cur.wins++;
      else cur.losses++;
      cur.totalPnl += t.pnl ?? 0;
      stratMap.set(strat, cur);
    }

    for (const [name, stats] of stratMap) {
      const total = stats.wins + stats.losses;
      const wr = total > 0 ? (stats.wins / total) * 100 : 0;

      if (total >= 5 && wr < 35) {
        suggestions.push({
          id: `weak-strat-${name}`,
          title: `Review "${name}" strategy`,
          description: `This strategy has only a ${wr.toFixed(0)}% win rate over ${total} trades with P&L of ${stats.totalPnl.toFixed(2)}. Consider adjusting parameters or pausing it.`,
          priority: 'high',
          category: 'strategy',
        });
      } else if (total >= 5 && wr > 65) {
        suggestions.push({
          id: `strong-strat-${name}`,
          title: `Increase allocation to "${name}"`,
          description: `With a ${wr.toFixed(0)}% win rate over ${total} trades, this strategy is performing well. Consider increasing position sizes cautiously.`,
          priority: 'medium',
          category: 'strategy',
        });
      }
    }

    // Check for oversized losses
    const bigLosses = trades.filter(
      (t) => (t.pnl ?? 0) < 0 && Math.abs(t.pnl ?? 0) > (t.entryPrice ?? 1) * (t.quantity ?? 1) * 0.03,
    );
    if (bigLosses.length >= 2) {
      suggestions.push({
        id: 'big-losses',
        title: 'Tighten stop losses',
        description: `You have ${bigLosses.length} trades with large losses (>3% of position). Consider tightening stop-loss levels or reducing position sizes.`,
        priority: 'high',
        category: 'risk',
      });
    }

    // Check if trades cluster at certain times
    const hourMap = new Map<number, { wins: number; total: number }>();
    for (const t of trades) {
      const hour = (t.entryTime ?? t.createdAt).getHours();
      const cur = hourMap.get(hour) ?? { wins: 0, total: 0 };
      cur.total++;
      if ((t.pnl ?? 0) > 0) cur.wins++;
      hourMap.set(hour, cur);
    }

    let worstHour: number | null = null;
    let worstHourWr = 100;
    for (const [hour, stats] of hourMap) {
      if (stats.total >= 3) {
        const wr = (stats.wins / stats.total) * 100;
        if (wr < worstHourWr) {
          worstHourWr = wr;
          worstHour = hour;
        }
      }
    }
    if (worstHour !== null && worstHourWr < 30) {
      suggestions.push({
        id: 'bad-hour',
        title: `Avoid trading around ${worstHour}:00`,
        description: `Your win rate at ${worstHour}:00 is only ${worstHourWr.toFixed(0)}%. Consider avoiding trades during this hour.`,
        priority: 'medium',
        category: 'timing',
      });
    }

    if (suggestions.length === 0) {
      suggestions.push({
        id: 'all-good',
        title: 'Looking good',
        description:
          'No significant issues detected in your recent trading patterns. Keep up the discipline.',
        priority: 'low',
        category: 'general',
      });
    }

    return suggestions;
  }

  /**
   * Build context object sent to Python AI engine
   */
  private async buildTradingContext() {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [recentTrades, settings, dailyPerf] = await Promise.all([
      this.prisma.trade.findMany({
        where: { createdAt: { gte: weekAgo } },
        include: { instrument: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.userSettings.findFirst(),
      this.prisma.dailyPerformance.findMany({
        where: { date: { gte: weekAgo } },
        orderBy: { date: 'desc' },
      }),
    ]);

    const closedTrades = recentTrades.filter((t) => t.status === 'CLOSED');
    const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate =
      closedTrades.length > 0
        ? Math.round((wins / closedTrades.length) * 100)
        : 0;

    return {
      recent_trades: recentTrades.map((t) => ({
        symbol: t.instrument?.symbol ?? 'UNKNOWN',
        side: t.side,
        strategy: t.strategy ?? 'unknown',
        pnl: t.pnl ?? 0,
        status: t.status,
        entry_price: t.entryPrice ?? 0,
        exit_price: t.exitPrice ?? 0,
        entry_time: t.entryTime?.toISOString() ?? '',
        exit_time: t.exitTime?.toISOString() ?? '',
      })),
      stats: {
        total_trades: closedTrades.length,
        win_rate: winRate,
        total_pnl: Number(totalPnl.toFixed(2)),
        open_positions: recentTrades.filter((t) => t.status === 'OPEN').length,
      },
      active_strategies: settings?.activeStrategies ?? [],
      daily_performance: dailyPerf.map((dp) => ({
        date: dp.date.toISOString().split('T')[0],
        pnl: dp.totalPnl,
        trades: dp.totalTrades,
        wins: dp.winningTrades,
        losses: dp.losingTrades,
      })),
    };
  }
}
