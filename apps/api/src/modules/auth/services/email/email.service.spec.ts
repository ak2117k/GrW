import { Logger } from '@nestjs/common';
import { EmailService } from './email.service';
import { ConsoleEmailTransport } from './console.transport';
import { SesEmailTransport } from './ses.transport';
import { EmailMessage, EmailTransport } from './email.types';

/** Captures every message handed to the transport, for assertions. */
class FakeTransport implements EmailTransport {
  public readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
  }
}

describe('EmailService', () => {
  const ORIGINAL_TRANSPORT = process.env.EMAIL_TRANSPORT;

  afterEach(() => {
    if (ORIGINAL_TRANSPORT === undefined) {
      delete process.env.EMAIL_TRANSPORT;
    } else {
      process.env.EMAIL_TRANSPORT = ORIGINAL_TRANSPORT;
    }
    jest.restoreAllMocks();
  });

  describe('sendVerification', () => {
    it('composes a message whose body contains the verification link', async () => {
      const fake = new FakeTransport();
      const svc = new EmailService(fake);
      const link = 'https://app.example.com/verify?token=abc123';

      await svc.sendVerification('user@example.com', link);

      expect(fake.sent).toHaveLength(1);
      const msg = fake.sent[0];
      expect(msg.to).toBe('user@example.com');
      expect(msg.subject).toMatch(/verif/i);
      expect(msg.html).toContain(link);
      expect(msg.text).toContain(link);
    });

    it('logs the recipient, subject, and link via the console transport', async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      const svc = new EmailService(new ConsoleEmailTransport());
      const link = 'https://app.example.com/verify?token=zzz999';

      await svc.sendVerification('dev@example.com', link);

      const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('dev@example.com');
      expect(logged).toContain(link);
    });
  });

  describe('sendPasswordReset', () => {
    it('composes a message whose body contains the reset link', async () => {
      const fake = new FakeTransport();
      const svc = new EmailService(fake);
      const link = 'https://app.example.com/reset?token=reset777';

      await svc.sendPasswordReset('user@example.com', link);

      expect(fake.sent).toHaveLength(1);
      const msg = fake.sent[0];
      expect(msg.to).toBe('user@example.com');
      expect(msg.subject).toMatch(/reset|password/i);
      expect(msg.html).toContain(link);
      expect(msg.text).toContain(link);
    });
  });

  describe('SesEmailTransport (stub)', () => {
    it('send rejects with the not-configured stub error', async () => {
      const ses = new SesEmailTransport();
      await expect(
        ses.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' }),
      ).rejects.toThrow('SES transport not configured — wired in TDA-004');
    });
  });

  describe('transport selection by EMAIL_TRANSPORT', () => {
    it("defaults to the console transport when unset", async () => {
      delete process.env.EMAIL_TRANSPORT;
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      const svc = new EmailService();

      await svc.sendVerification('x@y.z', 'https://link/verify');

      expect(logSpy).toHaveBeenCalled();
    });

    it("selects the SES transport when EMAIL_TRANSPORT='ses'", async () => {
      process.env.EMAIL_TRANSPORT = 'ses';
      const svc = new EmailService();

      await expect(
        svc.sendVerification('x@y.z', 'https://link/verify'),
      ).rejects.toThrow('SES transport not configured — wired in TDA-004');
    });
  });
});
