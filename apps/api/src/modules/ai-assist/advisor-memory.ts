import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/** How many past messages (user + assistant) go back to the advisor with a new question. */
export const ADVISOR_MEMORY_MAX_MESSAGES = 8;
/** Character budget for that history block (~750 tokens). */
export const ADVISOR_MEMORY_MAX_CHARS = 3000;
/** One stored message is clipped to this many chars before it is saved. */
const STORED_MESSAGE_MAX_CHARS = 2000;

export interface AdvisorTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Newest-last history trimmed to the last `maxMessages` and to `maxChars` total, dropping the
 * OLDEST messages first; a single message longer than the whole budget is tail-clipped. Pure.
 */
export function trimAdvisorHistory(
  turns: readonly AdvisorTurn[],
  maxMessages = ADVISOR_MEMORY_MAX_MESSAGES,
  maxChars = ADVISOR_MEMORY_MAX_CHARS,
): AdvisorTurn[] {
  const recent = turns.slice(-maxMessages);
  const out: AdvisorTurn[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i];
    const room = maxChars - used;
    if (room <= 0) break;
    if (t.content.length > room) {
      if (out.length === 0) out.unshift({ role: t.role, content: `…${t.content.slice(-(room - 1))}` });
      break;
    }
    out.unshift(t);
    used += t.content.length;
  }
  return out;
}

/** Plain-text rendering for the prompt's <conversation> block. */
export function renderAdvisorHistory(turns: readonly AdvisorTurn[]): string {
  return turns.map((t) => `${t.role === 'user' ? 'Owner' : 'Advisor'}: ${t.content}`).join('\n\n');
}

/**
 * Server-side, per-user advisor memory (`advisor_chat_turns`). Fail-soft: a read error is an empty
 * history and a write error is logged, never thrown — memory must not break the chat.
 */
@Injectable()
export class AdvisorMemoryRepository {
  private readonly logger = new Logger(AdvisorMemoryRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async recent(userId: string): Promise<AdvisorTurn[]> {
    try {
      const rows = await this.prisma.advisorChatTurn.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: ADVISOR_MEMORY_MAX_MESSAGES,
        select: { role: true, content: true },
      });
      return trimAdvisorHistory(
        rows.reverse().map((r) => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content })),
      );
    } catch (err) {
      this.logger.warn(`advisor memory read failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Saves one exchange and prunes the user's rows beyond the window. */
  async append(userId: string, question: string, answer: string, now: Date = new Date()): Promise<void> {
    try {
      await this.prisma.advisorChatTurn.createMany({
        data: [
          { userId, role: 'user', content: question.slice(0, STORED_MESSAGE_MAX_CHARS), createdAt: now },
          { userId, role: 'assistant', content: answer.slice(0, STORED_MESSAGE_MAX_CHARS), createdAt: new Date(now.getTime() + 1) },
        ],
      });
      const keep = await this.prisma.advisorChatTurn.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: ADVISOR_MEMORY_MAX_MESSAGES,
        select: { id: true },
      });
      await this.prisma.advisorChatTurn.deleteMany({ where: { userId, id: { notIn: keep.map((k) => k.id) } } });
    } catch (err) {
      this.logger.warn(`advisor memory write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async clear(userId: string): Promise<number> {
    const r = await this.prisma.advisorChatTurn.deleteMany({ where: { userId } });
    return r.count;
  }
}
