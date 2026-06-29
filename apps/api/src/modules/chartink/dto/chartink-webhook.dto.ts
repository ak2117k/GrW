import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Verbatim Chartink webhook body. See the official docs:
 *   https://chartink.com/articles/alerts/webhook-support-for-alerts/
 *
 * The two CSV strings (`stocks` and `trigger_prices`) are parallel-indexed.
 * `triggered_at` is a clock-only string ("2:34 pm"); we attach today's IST
 * date in the ingest service.
 */
export class ChartinkWebhookDto {
  @IsString() @IsNotEmpty() stocks!: string;
  @IsString() @IsNotEmpty() trigger_prices!: string;
  @IsString() @IsNotEmpty() triggered_at!: string;
  @IsString() @IsNotEmpty() scan_name!: string;
  @IsString() @IsNotEmpty() scan_url!: string;
  @IsString() @IsNotEmpty() alert_name!: string;
  @IsString() webhook_url!: string;
}
