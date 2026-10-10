import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SessionClock } from '../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { readMarketCuesConfig, type MarketCuesConfig } from './market-cues.config';
import {
  FII_DII_PUBLISH_MIN,
  FII_OI_PUBLISH_MIN,
  GIFT_MAX_AGE_MS,
  US_FUTURES_MAX_AGE_MS,
  US_INTRADAY_MAX_AGE_MS,
  usPhaseAt,
  preOpenFreshness,
  publishedFreshness,
  quoteAge,
  usCloseFreshness,
  type Freshness,
} from './market-cues.freshness';
import {
  US_CUE_KEYS,
  type CueGroup,
  type CueRecord,
  type FiiDerivatives,
  type FiiDiiCash,
  type FiiIndexPositions,
  type GiftGap,
  type MarketCuesSnapshot,
  type NiftyFutureClose,
  type PreOpenBook,
  type UsCueKey,
  type UsQuote,
} from './market-cues.types';
import { cueGet, cueGetJson, describeFetchError, type CueHttpOptions, type FetchLike } from './fetchers/cue-http';
import { US_SYMBOLS, cnbcQuoteUrl, parseCnbcQuotes, parseYahooCue, yahooChartUrl } from './fetchers/us-cues.fetcher';
import { parseNsdlLatest, parseNseFiiDii } from './fetchers/fii-dii.fetcher';
import { parseParticipantOi, participantOiChange, participantOiUrl } from './fetchers/fii-oi.fetcher';
import { computeGiftGap, parseMarketStatusGift, parseNseIxGift, parseNseNiftyFutures } from './fetchers/gift-nifty.fetcher';
import { parseNsePreOpen } from './fetchers/pre-open.fetcher';
import { istAt, istMinutes, istYmd } from './fetchers/ist-dates';

/**
 * The schedule, six-field (seconds first), weekdays, evaluated in IST. Every
 * fire is ALSO gated on the NSE holiday calendar (`shouldFire`).
 *
 *   US + GIFT   23:40 (before the 23:45 MCX after-close review) and 08:25
 *               (before the 08:30 pre-open review);
 *   FII/DII     19:00, retry 20:30 — NSE publishes ~18:00–20:00;
 *   FII OI      20:00, retry 21:00 — the participant-OI archive file;
 *   pre-open    09:10 — after NSE's 09:08 pre-open match, before the 09:15 open.
 */
export const MARKET_CUES_CRONS = {
  usGiftNight: '0 40 23 * * 1-5',
  usGiftMorning: '0 25 8 * * 1-5',
  fii: '0 0 19 * * 1-5',
  fiiRetry: '0 30 20 * * 1-5',
  fiiOi: '0 0 20 * * 1-5',
  fiiOiRetry: '0 0 21 * * 1-5',
  preOpen: '0 10 9 * * 1-5',
} as const;

export type CronSlot = keyof typeof MARKET_CUES_CRONS;

const SLOT_GROUPS: Record<CronSlot, CueGroup[]> = {
  usGiftNight: ['us', 'gift'],
  usGiftMorning: ['us', 'gift'],
  fii: ['fiiDii'],
  fiiRetry: ['fiiDii'],
  fiiOi: ['fiiOi'],
  fiiOiRetry: ['fiiOi'],
  preOpen: ['preOpen'],
};

/** A source whose last read was not ok may be re-read by `ensure` this long after the last attempt. */
const REFETCH_AFTER_MS = 30 * 60_000;

const GROUP_SWITCH: Record<CueGroup, { key: keyof MarketCuesConfig['sources']; env: string }> = {
  us: { key: 'us', env: 'MARKET_CUES_US' },
  fiiDii: { key: 'fii', env: 'MARKET_CUES_FII' },
  fiiOi: { key: 'fiiOi', env: 'MARKET_CUES_FII_OI' },
  gift: { key: 'gift', env: 'MARKET_CUES_GIFT' },
  preOpen: { key: 'preOpen', env: 'MARKET_CUES_PREOPEN' },
};

/** What is cached per cue: the reading (or none), plus the last failure. Status is derived on read. */
interface Stored<T> {
  values: T | null;
  sourceTime: string | null;
  fetchedAt: string | null;
  basis: string;
  source: string;
  /** A note that holds even when the values are fine (e.g. "previous file missing"). */
  note?: string;
  /** The last refresh's failure, if the last refresh failed. */
  lastError?: string;
}

