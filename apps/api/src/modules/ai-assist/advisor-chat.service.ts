import { Injectable, Logger } from '@nestjs/common';
import { ADVISOR_SYSTEM_PROMPT, advisorUserTurn, classifyAdvisorQuestion } from './advisor-guardrail';
import { AssistContextService, renderAssistContext } from './assist-context.service';
import { AssistLlmService, type AssistPrincipal } from './assist-llm.service';
import { ASSIST_BUSY_MESSAGE, AssistBusyError } from './assist-slot';

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
  ) {}

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
      const ctx = await this.context.forUser(user.userId);
      const reply = await this.llm.complete(
        'assist.advisor',
        ADVISOR_SYSTEM_PROMPT,
        advisorUserTurn(question, renderAssistContext(ctx)),
        { userId: user.userId },
      );
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
}
