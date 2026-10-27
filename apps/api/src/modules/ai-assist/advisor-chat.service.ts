import { Injectable, Logger, Optional } from '@nestjs/common';
import { NightReportSummaryService } from '../night-report/services/night-report-summary.service';
import { AdvisorMemoryRepository, renderAdvisorHistory } from './advisor-memory';
import { ADVISOR_SYSTEM_PROMPT, advisorUserTurn, classifyAdvisorQuestion } from './advisor-guardrail';
import { AssistContextService, renderAssistContext } from './assist-context.service';
import { AssistLlmService, type AssistPrincipal } from './assist-llm.service';
import { ASSIST_BUSY_MESSAGE, AssistBusyError } from './assist-slot';
import { renderResearch } from './research/research-data';
import { AdvisorResearchService } from './research/research.service';

/** Same shape as `AIAdvisorService`'s `AIResponse`, so the web chat is unchanged. */
export interface AdvisorChatAnswer {
  answer: string;
  confidence: number;
  relatedInsights: string[];
  suggestedActions: string[];
  /** Where the answer came from — for the ledger-free debugging of "why this reply". */
  source: 'guardrail' | 'claude' | 'busy';
}

/**
 * The AI Trading Advisor chat over the Claude session.
 *
 * `guard(question)` is layer (a) — the deterministic pre-check — and applies to
 * EVERY asker, before any model or AI-engine call. `ask()` is the owner-only
 * Claude path; it returns null when the asker may not use the session or the
 * call failed for a reason other than "busy", and the caller then falls back to
 * its existing (AI engine / built-in) answer.
 */
@Injectable()
export class AdvisorChatService {
  private readonly logger = new Logger(AdvisorChatService.name);

  constructor(
    private readonly llm: AssistLlmService,
    private readonly context: AssistContextService,
    private readonly memory: AdvisorMemoryRepository,
    @Optional() private readonly nightReport?: NightReportSummaryService,
    @Optional() private readonly research?: AdvisorResearchService,
  ) {}

  /** "New chat": forget the user's advisor conversation. */
  async clearConversation(userId: string): Promise<{ cleared: number }> {
    return { cleared: await this.memory.clear(userId) };
  }

  /** Layer (a): a refusal answer when the question is blocked, else null. */
  guard(question: string): AdvisorChatAnswer | null {
    const verdict = classifyAdvisorQuestion(question);
    if (verdict.allowed) return null;
    return { answer: verdict.message, confidence: 100, relatedInsights: [], suggestedActions: [], source: 'guardrail' };
  }

  async ask(question: string, user: AssistPrincipal | undefined): Promise<AdvisorChatAnswer | null> {
    const blocked = this.guard(question);
    if (blocked) return blocked;
    if (!user || !this.llm.allowed(user)) return null;
    try {
      const [ctx, history, night, research] = await Promise.all([
        this.context.forUser(user.userId),
        this.memory.recent(user.userId),
        this.nightReport ? this.nightReport.summaryFor(user.userId) : Promise.resolve(null),
        this.researchFor(question, user.userId),
      ]);
      const reply = await this.llm.complete(
        'assist.advisor',
        ADVISOR_SYSTEM_PROMPT,
        advisorUserTurn(question, renderAssistContext(ctx), {
          nightReport: night,
          history: history.length ? renderAdvisorHistory(history) : null,
          research,
        }),
        { userId: user.userId },
      );
      if (!reply.offTopic) await this.memory.append(user.userId, question, reply.answer);
      return {
        answer: reply.answer,
        confidence: reply.confidence,
        relatedInsights: [],
        suggestedActions: [],
        source: 'claude',
      };
    } catch (err) {
      if (err instanceof AssistBusyError) {
        return { answer: ASSIST_BUSY_MESSAGE, confidence: 0, relatedInsights: [], suggestedActions: [], source: 'busy' };
      }
      this.logger.warn(`advisor Claude call failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** A research question on one F&O underlying → its market data as text (null for a normal question). */
  private async researchFor(question: string, userId: string): Promise<string | null> {
    if (!this.research) return null;
    const intent = await this.research.intentOf(question);
    if (!intent) return null;
    const data = await this.research.gatherWithin(intent, userId);
    if (!data) return `symbol: ${intent.symbol} | NOT AVAILABLE: the market data could not be fetched in time — say so.`;
    this.logger.log(`[advisor-research] ${intent.symbol} ${data.expiry ?? '?'}: chain ${data.chain ? 'yes' : 'no'}, build-up ${data.futures?.days.length ?? 0} days, missing ${data.missing.length}`);
    return renderResearch(data);
  }
}
