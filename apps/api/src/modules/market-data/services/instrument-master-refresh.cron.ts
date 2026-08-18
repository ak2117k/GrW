import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InstrumentService } from './instrument.service';
import { AngelOneAdapterService } from './angel-one-adapter.service';
import { UpsertInstrumentInput } from '../repositories/market-data.repository';
import { toDerivativeInput } from './master-contract';

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
 * Scope: cash equities (NSE/BSE, blank `instrumenttype`) AND live derivative
 * contracts (NFO/MCX/BFO/CDS, expiry today or later).
 *
 * Derivatives were excluded until 2026-08-17 on the grounds that they "carry
 * strike/expiry/optionType that this flat upsert shape cannot represent" — no
 * longer true, since both the model and `UpsertInstrumentInput` carry all
 * three. That omission was silently breaking three things: the sentinel could
 * not map an option token to its underlying (12 of 24 packet fields blind on
 * every derivative position), `OptionsChainService.getExpiries` had no expiry
 * source so OI walls never worked, and with no expiry the agent could not
 * reason about theta at all.
 *
 * Adding them is safe for the allowlist: `getInstrumentBySymbol` always filters
 * by exchange, so no NSE/BSE lookup can match an NFO row, and token lookups are
 * unique per row so a new token can only make a previously-unresolvable token
 * resolve. Expired contracts are never written — the master carries every
 * strike of every past expiry, and the row count is boot-cache memory.
 */
/**
 * How recently the master must have been refreshed for boot to skip its own.
 * A day, matching the 08:00 cron's cadence — anything inside that window has
 * nothing new to add.
 */
export const BOOT_REFRESH_SKIP_MS = 24 * 60 * 60 * 1000;

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

    // DELIBERATELY NOT AWAITED. Nest awaits every `onModuleInit` before
    // `app.listen()` runs, so awaiting this put a multi-minute instrument
    // refresh directly in front of the port bind — and Render, which waits for
    // an open port to consider a deploy healthy, timed the deploy out and
    // failed it. The application was fine; it simply never got to listen.
    //
    // Detached, the server binds immediately and the master fills in behind it.
    // The only cost is a window after boot in which newly-listed symbols are
    // not yet resolvable, which is the state the process was in anyway for the
    // whole duration of the blocking refresh.
    void this.refreshOnBoot().catch((err) => {
      this.logger.warn(
        `Boot instrument refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * The boot refresh, SKIPPED when the table is already current.
   *
   * THIS IS AN OOM CIRCUIT BREAKER, not an optimisation. Loading the master
   * costs a large transient — the 34.6 MB response body, its decoded string and
   * the parsed 155k-row array are briefly live together — and on a 512 MB
   * container that is enough to be killed. The failure then REPEATS ITSELF: the
   * container OOMs, Render restarts it, `onModuleInit` runs the refresh again,
   * and it OOMs again. A crash loop whose engine is the recovery path is the
   * worst shape a boot job can have, because every restart makes it more likely
   * rather than less.
   *
   * The refresh exists so newly-listed symbols become resolvable. That is a
   * once-a-day concern and the 08:00 cron already owns it — so if a refresh has
   * landed within the last day, boot has nothing to add and simply declines to
   * spend the memory. A genuinely empty or stale table still refreshes, which is
   * the case the boot hook was added for.
   */
  private async refreshOnBoot(): Promise<void> {
    try {
      const recent = await this.instruments.lastMasterRefreshAt();
      if (recent && Date.now() - recent.getTime() < BOOT_REFRESH_SKIP_MS) {
        this.logger.log(
          `Skipping boot instrument refresh — the master was last refreshed at ` +
            `${recent.toISOString()}, inside the ${BOOT_REFRESH_SKIP_MS / 3600_000}h window. ` +
            'The 08:00 IST cron owns the daily refresh; loading the 155k-row scrip master at ' +
            'every boot is what OOMed a 512MB container into a restart loop.',
        );
        return;
      }
    } catch (err) {
      // A failed freshness check must not SKIP the refresh — an empty table is
      // the state this hook exists for. Fall through and refresh.
      this.logger.warn(
        `Could not read the last master refresh time, refreshing anyway: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
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
      // Counted separately: the derivative total is the one number that tells
      // an operator whether the sentinel and the options chain will have
      // anything to resolve against today.
      const derivatives = rows.filter((r) => r.expiry).length;
      const count = await this.instruments.refreshMaster(rows);
      this.logger.log(
        `Instrument master refreshed (${trigger}): ${count} rows upserted ` +
          `(${rows.length - derivatives} cash, ${derivatives} live derivative contracts) ` +
          `from ${master.length} master records`,
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
    const today = new Date();
    for (const row of master ?? []) {
      const exch = String(row?.exch_seg ?? '');

      // DERIVATIVES, bounded to live expiries. Previously skipped entirely on
      // the grounds that this shape "cannot represent" strike/expiry/optionType
      // — which stopped being true once the model and the upsert input gained
      // all three. The omission left the sentinel unable to map an option token
      // to its underlying (12 of 24 packet fields blind on every derivative
      // position) and left `getExpiries` with no expiry source, so OI walls
      // never worked. See the 2026-08-17 derivative-instrument-master spec.
      if (exch !== 'NSE' && exch !== 'BSE') {
        const derivative = toDerivativeInput(row, today);
        if (derivative) out.push(derivative);
        continue;
      }
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
