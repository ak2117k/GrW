import { Injectable, Logger } from '@nestjs/common';
import { ConsoleEmailTransport } from './console.transport';
import { SesEmailTransport } from './ses.transport';
import { EmailMessage, EmailTransport } from './email.types';

/**
 * Composes transactional auth emails and delegates delivery to a pluggable
 * {@link EmailTransport}. The transport is chosen by the `EMAIL_TRANSPORT`
 * env var (`console` default for dev/test, `ses` for production — stubbed
 * until TDA-004). Tests may inject a transport directly via the constructor.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transport: EmailTransport;

  constructor(transport?: EmailTransport) {
    this.transport = transport ?? EmailService.selectTransport();
  }

  /** Resolve the configured transport from `process.env.EMAIL_TRANSPORT`. */
  static selectTransport(): EmailTransport {
    const kind = (process.env.EMAIL_TRANSPORT ?? 'console').toLowerCase();
    switch (kind) {
      case 'ses':
        return new SesEmailTransport();
      case 'console':
      default:
        return new ConsoleEmailTransport();
    }
  }

  /** Send the email-verification link to a freshly signed-up user. */
  async sendVerification(to: string, link: string): Promise<void> {
    await this.deliver({
      to,
      subject: 'Verify your email address',
      html: this.renderHtml(
        'Confirm your email',
        'Please confirm your email address to activate your account.',
        'Verify email',
        link,
      ),
      text: `Confirm your email address to activate your account:\n\n${link}\n\nIf you did not create an account, you can ignore this email.`,
    });
  }

  /** Send the password-reset link to a user who requested a reset. */
  async sendPasswordReset(to: string, link: string): Promise<void> {
    await this.deliver({
      to,
      subject: 'Reset your password',
      html: this.renderHtml(
        'Reset your password',
        'We received a request to reset your password. This link expires shortly.',
        'Reset password',
        link,
      ),
      text: `Reset your password using the link below:\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
    });
  }

  private async deliver(msg: EmailMessage): Promise<void> {
    this.logger.debug(`Sending "${msg.subject}" to ${msg.to}`);
    await this.transport.send(msg);
  }

  private renderHtml(
    heading: string,
    body: string,
    cta: string,
    link: string,
  ): string {
    return [
      `<h2>${heading}</h2>`,
      `<p>${body}</p>`,
      `<p><a href="${link}">${cta}</a></p>`,
      `<p>Or paste this link into your browser:<br>${link}</p>`,
    ].join('\n');
  }
}
