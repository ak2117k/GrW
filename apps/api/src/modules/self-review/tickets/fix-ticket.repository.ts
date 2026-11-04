import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { FixTicketDraft } from './decision-loop';
import { sortQueue, type FixTicketRecord } from './fix-queue';

/** The slice of Prisma this repository uses (typed structurally so a test double implements just this). */
export interface FixTicketStore {
  fixTicket: {
    findUnique(args: { where: { key: string } }): Promise<FixTicketRecord | null>;
    findMany(args: { where?: Record<string, unknown>; take?: number; orderBy?: unknown }): Promise<FixTicketRecord[]>;
    create(args: { data: Record<string, unknown> }): Promise<FixTicketRecord>;
    update(args: { where: { key: string }; data: Record<string, unknown> }): Promise<FixTicketRecord>;
  };
}

/** Evidence refIds kept per ticket (the newest). */
export const TICKET_REFS_KEPT = 200;

interface StoredEvidence {
  cause?: string;
  sessions?: string[];
  kinds?: string[];
  symbols?: string[];
  refIds?: string[];
  reopened?: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/**
 * What to write for one sighting of a ticket (pure). A new key creates an OPEN ticket. A known key never makes a
 * second row: occurrences and costRupees grow by the misses not seen before (a re-run of the same night adds
 * nothing), lastSeen moves, the latest wording of the change / files / test replaces the old, the title stays.
 * A DONE ticket that comes back with new misses reopens (the fix did not hold); WONTFIX stays WONTFIX.
 */
export function mergeTicket(existing: FixTicketRecord | null, d: FixTicketDraft, now: Date): { create?: Record<string, unknown>; update?: Record<string, unknown> } {
  if (!existing) {
    return {
      create: {
        key: d.key, cause: d.cause, title: d.title, proposedChange: d.proposedChange, files: d.files, testDescription: d.testDescription,
        status: 'OPEN', occurrences: Math.max(1, d.refIds.length), costRupees: d.costRupees, firstSeen: now, lastSeen: now,
        evidence: { ...d.evidence, refIds: d.refIds.slice(-TICKET_REFS_KEPT) },
      },
    };
  }
  const ev = (existing.evidence && typeof existing.evidence === 'object' ? existing.evidence : {}) as StoredEvidence;
  const seen = new Set(strings(ev.refIds));
  const fresh = d.refIds.filter((r) => !seen.has(r));
  const addCost = fresh.reduce((s, r) => s + (d.refCosts[r] ?? 0), 0);
  const reopen = existing.status === 'DONE' && fresh.length > 0;
  const evidence: StoredEvidence = {
    cause: d.evidence.cause || ev.cause,
    sessions: [...new Set([...strings(ev.sessions), ...d.evidence.sessions])].sort().slice(-30),
    kinds: [...new Set([...strings(ev.kinds), ...d.evidence.kinds])].sort(),
    symbols: [...new Set([...strings(ev.symbols), ...d.evidence.symbols])].sort().slice(-50),
    refIds: [...strings(ev.refIds), ...fresh].slice(-TICKET_REFS_KEPT),
    ...(reopen || ev.reopened ? { reopened: [...strings(ev.reopened), ...(reopen ? [d.sessionDate] : [])] } : {}),
  };
  return {
    update: {
      occurrences: existing.occurrences + fresh.length,
      costRupees: existing.costRupees + addCost,
      lastSeen: now,
      evidence,
      ...(d.proposedChange ? { proposedChange: d.proposedChange } : {}),
      ...(d.files.length ? { files: d.files } : {}),
      ...(d.testDescription ? { testDescription: d.testDescription } : {}),
      ...(reopen ? { status: 'OPEN' } : {}),
    },
  };
}

/** `fix_tickets`: upsert by key, the queue for the endpoint. */
@Injectable()
export class FixTicketRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get store(): FixTicketStore['fixTicket'] {
    return (this.prisma as unknown as FixTicketStore).fixTicket;
  }

  async upsert(d: FixTicketDraft, now: Date = new Date()): Promise<FixTicketRecord> {
    const existing = await this.store.findUnique({ where: { key: d.key } });
    const w = mergeTicket(existing, d, now);
    if (w.create) {
      try {
        return await this.store.create({ data: w.create });
      } catch (e) {
        // Lost a create race on the unique key (a manual run beside the cron): merge into the winner instead.
        const winner = await this.store.findUnique({ where: { key: d.key } });
        if (!winner) throw e;
        return this.store.update({ where: { key: d.key }, data: mergeTicket(winner, d, now).update ?? {} });
      }
    }
    return this.store.update({ where: { key: d.key }, data: w.update ?? {} });
  }

  /** OPEN first, then cost, then lastSeen; `status` narrows. */
  async queue(status?: string, limit = 200): Promise<FixTicketRecord[]> {
    const rows = await this.store.findMany({ where: status ? { status } : {}, take: Math.min(Math.max(limit, 1), 500), orderBy: { lastSeen: 'desc' } });
    return sortQueue(rows);
  }
}
