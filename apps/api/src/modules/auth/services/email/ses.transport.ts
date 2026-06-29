import { EmailMessage, EmailTransport } from './email.types';

/**
 * Production transport stub. Real AWS SES wiring (SDK client, credentials via
 * Secrets Manager) lands in TDA-004. Until then `send` throws so that selecting
 * SES in an unconfigured environment fails loudly rather than silently dropping
 * mail.
 */
export class SesEmailTransport implements EmailTransport {
  async send(_msg: EmailMessage): Promise<void> {
    throw new Error('SES transport not configured — wired in TDA-004');
  }
}
