import { Logger } from '@nestjs/common';
import { EmailMessage, EmailTransport } from './email.types';

/**
 * Development email transport: instead of delivering mail, it logs the message
 * (recipient, subject, and body containing the verification/reset link) via the
 * Nest `Logger`. This lets developers complete email flows by copying the link
 * from the console — no real SMTP/SES dependency in dev or tests.
 */
export class ConsoleEmailTransport implements EmailTransport {
  private readonly logger = new Logger(ConsoleEmailTransport.name);

  async send(msg: EmailMessage): Promise<void> {
    this.logger.log(
      `[email] to=${msg.to} subject="${msg.subject}"\n${msg.text}`,
    );
  }
}