/**
 * MARKET CUES — US closes and futures, FII/DII cash flows, FII index F&O
 * positioning, GIFT Nifty and the NSE pre-open book, fetched on a schedule from
 * free public endpoints and cached in memory.
 *
 * LICENSING: these are free, unofficial sources. They are acceptable for the
 * OWNER'S OWN shadow sentinel only. Showing them to SaaS tenants would need a
 * licensed market-data vendor — do not surface this module's output in any
 * tenant-facing view or API without replacing the sources.
 *
 * IN MEMORY, deliberately: the values are a few hundred bytes, every one is
 * re-read at least daily, and the consumers (the sentinel's reviews) call
 * `ensure`, which fetches any group this process has not yet read — so a
 * restart costs one request per source, not a missing cue. No migration.
 *
 * REQUEST DISCIPLINE: one request per source per fire, ONE retry, then an
 * exponential backoff per endpoint (`MARKET_CUES_BACKOFF_MS`, capped at
 * `MARKET_CUES_BACKOFF_MAX_MS`) during which that endpoint is not asked again.
 * Concurrent callers of one group share one in-flight refresh.
 *
 * NEVER A ZERO FOR MISSING DATA: a failed read stores `values: null` with the
 * reason; a later failure keeps the earlier reading, whose status then follows
 * its own source time.
 */
