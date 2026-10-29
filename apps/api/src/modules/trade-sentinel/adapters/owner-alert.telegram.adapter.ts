import { Logger } from '@nestjs/common';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { formatOwnerAlert, type OwnerAlert, type OwnerAlertPort } from '../ports/owner-alerts.port';

type Env = Record<string, string | undefined>;

/** SENTINEL_OWNER_ALERTS — on unless exactly `false` / `off`. */
export function ownerAlertsEnabled(env: Env): boolean {
  const v = (env.SENTINEL_OWNER_ALERTS ?? '').trim().toLowerCase();
  return v !== 'false' && v !== 'off';
}

/**
 * The owner-alert port over the existing Telegram ops bot (common/utils/ops-alert.ts:
 * TELEGRAM_ALERT_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID, the same bot the deploy unit and
 * the exit executor already use). No new HTTP client. `sendOpsAlert` never throws,
 * never logs the token, is a no-op when unconfigured, and sends each key at most once
 * per 30 min — the cycle's own per-position key carries that guarantee.
 * Bound with useFactory in trade-sentinel.module.ts (its arguments are not injectables).
 */
export class TelegramOwnerAlerts implements OwnerAlertPort {
  private readonly logger = new Logger(TelegramOwnerAlerts.name);
  private readonly enabled: boolean;

  constructor(env: Env = process.env, private readonly send_: typeof sendOpsAlert = sendOpsAlert) {
    this.enabled = ownerAlertsEnabled(env);
  }

  async send(alert: OwnerAlert): Promise<void> {
    if (!this.enabled) return;
    const ok = await this.send_(`sentinel-owner:${alert.key}`, formatOwnerAlert(alert));
    if (ok) this.logger.log(`[owner-alert] ${alert.kind} sent for ${alert.symbol} (${alert.verdict})`);
  }
}
