import { Controller, Get, Query, Res } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { AdminOnly } from '../decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, VerifyResult } from './audit.service';

/** Hard ceiling on a single list page, regardless of the requested `limit`. */
const MAX_LIMIT = 1000;
/** Default page size when `limit` is absent or unparseable. */
const DEFAULT_LIMIT = 100;

/** The columns returned VERBATIM to an auditor (chain fields included). */
const ROW_SELECT = {
  id: true,
  chainKey: true,
  seq: true,
  action: true,
  userId: true,
  target: true,
  meta: true,
  prevHash: true,
  hash: true,
  createdAt: true,
} satisfies Prisma.AuditLogSelect;

type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof ROW_SELECT }>;

/** Shape returned to the client — `seq` (BigInt) flattened to a string. */
type SerialisedRow = Omit<AuditRow, 'seq'> & { seq: string };

/**
 * Read-only audit surface (TDA-008, spec §7). ADMIN-only at the CLASS level via
 * {@link AdminOnly}; the global JwtAuthGuard → RolesGuard pipeline enforces it.
 *
 * No global `/api` prefix is set on the app, so the controller path carries it:
 * the live routes are `/api/admin/audit`, `/api/admin/audit/verify`,
 * `/api/admin/audit/export`.
 *
 * AuditLog is NOT a tenant model, so every read here is UNSCOPED (no tenant
 * context). This controller is a pure READER — {@link AuditService.append}
 * remains the only writer. `seq` is a `BigInt` (not JSON-serialisable), so every
 * response stringifies it.
 */
@AdminOnly()
@Controller('api/admin/audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Paginated list of audit rows in `seq` order. Filters (all optional):
   * `action`, `userId`, `chainKey` (exact), `from`/`to` (on `createdAt`),
   * `cursor` (exclusive lower bound on `seq`), `limit` (≤ {@link MAX_LIMIT}).
   * Rows are returned verbatim incl. chain fields; `seq` is stringified.
   */
  @Get()
  async list(
    @Query('action') action?: string,
    @Query('userId') userId?: string,
    @Query('chainKey') chainKey?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: SerialisedRow[]; nextCursor: string | null }> {
    const take = parseLimit(limit);
    const rows = await this.prisma.auditLog.findMany({
      where: buildWhere({ action, userId, chainKey, from, to, cursor }),
      orderBy: { seq: 'asc' },
      take: take + 1, // fetch one extra to detect a further page
      select: ROW_SELECT,
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? page[page.length - 1].seq.toString() : null;

    return { items: page.map(serialiseRow), nextCursor };
  }

  /**
   * Verify a chain end-to-end via {@link AuditService.verifyChain}. `chainKey`
   * defaults to `'global'`. Any BigInt in the result (`firstBrokenSeq`,
   * `head.seq`) is stringified.
   */
  @Get('verify')
  async verify(
    @Query('chainKey') chainKey?: string,
  ): Promise<SerialisedVerifyResult> {
    const result = await this.audit.verifyChain(chainKey || 'global');
    return serialiseVerify(result);
  }

  /**
   * Stream the chain (filtered or whole) as NDJSON in `seq` order: one
   * `JSON.stringify(row) + '\n'` per row, `Content-Type:
   * application/x-ndjson`. `seq` is converted to a string per row BEFORE
   * stringifying (JSON.stringify throws on BigInt); `hash`/`prevHash` are
   * preserved so the export is independently verifiable.
   */
  @Get('export')
  async export(
    @Res() res: Response,
    @Query('action') action?: string,
    @Query('userId') userId?: string,
    @Query('chainKey') chainKey?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<void> {
    const rows = await this.prisma.auditLog.findMany({
      where: buildWhere({ action, userId, chainKey, from, to }),
      orderBy: { seq: 'asc' },
      select: ROW_SELECT,
    });

    res.setHeader('Content-Type', 'application/x-ndjson');
    for (const row of rows) {
      res.write(JSON.stringify(serialiseRow(row)) + '\n');
    }
    res.end();
  }
}

/** Coerce a row's BigInt `seq` to a string; everything else verbatim. */
function serialiseRow(row: AuditRow): SerialisedRow {
  return { ...row, seq: row.seq.toString() };
}

/** Verify result with every BigInt stringified for JSON transport. */
type SerialisedVerifyResult =
  | { ok: true; chainKey: string; checked: number; head: { seq: string; hash: string } | null }
  | { ok: false; chainKey: string; firstBrokenSeq: string; reason: string };

function serialiseVerify(result: VerifyResult): SerialisedVerifyResult {
  if (result.ok) {
    return {
      ok: true,
      chainKey: result.chainKey,
      checked: result.checked,
      head: result.head
        ? { seq: result.head.seq.toString(), hash: result.head.hash }
        : null,
    };
  }
  return {
    ok: false,
    chainKey: result.chainKey,
    firstBrokenSeq: result.firstBrokenSeq.toString(),
    reason: result.reason,
  };
}

/** Clamp/parse the `limit` query param to 1..MAX_LIMIT (default DEFAULT_LIMIT). */
function parseLimit(limit?: string): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Build the Prisma `where` from the optional list/export filters. */
function buildWhere(filters: {
  action?: string;
  userId?: string;
  chainKey?: string;
  from?: string;
  to?: string;
  cursor?: string;
}): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (filters.action) where.action = filters.action;
  if (filters.userId) where.userId = filters.userId;
  if (filters.chainKey) where.chainKey = filters.chainKey;

  const createdAt: Prisma.DateTimeFilter = {};
  if (filters.from) createdAt.gte = new Date(filters.from);
  if (filters.to) createdAt.lte = new Date(filters.to);
  if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;

  if (filters.cursor) where.seq = { gt: BigInt(filters.cursor) };

  return where;
}
