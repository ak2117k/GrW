import { Inject, Injectable, Logger } from '@nestjs/common';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import type { SessionClock } from '../../market-hub/session-clock';
import type { Finding, Severity } from '../domain/checks';
import { SanityAuditRepository } from '../repositories/sanity-audit.repository';
import { SANITY_CHECKS, type CheckContext, type SanityCheck } from './sanity-checks';

export const SANITY_AUDIT_CLOCK = Symbol('SANITY_AUDIT_CLOCK');
/** Alerts go out only for subjects at / after this; older ones are recorded 'known' (28–30 Oct, not repaired). */
export const DEFAULT_SANITY_AUDIT_SINCE = '2026-10-30T09:30:00Z';
/** How far back each run loads subjects. */
const DEFAULT_LOOKBACK_DAYS = 7;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Env = Record<string, string | undefined>;
type Alert = (key: string, text: string) => Promise<boolean>;

export function sanityAuditSince(env: Env): Date {
  const d = new Date((env.SANITY_AUDIT_SINCE ?? '').trim() || DEFAULT_SANITY_AUDIT_SINCE);
  return Number.isNaN(d.getTime()) ? new Date(DEFAULT_SANITY_AUDIT_SINCE) : d;
}

function lookbackDays(env: Env): number {
  const n = Number(env.SANITY_AUDIT_LOOKBACK_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60) : DEFAULT_LOOKBACK_DAYS;
}

/** Ops alert text: plain and short — which check, which subject, expected vs actual. */
export function alertText(check: string, f: Finding): string {
  return `Sanity ${check}: ${f.message}`;
}

export interface RunReport {
  checked: number;
  found: Array<{ check: string; subjectId: string; severity: Severity }>;
  /** Violation rows stored for the first time this run. */
  added: number;
  alerted: number;
  failed: string[];
}

/**
 * Runs every invariant in SANITY_CHECKS. DETECTION ONLY: it reads trades / decisions / exits / feeds and
 * writes nothing but sanity_violations — it never modifies a trade and never blocks anything. Each
 * violation is stored once per (check, subject) and alerted once (Telegram ops bot); subjects before
 * SANITY_AUDIT_SINCE are stored as 'known' and not alerted. A check whose query throws is reported (ops
 * alert, 30-min cooldown) and skipped; the others still run.
 */
@Injectable()
export class SanityAuditService {
  private readonly logger = new Logger(SanityAuditService.name);

  constructor(
    private readonly repo: SanityAuditRepository,
    @Inject(SANITY_AUDIT_CLOCK) private readonly clock: SessionClock,
  ) {}

  async run(now: Date = new Date(), deps: { env?: Env; alert?: Alert; checks?: readonly SanityCheck[] } = {}): Promise<RunReport> {
    const env = deps.env ?? process.env;
    const alert: Alert = deps.alert ?? ((k, t) => sendOpsAlert(k, t, { env }));
    const since = sanityAuditSince(env);
    const ctx: CheckContext = { now, from: new Date(now.getTime() - lookbackDays(env) * 86_400_000), clock: this.clock, env };
    const report: RunReport = { checked: 0, found: [], added: 0, alerted: 0, failed: [] };

    for (const c of deps.checks ?? SANITY_CHECKS) {
      let rows: unknown[];
      try {
        rows = await c.load(this.repo, ctx);
      } catch (e) {
        report.failed.push(c.id);
        this.logger.warn(`[sanity] ${c.check}/${c.id} query failed: ${errText(e)}`);
        await alert(`sanity:check-failed:${c.id}`, `Sanity audit: check ${c.check}/${c.id} could not run — ${errText(e).slice(0, 300)}`).catch(() => false);
        continue;
      }
      report.checked += rows.length;
      for (const row of rows) {
        let f: Finding | null;
        try {
          f = c.evaluate(row, ctx);
        } catch (e) {
          this.logger.warn(`[sanity] ${c.check}/${c.id} evaluate failed: ${errText(e)}`);
          continue;
        }
        if (!f) continue;
        const severity: Severity = f.subjectAt < since ? 'known' : c.severity;
        report.found.push({ check: c.check, subjectId: f.subjectId, severity });
        try {
          const out = await this.record(c.check, f, severity, now, alert);
          if (out.inserted) report.added += 1;
          if (out.sent) report.alerted += 1;
        } catch (e) {
          this.logger.warn(`[sanity] could not record ${c.check} ${f.subjectId}: ${errText(e)}`);
        }
      }
    }
    // Logged when something changed — a standing violation is not re-logged every 5 min.
    if (report.added > 0 || report.alerted > 0 || report.failed.length > 0) {
      const live = report.found.filter((x) => x.severity !== 'known').length;
      this.logger.warn(`[sanity] ${report.added} new violation(s); standing ${live} live / ${report.found.length - live} known; ${report.alerted} alerted; failed checks: ${report.failed.join(',') || 'none'}`);
    }
    return report;
  }

  /** Stores the violation; alerts it once when it is not 'known'. */
  private async record(check: string, f: Finding, severity: Severity, now: Date, alert: Alert): Promise<{ inserted: boolean; sent: boolean }> {
    const row = await this.repo.upsertViolation({ check, subjectId: f.subjectId, severity, detail: { ...f.detail, message: f.message, subjectAt: f.subjectAt.toISOString() }, at: now });
    const inserted = row.inserted;
    if (row.severity === 'known' || row.alertedAt) return { inserted, sent: false };
    if (!(await this.repo.claimAlert(row.id, now))) return { inserted, sent: false };
    const sent = await alert(`sanity:${check}:${f.subjectId}`, alertText(check, f)).catch(() => false);
    if (!sent) await this.repo.releaseAlert(row.id); // unconfigured / Telegram down: retried next run
    return { inserted, sent };
  }

  list(q: { since?: string; check?: string; severity?: string; limit?: string }) {
    const d = q.since ? new Date(q.since) : new Date(Date.now() - 7 * 86_400_000);
    const since = Number.isNaN(d.getTime()) ? new Date(Date.now() - 7 * 86_400_000) : d;
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000);
    return this.repo.listViolations({ since, check: q.check?.trim() || undefined, severity: q.severity?.trim() || undefined, limit });
  }
}
