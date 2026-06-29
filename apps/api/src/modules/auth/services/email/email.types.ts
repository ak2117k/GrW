/**
 * A fully-composed outbound email. Transports receive these verbatim — the
 * `EmailService` is responsible for rendering subject/html/text.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Pluggable delivery mechanism. Implementations: {@link ConsoleEmailTransport}
 * (dev) and {@link SesEmailTransport} (prod, wired in TDA-004).
 */
export interface EmailTransport {
  send(msg: EmailMessage): Promise<void>;
}
