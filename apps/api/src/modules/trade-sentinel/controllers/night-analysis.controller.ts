import { Controller, Logger, Post } from '@nestjs/common';
import { AdminOnly } from '../../../common/decorators/roles.decorator';
import { ScorecardService } from '../../overnight-scorecard/scorecard.service';
import { NewsIdeasService } from '../../overnight-scorecard/news-ideas.service';
import { SentinelOvernightService } from '../services/sentinel-overnight.service';
import { AFTER_CLOSE_EQUITY } from '../overnight/overnight-calendar';

const IST_OFFSET_MIN = 330;

/** `day` (UTC midnight of an IST calendar day) at hh:mm IST, as a UTC instant. */
export function istAt(day: Date, hh: number, mm: number): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh, mm) - IST_OFFSET_MIN * 60_000);
}

/** The IST calendar day `now` falls on, as a UTC-midnight Date. */
export function istDay(now: Date): Date {
  const t = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

/**
 * Owner's "re-run night analysis" (Night Report button): redo the LAST NSE session's
 * night with the current pipeline — scorecards for the overnight positions, the news-ideas
 * night batch, then the overnight review (which reads those scorecards) under a re-run tag,
 * so the original verdicts stay as history. Runs inside the live API (its own Angel
 * session — no second login). Admin only.
 */
@Controller('api/trade-sentinel/night-analysis')
export class NightAnalysisController {
  private readonly logger = new Logger(NightAnalysisController.name);
  private running = false;

  constructor(
    private readonly scorecards: ScorecardService,
    private readonly newsIdeas: NewsIdeasService,
    private readonly overnight: SentinelOvernightService,
  ) {}

  @Post('rerun')
  @AdminOnly()
  async rerun(): Promise<Record<string, unknown>> {
    if (this.running) return { started: false, reason: 'a re-run is already in progress' };
    this.running = true;
    // One judge call per position takes minutes — longer than the edge proxy's request limit —
    // so it runs in the background; the page polls the night report until the new rows land.
    void this.run(new Date())
      .catch((e) => this.logger.warn(`[night-analysis] re-run failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.running = false;
      });
    return { started: true };
  }

  /** Walks back to the newest NSE session whose 15:45 IST scorecard window is due, then runs the night. */
  async run(now: Date): Promise<Record<string, unknown>> {
    let closeDay: Date | null = null;
    let scorecards: unknown = null;
    for (let back = 0; back <= 7 && !closeDay; back++) {
      const day = new Date(istDay(now).getTime() - back * 86_400_000);
      const at = istAt(day, 15, 45);
      if (at > now) continue;
      const res = await this.scorecards.run('OVERNIGHT', at);
      if (res.reason === 'not an NSE session window') continue;
      closeDay = day;
      scorecards = res;
    }
    if (!closeDay) return { started: false, reason: 'no NSE session found in the last 7 days' };
    const news = await this.newsIdeas.run('NIGHT', istAt(closeDay, 23, 30));
    const tag = `rerun-${now.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
    const review = await this.overnight.runWindow(AFTER_CLOSE_EQUITY, istAt(closeDay, 15, 48), { rerunTag: tag });
    const session = closeDay.toISOString().slice(0, 10);
    this.logger.log(
      `[night-analysis] re-run of ${session}: scorecards ${JSON.stringify(scorecards)} | news ${JSON.stringify(news)} | review ${JSON.stringify(review)}`,
    );
    return { started: true, session, scorecards, newsIdeas: news, overnightReview: review };
  }
}
