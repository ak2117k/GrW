import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BreadthSectorService } from '../../market-data/services/breadth-sector.service';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import type { DailyBar } from '../../signal-intake/domain/info-outcome';
import type { Vocabulary } from '../../signal-intake/domain/vocabulary';
import { SignalVocabularyService } from '../../signal-intake/services/signal-vocabulary.service';
import { infoRefOf, SIGNAL_INFO_BARS, SIGNAL_INFO_MASTER, type InfoBars } from '../../signal-intake/services/signal-outcome.service';
import type { SignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import { SIGNAL_TRADER_CONFIG } from '../../signal-trader/services/signal-trader.service';
import { DATA_UNAVAILABLE, evaluateClaim, marketContext, postSessionOf, sectorRefOf, type ClaimEvaluation, type IntradayBar } from '../domain/claim-outcome';
import type { Claim } from '../domain/reading.types';
import { MessageReaderRepository, type UnscoredReading } from '../repositories/message-reader.repository';

/** Rows posted within this many days are (re)tried. */
const LOOKBACK_DAYS = 20;
/**
 * A row with a claim still pending (DAYS / WEEKS horizon not over, or its bars empty / failed / short of the
 * post's session) is retried nightly; after this many days it is filled NOT_SCORED "data unavailable".
 */
const PENDING_DAYS = 12;
/** Daily bars per instrument: the lookback + 20-day median / ATR14 + holidays. */
const DAILY_BARS_DAYS = 80;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;
const NIFTY = INDEX_UNDERLYINGS.NIFTY;

const istYmd = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Ref = { exchange: string; token: string };
export type ScoringStore = Pick<MessageReaderRepository, 'unscored' | 'fillOutcome' | 'storeCloseBreadth'>;

/** One stored claim score (message_readings.outcomes[i], same order as claims). */
export interface ClaimOutcomeRow {
  text: string;
  subject: string;
  claimType: Claim['claimType'];
  bias: Claim['bias'];
  horizon: Claim['horizon'];
  verdict: Claim['verdict'];
  /** The NSE session the claim was judged on; null when the post has no session in the bars. */
  session: string | null;
  status: 'RIGHT' | 'WRONG' | 'NOT_SCORED';
  why: string;
}

/**
 * Night review of the AI reader's claims (spec §5.5): at 15:25 IST the session's advance/decline ratio is
 * parked on its rows (the A/D at read time is not the close); at 18:30 IST every row whose NSE session is
 * over is scored claim by claim (`evaluateClaim`) on NIFTY / subject daily bars and NIFTY 15m bars, all over
 * the owner's own Angel session via signal-intake's `SIGNAL_INFO_BARS`. A claim whose DAYS / WEEKS horizon
 * is not over, or whose bars are empty / failed (a broker hiccup must not wipe a night's scores), keeps its row
 * open; after PENDING_DAYS it is filled NOT_SCORED "data unavailable". Only an unresolvable instrument and the
 * rule-level cases (FLOW / GAP / OTHER, inside the flat band) fill at once. A row fills when no claim is pending.
 */
@Injectable()
export class ClaimScoringService {
  private readonly logger = new Logger(ClaimScoringService.name);

  constructor(
    @Inject(MessageReaderRepository) private readonly repo: ScoringStore,
    @Inject(SIGNAL_INFO_BARS) private readonly bars: InfoBars,
    @Inject(BreadthSectorService) private readonly breadth: Pick<BreadthSectorService, 'getBreadth'>,
    @Inject(SIGNAL_TRADER_CONFIG) private readonly traderCfg: Pick<SignalTraderConfig, 'ownerUserId'>,
    @Optional() @Inject(SignalVocabularyService) private readonly vocab?: { get(): Promise<Vocabulary> },
    @Optional() @Inject(SIGNAL_INFO_MASTER) private readonly master?: { rows(): Promise<readonly unknown[] | null> },
  ) {}

  /** 15:25 IST: the owner's A/D ratio onto today's unscored rows. Null (nothing stored) when it could not be priced. */
  async storeCloseBreadth(now: Date = new Date()): Promise<number | null> {
    const owner = this.traderCfg.ownerUserId;
    if (!owner) {
      this.logger.warn('[message-reader] close breadth skipped: no owner user id (HUB_OWNER_USER_ID)');
      return null;
    }
    const b = await this.breadth.getBreadth(owner);
    if (b.total === 0) {
      this.logger.warn('[message-reader] close breadth skipped: no breadth quote priced');
      return null;
    }
    const rows = await this.repo.storeCloseBreadth(istYmd(now), b.adRatio, now);
    this.logger.log(`[message-reader] close breadth A/D ${b.adRatio} (${b.advances}/${b.declines}) stored on ${rows} rows`);
    return b.adRatio;
  }

  /** 18:30 IST: score the rows whose session is over. */
  async scoreNight(now: Date = new Date()): Promise<{ filled: number; pending: number }> {
    const rows = await this.repo.unscored(new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS));
    if (rows.length === 0) return { filled: 0, pending: 0 };

    const from = new Date(now.getTime() - DAILY_BARS_DAYS * DAY_MS);
    const today = istYmd(now);
    const dailyCache = new Map<string, Promise<DailyBar[]>>();
    const dailyOf = (ref: Ref): Promise<DailyBar[]> => {
      const k = `${ref.exchange}:${ref.token}`;
      let hit = dailyCache.get(k);
      if (!hit) {
        hit = this.bars
          .daily(ref.exchange, ref.token, from, now)
          // MCX trades till 23:30: today's daily bar is not final at 18:30.
          .then((b) => (ref.exchange === 'MCX' ? b.filter((x) => x.day < today) : b))
          .catch((e) => {
            this.logger.warn(`[message-reader] daily bars ${k} failed: ${errText(e)}`);
            return [];
          });
        dailyCache.set(k, hit);
      }
      return hit;
    };
    const niftyDaily = await dailyOf(NIFTY);
    const nifty15m = await this.nifty15m(new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS), now);
    const niftyDays = niftyDaily.map((b) => b.day);
    const adBySession = new Map<string, number>();
    for (const r of rows) if (r.closeBreadth) adBySession.set(r.closeBreadth.session, r.closeBreadth.adAtClose);
    const lookups = this.lookups();

    let filled = 0;
    let pending = 0;
    for (const r of rows) {
      try {
        const stale = now.getTime() - r.postedAt.getTime() > PENDING_DAYS * DAY_MS;
        const session = postSessionOf(r.postedAt, niftyDays, now);
        if (!session && !stale && r.claims.length > 0) {
          pending++;
          continue;
        }
        const market = session ? marketContext(niftyDaily, nifty15m, r.postedAt, session) : null;
        const evals: Array<{ c: Claim; e: ClaimEvaluation }> = [];
        for (const c of r.claims) {
          if (!session || !market) {
            evals.push({ c, e: { status: 'PENDING', why: `${DATA_UNAVAILABLE}: no NIFTY session in the bars for the post` } });
            continue;
          }
          const ref = needsSubject(c) ? await this.refOf(c, r.postedAt, lookups) : null;
          if (needsSubject(c) && !ref) {
            evals.push({ c, e: { status: 'NOT_SCORED', why: `instrument unresolved: ${c.subject}` } });
            continue;
          }
          const e = evaluateClaim(c, {
            niftyDaily,
            subjectDaily: ref ? await dailyOf(ref) : null,
            postSession: session,
            ...market,
            adAtClose: adBySession.get(session) ?? null,
          });
          evals.push({ c, e });
        }
        if (evals.some((x) => x.e.status === 'PENDING') && !stale) {
          pending++;
          continue;
        }
        const outcomes: ClaimOutcomeRow[] = evals.map(({ c, e }) => ({
          text: c.text,
          subject: c.subject,
          claimType: c.claimType,
          bias: c.bias,
          horizon: c.horizon,
          verdict: c.verdict,
          session,
          status: e.status === 'PENDING' ? 'NOT_SCORED' : e.status,
          why: e.status === 'PENDING' ? `${DATA_UNAVAILABLE} after ${PENDING_DAYS} days (${e.why})` : e.why,
        }));
        await this.repo.fillOutcome(r.messageId, outcomes, now);
        filled++;
      } catch (e) {
        pending++;
        this.logger.warn(`[message-reader] night score for ${r.messageId} failed: ${errText(e)}`);
      }
    }
    this.logger.log(`[message-reader] night scoring: ${filled} filled, ${pending} pending`);
    if (pending > 0) this.logger.warn(`[message-reader] night scoring left ${pending} rows pending (horizon not over or data unavailable; retried nightly for ${PENDING_DAYS} days)`);
    return { filled, pending };
  }

  private async nifty15m(from: Date, to: Date): Promise<IntradayBar[]> {
    if (!this.bars.intraday15m) {
      this.logger.warn('[message-reader] no NIFTY 15m loader (SIGNAL_INFO_BARS.intraday15m): post-time rules stay pending');
      return [];
    }
    try {
      return await this.bars.intraday15m(NIFTY.exchange, NIFTY.token, from, to);
    } catch (e) {
      this.logger.warn(`[message-reader] NIFTY 15m bars failed (post-time rules not scored): ${errText(e)}`);
      return [];
    }
  }

  /** Vocabulary + instrument master, loaded once per run and only when a stock / commodity subject needs them. */
  private lookups(): () => Promise<{ vocab: Vocabulary | null; master: readonly unknown[] | null }> {
    let p: Promise<{ vocab: Vocabulary | null; master: readonly unknown[] | null }> | null = null;
    return () =>
      (p ??= (async () => {
        const vocab = (await this.vocab?.get().catch(() => null)) ?? null;
        let master: readonly unknown[] | null = null;
        try {
          master = (await this.master?.rows()) ?? null;
        } catch (e) {
          this.logger.warn(`[message-reader] instrument master unavailable (stock / MCX claims not scored): ${errText(e)}`);
        }
        return { vocab, master };
      })());
  }

  /** The daily-bar instrument of a DIRECTION / SECTOR claim: sector index, index, NSE cash stock or front MCX future. */
  private async refOf(c: Claim, postedAt: Date, lookups: ReturnType<ClaimScoringService['lookups']>): Promise<Ref | null> {
    const subject = c.subject.trim().toUpperCase();
    const index = INDEX_UNDERLYINGS[subject];
    if (c.claimType === 'SECTOR') return sectorRefOf(subject) ?? (index ? { exchange: index.exchange, token: index.token } : null);
    if (index) return { exchange: index.exchange, token: index.token };
    const sector = sectorRefOf(subject);
    if (sector) return sector;
    const { vocab, master } = await lookups();
    return infoRefOf(subject, vocab, master, postedAt);
  }
}

/** DIRECTION on something other than MARKET, and SECTOR, are judged on the subject's own bars. */
function needsSubject(c: Claim): boolean {
  return (c.claimType === 'DIRECTION' && c.subject !== 'MARKET') || c.claimType === 'SECTOR';
}
