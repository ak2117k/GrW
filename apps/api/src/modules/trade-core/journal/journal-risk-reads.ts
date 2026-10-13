import { Injectable } from '@nestjs/common';
import { reconBlockOf, type ReconBlock } from './recon-checks';
import { CoreJournalRepository } from './repositories/core-journal.repository';

/** What the Risk Wall's live state reads from the journal (J13 latch, J12/O10 recon block). Entries only. */
export const JOURNAL_RISK_READS = Symbol('JOURNAL_RISK_READS');

export interface JournalRiskReadsPort {
  /** The daily loss limit was reached earlier this IST day (spec §5.3). */
  latched(userId: string, day: string): Promise<boolean>;
  /** O10: what unacknowledged reconciliation findings block. */
  reconBlock(userId: string): Promise<ReconBlock>;
}

@Injectable()
export class JournalRiskReads implements JournalRiskReadsPort {
  constructor(private readonly repo: CoreJournalRepository) {}

  latched(userId: string, day: string): Promise<boolean> {
    return this.repo.hasType(userId, day, 'DAILY_LOSS_LATCHED');
  }

  async reconBlock(userId: string): Promise<ReconBlock> {
    return reconBlockOf(await this.repo.unackedMismatches(userId));
  }
}
