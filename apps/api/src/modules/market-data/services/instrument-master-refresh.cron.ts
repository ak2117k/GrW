import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InstrumentService } from './instrument.service';
import { AngelOneAdapterService } from './angel-one-adapter.service';
import { UpsertInstrumentInput } from '../repositories/market-data.repository';

/**
 * Reconciles the local `instruments` allowlist with Angel One's listed universe.
 *
 * The instruments table is a de-facto allowlist: symbol→token resolution (and
 * Chartink-style alert ingestion) rejects any symbol that has no local row with
 * "symbol not in local DB". Historically `InstrumentService.refreshMaster()` was
 * never invoked at runtime, so newly-listed cash symbols (e.g. NEOGEN) stayed
 * UNTRACKABLE even though Angel's master carries them. This cron wires the
 * refresh to run once at boot and daily pre-open.
 *
 * Scope: only cash-equity rows (NSE/BSE, blank `instrumenttype`) are persisted.
 * F&O and commodity contracts carry strike/expiry/optionType that this flat
 * upsert shape cannot represent; they are resolved on demand straight from the
 * in-memory master (searchInMaster / getOptionContracts), so persisting them
 * here would only pollute the table with null strike/expiry rows.
 */
@Injectable()
export class InstrumentMasterRefreshCron implements OnModuleInit {
  private readonly logger = new Logger(InstrumentMasterRefreshCron.name);

  constructor(
    private readonly instruments: InstrumentService,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  async onModuleInit(): Promise<void> {
    // This refresh upserts the WHOLE master one row at a time, and it is
    // AWAITED — so boot blocks on tens of thousands of round trips. Against a
    // local database that is slow; against a remote one (Neon) it is minutes,
    // and it exhausts the connection pool while it runs, which is what then
    // failed the NEXT worker's first query. A process that only needs to READ a
    // few instruments should never pay for it.
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    await this.refresh('boot');
  }

  // 08:00 IST Mon-Fri — before the 09:15 cash open, so freshly-listed symbols
  // are trackable for the session.
  @Cron('0 0 8 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async refreshDaily(): Promise<void> {
    await this.refresh('daily');
  }

  private async refresh(trigger: string): Promise<void> {
    try {
      const master = await this.adapter.getInstrumentMaster();
      const rows = this.toUpsertInputs(master);
      const count = await this.instruments.refreshMaster(rows);
      this.logger.log(
        `Instrument master refreshed (${trigger}): ${count} cash-equity rows upserted from ${master.length} master records`,
      );
    } catch (err) {
      this.logger.warn(
        `Instrument master refresh (${trigger}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Map raw Angel One scrip-master rows to the instrument upsert shape, keeping
   * only cash equities. Field conventions match the existing master→upsert
   * mapping in MarketDataController (exch_seg, lotsize, tick_size).
   */
  private toUpsertInputs(master: any[]): UpsertInstrumentInput[] {
    const out: UpsertInstrumentInput[] = [];
    for (const row of master ?? []) {
      const exch = String(row?.exch_seg ?? '');
      if (exch !== 'NSE' && exch !== 'BSE') continue;
      // Cash equities carry a blank instrumenttype; anything else is a
      // derivative/index contract we deliberately skip.
      if (String(row?.instrumenttype ?? '').trim()) continue;
      const symbol = String(row?.symbol ?? '').trim();
      const token = String(row?.token ?? '').trim();
      if (!symbol || !token) continue;
      out.push({
        symbol,
        token,
        name: String(row?.name ?? symbol),
        exchange: exch,
        segment: exch,
        lotSize: parseInt(String(row?.lotsize ?? '1'), 10) || 1,
        tickSize: parseFloat(String(row?.tick_size ?? '0.05')) || 0.05,
      });
    }
    return out;
  }
}