@Injectable()
export class MarketCuesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MarketCuesService.name);
  private readonly cfg: MarketCuesConfig;
  private readonly clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

  /** Overridable in tests; production uses the global fetch. */
  fetchImpl?: FetchLike;

  private readonly store = new Map<string, Stored<unknown>>();
  private readonly attempted = new Map<CueGroup, number>();
  private readonly inflight = new Map<CueGroup, Promise<void>>();
  private readonly backoff = new Map<string, { failures: number; until: number }>();
  /** Parsed participant-OI files by session date, for the change vs the previous file. */
  private readonly oiFiles = new Map<string, FiiIndexPositions>();

  constructor(config: ConfigService) {
    this.cfg = readMarketCuesConfig((k) => config.get<string>(k));
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** The boot warm-up's completion, once started (tests await it). Never rejects. */
  warmUpDone?: Promise<void>;

  /**
   * WARM THE CACHE ON BOOT. The cache is in memory, so after a deploy every cue
   * would read "not fetched yet" until its next cron — up to ~14 h away. With
   * MARKET_CUES_ENABLED on, fetch every enabled source once, in the background,
   * after init: the boot path itself sends nothing and waits for nothing. Same
   * one-request-plus-one-retry rule and backoff as any fire; a failure is logged
   * and left as an unavailable cue, never thrown.
   */
  onApplicationBootstrap(): void {
    if (!this.cfg.enabled) return;
    this.warmUpDone = new Promise<void>((resolve) => {
      setImmediate(() => {
        this.warmUp()
          .catch((err) => this.logger.error(`market cues warm-up aborted: ${describeFetchError(err)}`))
          .finally(resolve);
      });
    });
  }

  private async warmUp(): Promise<void> {
    const now = new Date();
    const groups = (Object.keys(GROUP_SWITCH) as CueGroup[]).filter((g) => this.cfg.sources[GROUP_SWITCH[g].key]);
    await Promise.all(groups.map((g) => this.refresh(g, now)));
    const snap = this.snapshot(now);
    const held = [...US_CUE_KEYS.map((k) => snap.us[k]), snap.fiiDii, snap.fiiOi, snap.gift, snap.preOpen].filter((r) => r.values).length;
    this.logger.log(`market cues warm-up: ${groups.join(', ')} fetched; ${held} of 9 cues hold a reading`);
  }

  // ─── Schedule ───────────────────────────────────────────────────────────────

  @Cron(MARKET_CUES_CRONS.usGiftNight, { timeZone: 'Asia/Kolkata' })
  async usGiftNight(): Promise<void> {
    await this.fire('usGiftNight');
  }

  @Cron(MARKET_CUES_CRONS.usGiftMorning, { timeZone: 'Asia/Kolkata' })
  async usGiftMorning(): Promise<void> {
    await this.fire('usGiftMorning');
  }

  @Cron(MARKET_CUES_CRONS.fii, { timeZone: 'Asia/Kolkata' })
  async fii(): Promise<void> {
    await this.fire('fii');
  }

  @Cron(MARKET_CUES_CRONS.fiiRetry, { timeZone: 'Asia/Kolkata' })
  async fiiRetry(): Promise<void> {
    await this.fire('fiiRetry');
  }

  @Cron(MARKET_CUES_CRONS.fiiOi, { timeZone: 'Asia/Kolkata' })
  async fiiOi(): Promise<void> {
    await this.fire('fiiOi');
  }

  @Cron(MARKET_CUES_CRONS.fiiOiRetry, { timeZone: 'Asia/Kolkata' })
  async fiiOiRetry(): Promise<void> {
    await this.fire('fiiOiRetry');
  }

  @Cron(MARKET_CUES_CRONS.preOpen, { timeZone: 'Asia/Kolkata' })
  async preOpen(): Promise<void> {
    await this.fire('preOpen');
  }

  /**
   * Whether a scheduled slot should fetch at `now`: the master switch, the
   * source's own switch, an NSE trading day (US + GIFT also run on an MCX-only
   * trading day — the MCX after-close review reads them), and for a retry slot,
   * only when the first fire did not land today's figure.
   */
  shouldFire(slot: CronSlot, now: Date): boolean {
    if (!this.cfg.enabled) return false;
    const groups = SLOT_GROUPS[slot].filter((g) => this.cfg.sources[GROUP_SWITCH[g].key]);
    if (groups.length === 0) return false;
    const noon = istAt(istYmd(now), 12);
    const tradingDay =
      slot === 'usGiftNight' || slot === 'usGiftMorning'
        ? this.clock.isTradingDay('NSE', noon) || this.clock.isTradingDay('MCX', noon)
        : this.clock.isTradingDay('NSE', noon);
    if (!tradingDay) return false;
    if (slot === 'fiiRetry' || slot === 'fiiOiRetry') {
      const key = slot === 'fiiRetry' ? 'fiiDii' : 'fiiOi';
      const date = (this.store.get(key)?.values as { date?: string } | null | undefined)?.date;
      return date !== istYmd(now);
    }
    return true;
  }

  private async fire(slot: CronSlot): Promise<void> {
    const now = new Date();
    if (!this.shouldFire(slot, now)) return;
    try {
      for (const g of SLOT_GROUPS[slot]) {
        if (this.cfg.sources[GROUP_SWITCH[g].key]) await this.refresh(g, now);
      }
    } catch (err) {
      this.logger.error(`market cues ${slot} aborted: ${describeFetchError(err)}`);
    }
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Fetch any of `groups` this process has not read yet — or whose last read
   * is not ok and is older than {@link REFETCH_AFTER_MS} (a stale pre-open book
   * at 09:10, a stale futures quote at 15:45) — then return the snapshot.
   * Backoff and the in-flight share still apply.
   */
  async ensure(groups: CueGroup[], now: Date = new Date()): Promise<MarketCuesSnapshot> {
    if (this.cfg.enabled) {
      const before = this.snapshot(now);
      await Promise.all(
        groups
          .filter((g) => this.cfg.sources[GROUP_SWITCH[g].key])
          .filter((g) => this.inflight.has(g) || this.needs(g, before, now))
          .map((g) => this.refresh(g, now)),
      );
    }
    return this.snapshot(now);
  }

  private needs(group: CueGroup, snap: MarketCuesSnapshot, now: Date): boolean {
    const last = this.attempted.get(group);
    if (last === undefined) return true;
    if (now.getTime() - last < REFETCH_AFTER_MS) return false;
    const records: Array<CueRecord<unknown>> =
      group === 'us' ? US_CUE_KEYS.map((k) => snap.us[k]) : [snap[group] as CueRecord<unknown>];
    return records.some((r) => r.status !== 'ok');
  }

  /** The cached cues with their status at `now`. Synchronous, no I/O. */
  snapshot(now: Date = new Date()): MarketCuesSnapshot {
    const us = {} as Record<UsCueKey, CueRecord<UsQuote>>;
    for (const key of US_CUE_KEYS) {
      us[key] = this.record<UsQuote>(`us:${key}`, 'us', now, (s) =>
        US_SYMBOLS[key].future
          ? quoteAge(s.sourceTime as string, now, US_FUTURES_MAX_AGE_MS, `${US_SYMBOLS[key].label} quote`)
          : (s.values as UsQuote).phase === 'intraday'
            ? quoteAge(s.sourceTime as string, now, US_INTRADAY_MAX_AGE_MS, `${US_SYMBOLS[key].label} intraday value`)
            : usCloseFreshness(s.sourceTime as string, now),
      );
    }
    return {
      enabled: this.cfg.enabled,
      us,
      fiiDii: this.record<FiiDiiCash>('fiiDii', 'fiiDii', now, (s) =>
        publishedFreshness(
          (s.values as FiiDiiCash).date,
          now,
          this.clock,
          FII_DII_PUBLISH_MIN,
          'NSE publishes ~18:00–20:00 IST',
        ),
      ),
      fiiOi: this.record<FiiDerivatives>('fiiOi', 'fiiOi', now, (s) =>
        publishedFreshness(
          (s.values as FiiDerivatives).date,
          now,
          this.clock,
          FII_OI_PUBLISH_MIN,
          'NSE archives the participant-OI file in the evening',
        ),
      ),
      gift: this.record<GiftGap>('gift', 'gift', now, (s) => quoteAge(s.sourceTime as string, now, GIFT_MAX_AGE_MS, 'GIFT Nifty quote')),
      preOpen: this.record<PreOpenBook>('preOpen', 'preOpen', now, (s) => preOpenFreshness((s.values as PreOpenBook).date, now)),
    };
  }

  /** Alias for consumers that only read the cache (the live sentinel packet). */
  peek(now: Date = new Date()): MarketCuesSnapshot {
    return this.snapshot(now);
  }

  private record<T>(key: string, group: CueGroup, now: Date, fresh: (s: Stored<unknown>) => Freshness): CueRecord<T> {
    const s = this.store.get(key) as Stored<T> | undefined;
    const sw = GROUP_SWITCH[group];
    const base = { sourceTime: null, fetchedAt: null, basis: s?.basis ?? '', source: s?.source ?? '' };
    if (!this.cfg.enabled) {
      return { ...base, values: null, status: 'unavailable', reason: 'market cues are switched off (MARKET_CUES_ENABLED is not true)' };
    }
    if (!this.cfg.sources[sw.key]) {
      return { ...base, values: null, status: 'unavailable', reason: `this source is switched off (${sw.env}=false)` };
    }
    if (!s) return { ...base, values: null, status: 'unavailable', reason: 'not fetched yet in this process' };
    if (s.values === null) {
      return {
        values: null,
        sourceTime: null,
        fetchedAt: s.fetchedAt,
        basis: s.basis,
        source: s.source,
        status: 'unavailable',
        reason: s.lastError ?? s.note ?? 'no reading',
      };
    }
    const f = fresh(s as Stored<unknown>);
    const reasons = [f.reason, s.note, s.lastError ? `the latest refresh failed: ${s.lastError}; showing the earlier reading` : undefined]
      .filter(Boolean)
      .join('; ');
    return {
      values: s.values,
      sourceTime: s.sourceTime,
      fetchedAt: s.fetchedAt,
      basis: s.basis,
      source: s.source,
      status: f.status,
      ...(reasons ? { reason: reasons } : {}),
    };
  }

  // ─── Refresh ────────────────────────────────────────────────────────────────

  /** Fetch one group now; concurrent callers share the one in-flight refresh. */
  refresh(group: CueGroup, now: Date = new Date()): Promise<void> {
    const running = this.inflight.get(group);
    if (running) return running;
    this.attempted.set(group, now.getTime());
    const job = this.run(group, now)
      .catch((err) => this.logger.error(`market cues ${group} refresh aborted: ${describeFetchError(err)}`))
      .finally(() => this.inflight.delete(group));
    this.inflight.set(group, job);
    return job;
  }

  private run(group: CueGroup, now: Date): Promise<void> {
    switch (group) {
      case 'us':
        return this.refreshUs(now);
      case 'fiiDii':
        return this.refreshFiiDii(now);
      case 'fiiOi':
        return this.refreshFiiOi(now);
      case 'gift':
        return this.refreshGift(now);
      case 'preOpen':
        return this.refreshPreOpen(now);
    }
  }

  private http(): CueHttpOptions {
    return {
      timeoutMs: this.cfg.timeoutMs,
      userAgent: this.cfg.userAgent,
      accept: this.cfg.accept,
      retryDelayMs: this.cfg.retryDelayMs,
      fetchImpl: this.fetchImpl,
    };
  }

  /**
   * One endpoint, under its backoff: skipped (throws) while backing off; on
   * failure (after the one retry inside `cueGet`) the backoff doubles. The
   * failure is logged with its HTTP status or network cause — never headers.
   */
  private async guarded<T>(endpoint: string, now: Date, fn: () => Promise<T>): Promise<T> {
    const b = this.backoff.get(endpoint);
    if (b && now.getTime() < b.until) {
      throw new Error(`${endpoint} in backoff after ${b.failures} failed fire(s) until ${new Date(b.until).toISOString()}`);
    }
    try {
      const out = await fn();
      this.backoff.delete(endpoint);
      return out;
    } catch (err) {
      const failures = (b?.failures ?? 0) + 1;
      const wait = Math.min(this.cfg.backoffBaseMs * 2 ** (failures - 1), this.cfg.backoffMaxMs);
      this.backoff.set(endpoint, { failures, until: now.getTime() + wait });
      const why = describeFetchError(err);
      this.logger.warn(`market cue source ${endpoint} failed: ${why}`);
      throw new Error(`${endpoint}: ${why}`);
    }
  }

  private put<T>(key: string, s: Stored<T>): void {
    this.store.set(key, s as Stored<unknown>);
  }

  /** A failed refresh: keep the earlier reading (if any) and record why. */
  private fail(key: string, now: Date, source: string, basis: string, error: string): void {
    const prev = this.store.get(key);
    if (prev && prev.values !== null) {
      this.store.set(key, { ...prev, lastError: error });
    } else {
      this.store.set(key, { values: null, sourceTime: null, fetchedAt: now.toISOString(), basis, source, lastError: error });
    }
  }

  private async refreshUs(now: Date): Promise<void> {
    const failed: Array<{ key: UsCueKey; error: string }> = [];
    for (const key of US_CUE_KEYS) {
      const sym = US_SYMBOLS[key];
      try {
        const parsed = await this.guarded(`Yahoo chart ${sym.yahoo}`, now, async () =>
          parseYahooCue(await cueGetJson(yahooChartUrl(this.cfg.urls.yahooChart, sym.yahoo), this.http()), sym.yahoo),
        );
        const phase = sym.future ? undefined : usPhaseAt(parsed.sourceTime);
        this.put<UsQuote>(`us:${key}`, {
          values: { ...parsed.values, ...(phase ? { phase } : {}) },
          sourceTime: parsed.sourceTime,
          fetchedAt: now.toISOString(),
          basis: usBasis(key, `Yahoo regularMarketTime ${parsed.sourceTime}`, phase),
          source: `Yahoo Finance v8 chart ${sym.yahoo} (one-day change: last two daily closes)`,
        });
      } catch (err) {
        failed.push({ key, error: describeFetchError(err) });
      }
    }
    if (failed.length === 0) return;

    // ONE fallback request for every symbol Yahoo could not serve.
    let cnbc: ReturnType<typeof parseCnbcQuotes> | null = null;
    let cnbcError = '';
    try {
      const symbols = failed.map((f) => US_SYMBOLS[f.key].cnbc);
      cnbc = await this.guarded('CNBC quote', now, async () =>
        parseCnbcQuotes(await cueGetJson(cnbcQuoteUrl(this.cfg.urls.cnbcQuote, symbols), this.http())),
      );
    } catch (err) {
      cnbcError = describeFetchError(err);
    }
    for (const f of failed) {
      const sym = US_SYMBOLS[f.key];
      const hit = cnbc?.[sym.cnbc];
      if (hit) {
        const phase = sym.future ? undefined : usPhaseAt(hit.sourceTime);
        this.put<UsQuote>(`us:${f.key}`, {
          values: { ...hit.values, symbol: sym.yahoo, ...(phase ? { phase } : {}) },
          sourceTime: hit.sourceTime,
          fetchedAt: now.toISOString(),
          basis: usBasis(f.key, `CNBC last_time ${hit.sourceTime}`, phase),
          source: `CNBC quote JSON ${sym.cnbc} (fallback — Yahoo failed: ${f.error})`,
        });
      } else {
        this.fail(
          `us:${f.key}`,
          now,
          `Yahoo ${sym.yahoo} / CNBC ${sym.cnbc}`,
          usBasis(f.key, ''),
          `Yahoo failed (${f.error}); CNBC fallback ${cnbc ? `had no ${sym.cnbc} quote` : `failed (${cnbcError})`}`,
        );
      }
    }
  }

  private async refreshFiiDii(now: Date): Promise<void> {
    try {
      const parsed = await this.guarded('NSE fiidiiTradeReact', now, async () =>
        parseNseFiiDii(await cueGetJson(this.cfg.urls.nseFiiDii, this.http())),
      );
      this.put<FiiDiiCash>('fiiDii', {
        values: parsed.values,
        sourceTime: parsed.sourceTime,
        fetchedAt: now.toISOString(),
        basis: 'session date the provisional figures describe (NSE publishes ~18:00–20:00 IST)',
        source: 'NSE fiidiiTradeReact (provisional FII/FPI and DII cash-market flows, ₹ crore)',
      });
      return;
    } catch (primary) {
      try {
        const parsed = await this.guarded('NSDL FPI daily', now, async () => parseNsdlLatest(await cueGet(this.cfg.urls.nsdlFpi, this.http())));
        const session = this.previousNseSession(parsed.reportDate);
        if (!session) throw new Error(`no NSE session before the NSDL report date ${parsed.reportDate}`);
        this.put<FiiDiiCash>('fiiDii', {
          values: { date: session, fii: parsed.fii, dii: null, unit: '₹ crore' },
          sourceTime: session,
          fetchedAt: now.toISOString(),
          basis: `the previous trading day (${session}): NSDL reported it on ${parsed.reportDate}, one day behind`,
          source: `NSDL FPI daily trends, equity via stock exchange (fallback — NSE failed: ${describeFetchError(primary)}); FPI only, no DII`,
        });
      } catch (fallback) {
        this.fail(
          'fiiDii',
          now,
          'NSE fiidiiTradeReact / NSDL FPI daily',
          'session date',
          `NSE failed (${describeFetchError(primary)}); NSDL fallback failed (${describeFetchError(fallback)})`,
        );
      }
    }
  }

  private async refreshFiiOi(now: Date): Promise<void> {
    // From 19:00 on a trading day the file wanted is today's; before, the last session's.
    const target = this.latestNseSession(now, 19 * 60);
    if (!target) return;
    const file = async (date: string): Promise<FiiIndexPositions> => {
      const cached = this.oiFiles.get(date);
      if (cached) return cached;
      const parsed = await this.guarded(`NSE participant OI ${date}`, now, async () =>
        parseParticipantOi(await cueGet(participantOiUrl(this.cfg.urls.nseParticipantOi, date), this.http())),
      );
      if (parsed.date !== date) throw new Error(`participant OI file for ${date} says it is as on ${parsed.date}`);
      this.oiFiles.set(date, parsed);
      for (const k of [...this.oiFiles.keys()].sort().slice(0, -4)) this.oiFiles.delete(k);
      return parsed;
    };
    let current: FiiIndexPositions;
    try {
      current = await file(target);
    } catch (err) {
      this.fail('fiiOi', now, 'NSE participant-wise OI archive', 'session date', describeFetchError(err));
      return;
    }
    const prevDate = this.previousNseSession(current.date);
    let change: FiiDerivatives['change'] = null;
    let note: string | undefined;
    try {
      if (!prevDate) throw new Error('no previous NSE session in the calendar');
      change = participantOiChange(current, await file(prevDate));
    } catch (err) {
      note = `change vs the previous session unavailable: the previous file (${prevDate ?? 'unknown'}) could not be read (${describeFetchError(err)})`;
    }
    this.put<FiiDerivatives>('fiiOi', {
      values: { ...current, unit: 'contracts', change },
      sourceTime: current.date,
      fetchedAt: now.toISOString(),
      basis: 'session date of the participant-wise open interest file (end of day)',
      source: `NSE participant-wise OI archive (fao_participant_oi_${current.date}); FII row, number of contracts`,
      ...(note ? { note } : {}),
    });
  }

  private async refreshGift(now: Date): Promise<void> {
    let gift;
    let source: string;
    try {
      gift = await this.guarded('NSE IX market-rate', now, async () => parseNseIxGift(await cueGetJson(this.cfg.urls.nseIx, this.http())));
      source = 'NSE IX market-rate (GIFT Nifty, nearest-expiry NIFTY FUTIDX)';
    } catch (primary) {
      try {
        gift = await this.guarded('NSE marketStatus', now, async () =>
          parseMarketStatusGift(await cueGetJson(this.cfg.urls.nseMarketStatus, this.http())),
        );
        source = `NSE marketStatus giftnifty block (fallback — NSE IX failed: ${describeFetchError(primary)})`;
      } catch (fallback) {
        this.fail(
          'gift',
          now,
          'NSE IX market-rate / NSE marketStatus',
          'GIFT Nifty quote time',
          `NSE IX failed (${describeFetchError(primary)}); marketStatus fallback failed (${describeFetchError(fallback)})`,
        );
        return;
      }
    }
    let fut: NiftyFutureClose | null = null;
    let note: string | undefined;
    try {
      fut = await this.guarded('NSE NIFTY futures', now, async () =>
        parseNseNiftyFutures(await cueGetJson(this.cfg.urls.nseNiftyFutures, this.http())),
      );
      const expected = this.latestNseSession(now, 15 * 60 + 30);
      if (expected && fut.sessionDate < expected) {
        note = `the NIFTY future close is from ${fut.sessionDate}, not the last session (${expected}) — the gap is against an old close`;
      }
    } catch (err) {
      note = `no gap: the NSE NIFTY current-month future close could not be read (${describeFetchError(err)})`;
    }
    this.put<GiftGap>('gift', {
      values: computeGiftGap(gift, fut),
      sourceTime: gift.at,
      fetchedAt: now.toISOString(),
      basis: 'GIFT Nifty quote time (IST venue timestamp); gap is futures-vs-futures against the NSE NIFTY current-month future close',
      source: `${source} + NSE liveEquity-derivatives nse50_fut (NIFTY current-month future close)`,
      ...(note ? { note } : {}),
    });
  }

  private async refreshPreOpen(now: Date): Promise<void> {
    try {
      const book = await this.guarded('NSE pre-open', now, async () => parseNsePreOpen(await cueGetJson(this.cfg.urls.nsePreOpen, this.http())));
      this.put<PreOpenBook>('preOpen', {
        values: book,
        sourceTime: book.date,
        fetchedAt: now.toISOString(),
        basis: 'pre-open session date; each entry carries its own IEP time',
        source: 'NSE market-data-pre-open (IEP per symbol; each entry says whether it prices the cash equity or a future)',
      });
    } catch (err) {
      this.fail('preOpen', now, 'NSE market-data-pre-open', 'pre-open session date', describeFetchError(err));
    }
  }

  // ─── Calendar ───────────────────────────────────────────────────────────────

  /** The latest NSE trading date whose `fromMin` (IST minutes) has passed. */
  private latestNseSession(now: Date, fromMin: number): string | null {
    const today = istYmd(now);
    for (let d = 0; d <= 14; d++) {
      const ymd = istYmd(new Date(istAt(today, 12).getTime() - d * 86_400_000));
      if (!this.clock.isTradingDay('NSE', istAt(ymd, 12))) continue;
      if (d === 0 && istMinutes(now) < fromMin) continue;
      return ymd;
    }
    return null;
  }

  /** The NSE trading date strictly before `ymd`. */
  private previousNseSession(ymd: string): string | null {
    for (let d = 1; d <= 14; d++) {
      const day = istYmd(new Date(istAt(ymd, 12).getTime() - d * 86_400_000));
      if (this.clock.isTradingDay('NSE', istAt(day, 12))) return day;
    }
    return null;
  }
}

function usBasis(key: UsCueKey, timeFrom: string, phase?: 'intraday' | 'close'): string {
  const t = timeFrom ? ` (${timeFrom})` : '';
  if (US_SYMBOLS[key].future) return `quote time${t} — the US index future overnight; change vs its previous daily close`;
  const holidays = 'US holidays and early closes are not modelled';
  return phase === 'intraday'
    ? `intraday — US regular session in progress, value as of its quote time${t}; change vs the previous US close. ${holidays}`
    : `previous US session close${t}; change vs the session before. ${holidays}`;
}
