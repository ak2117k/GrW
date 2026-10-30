import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { makeSentinelClock } from '../trade-sentinel/overnight/overnight-calendar';
import { SanityAuditController } from './controllers/sanity-audit.controller';
import { SanityAuditRepository } from './repositories/sanity-audit.repository';
import { AiExitAuditReader } from './repositories/ai-exit-audit.reader';
import { SanityAuditCron } from './services/sanity-audit.cron';
import { SANITY_AUDIT_CLOCK, SanityAuditService } from './services/sanity-audit.service';

/**
 * Sanity audit (owner 2026-10-30): invariants checked on every trade / exit / feed every 5 min, each
 * violation stored once in sanity_violations and alerted once on the Telegram ops bot. DETECTION ONLY —
 * read-only on everything but its own table, imported by no trading path, it can neither modify a trade
 * nor block one. Invariants live in services/sanity-checks.ts (SANITY_CHECKS).
 */
@Module({
  imports: [PrismaModule],
  controllers: [SanityAuditController],
  providers: [
    SanityAuditRepository,
    AiExitAuditReader,
    SanityAuditService,
    SanityAuditCron,
    { provide: SANITY_AUDIT_CLOCK, useFactory: () => makeSentinelClock(process.env.HUB_MCX_LATE_CLOSE) },
  ],
})
export class SanityAuditModule {}
