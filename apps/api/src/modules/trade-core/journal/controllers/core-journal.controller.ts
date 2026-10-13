import { Body, Controller, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, type AuthenticatedUser } from '../../../../common/decorators';
import { istDate, istDayStart } from '../../execution/ledger-math';
import { isActiveStatus, type CorePosition } from '../../lifecycle/lifecycle.types';
import { CorePositionRepository } from '../../lifecycle/repositories/core-position.repository';
import { dailySummary, type DailySummary } from '../daily-summary';
import { AckReconDto, JournalDayQueryDto } from '../dto/core-journal.dto';
import {
  CORE_INTAKE_STATUS, CORE_JOURNAL_STATUS, CORE_RECON_DESK,
  type IntakeStatusSource, type JournalStatusSource, type ReconDesk,
} from '../journal-ports';
import type { JournalRow, TradeSummary } from '../journal.types';
import { CoreJournalRepository } from '../repositories/core-journal.repository';
import { CoreTradeSummaryRepository } from '../repositories/core-trade-summary.repository';
import { SiloComparisonReader, type ComparisonRow } from '../silo-comparison.reader';

const NOTICE_TYPES = new Set(['KILL_SWITCH', 'LIMIT_CHANGED', 'RECON_MISMATCH']);

/**
 * Spec §8.4 Journal page API. The caller's own rows only (the user comes from the token); the
 * comparison reads platform-wide silo tables and is admin-only. Read-only except the ack (O10).
 */
@ApiTags('Trade core: journal')
@Controller('api/trade-core/journal')
export class CoreJournalController {
  constructor(
    private readonly journal: CoreJournalRepository,
    private readonly summaries: CoreTradeSummaryRepository,
    private readonly positions: CorePositionRepository,
    private readonly comparisonReader: SiloComparisonReader,
    @Inject(CORE_RECON_DESK) private readonly desk: ReconDesk,
    @Inject(CORE_INTAKE_STATUS) private readonly intake: IntakeStatusSource,
    @Inject(CORE_JOURNAL_STATUS) private readonly journalStatus: JournalStatusSource,
  ) {}

  @Get('day')
  async day(
    @CurrentUser('userId') userId: string,
    @Query() q: JournalDayQueryDto,
  ): Promise<{ day: string; summary: DailySummary; trades: TradeSummary[]; setups: number; skips: Record<string, number>; latched: boolean; notices: JournalRow[] }> {
    const day = q.day ?? istDate(new Date());
    const [trades, rows] = await Promise.all([
      this.summaries.listForDay(userId, day),
      this.journal.listForDay(userId, day, ['ALERT_RECEIVED', 'INTENT_SKIPPED', 'DAILY_LOSS_LATCHED', 'KILL_SWITCH', 'LIMIT_CHANGED', 'RECON_MISMATCH']),
    ]);
    const skips: Record<string, number> = {};
    for (const r of rows) {
      if (r.type !== 'INTENT_SKIPPED') continue;
      const reason = String(r.payload.reason ?? 'UNKNOWN');
      skips[reason] = (skips[reason] ?? 0) + 1;
    }
    return {
      day,
      summary: dailySummary(trades),
      trades,
      setups: rows.filter((r) => r.type === 'ALERT_RECEIVED').length,
      skips,
      latched: rows.some((r) => r.type === 'DAILY_LOSS_LATCHED'),
      notices: rows.filter((r) => NOTICE_TYPES.has(r.type)),
    };
  }

  @Get('positions/:id')
  async position(@CurrentUser('userId') userId: string, @Param('id') id: string): Promise<{ position: CorePosition; events: JournalRow[]; summary: TradeSummary | null }> {
    const position = await this.positions.findForUser(userId, id);
    if (!position) throw new NotFoundException(`core position ${id} not found`);
    const [own, sameDay, summary] = await Promise.all([
      this.journal.listForPosition(userId, id),
      this.journal.listForDay(userId, istDate(position.createdAt), ['ALERT_RECEIVED', 'RISK_VERDICT']),
      this.summaries.findByPosition(userId, id),
    ]);
    const intentRows = sameDay.filter((r) => r.intentId === position.intentId && r.positionId === null);
    const events = [...intentRows, ...own].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { position, events, summary };
  }

  /**
   * The intake queue and journal buffer are platform-wide: only an admin sees their counters (review
   * fix 8). Anyone else gets the same shape with the entries switch and zeros, plus their own rows.
   */
  @Get('status')
  async status(@CurrentUser() user: AuthenticatedUser) {
    const { userId } = user;
    const [rows, mismatches] = await Promise.all([this.positions.listForUser(userId, istDayStart(new Date())), this.desk.unacked(userId)]);
    const active = rows.filter((p) => isActiveStatus(p.status));
    const admin = user.role === 'ADMIN';
    const entries = this.intake.status();
    return {
      entries: admin ? entries : { mode: entries.mode, users: 0, pending: 0, dropped: 0 },
      journal: admin ? this.journalStatus.status() : { pending: 0, written: 0, dropped: 0, failures: 0, lastError: null },
      positions: { active: active.length, blind: active.filter((p) => p.blindSince !== null).length, exiting: active.filter((p) => p.status === 'EXITING').length },
      mismatches,
    };
  }

  @Post('recon/:id/ack')
  @HttpCode(HttpStatus.OK)
  ack(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() dto: AckReconDto): Promise<{ acknowledged: string }> {
    return this.desk.ack(userId, id, dto.reason.trim());
  }

  @Get('comparison')
  @AdminOnly()
  comparison(@CurrentUser('userId') userId: string, @Query() q: JournalDayQueryDto): Promise<ComparisonRow[]> {
    return this.comparisonReader.forDay(userId, q.day ?? istDate(new Date()));
  }
}
