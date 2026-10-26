import type { Config } from "../config";
import { toBase64 } from "../lib/crypto";
import { redactTokens } from "../lib/redact";

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  attachments?: EmailAttachment[];
}

/** The only thing the application needs from an email provider. */
export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export class EmailDeliveryError extends Error {
  constructor(readonly status: number) {
    super(`Email provider responded with HTTP ${status}`);
    this.name = "EmailDeliveryError";
  }
}

/**
 * Sends through an HTTP API that accepts the Resend request shape
 * (`from`, `to[]`, `subject`, `text`, `attachments[{filename, content}]`).
 * Several providers and self-hosted relays accept the same shape; for others,
 * implement `Mailer`.
 */
export class HttpMailer implements Mailer {
  constructor(
    private readonly options: {
      apiUrl: string;
      apiKey: string;
      from: string;
      fetch?: typeof fetch;
    },
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const doFetch = this.options.fetch ?? fetch;
    const response = await doFetch(this.options.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.options.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: toBase64(a.content),
          content_type: a.contentType,
        })),
      }),
    });
    // The body may echo addresses or content; only the status is surfaced.
    if (!response.ok) {
      await response.body?.cancel();
      throw new EmailDeliveryError(response.status);
    }
  }
}

/**
 * Development mailer: logs that a message would have been sent. Message
 * bodies contain signing links, so they are redacted rather than printed;
 * the admin API returns the link when a request is created.
 */
export class LogMailer implements Mailer {
  send(message: EmailMessage): Promise<void> {
    console.info(
      JSON.stringify({
        event: "email.log_only",
        to: message.to,
        subject: message.subject,
        text: redactTokens(message.text),
        attachments:
          message.attachments?.map((a) => `${a.filename} (${a.content.length} bytes)`) ?? [],
      }),
    );
    return Promise.resolve();
  }
}

export function createMailer(config: Config): Mailer {
  return config.email.provider === "http"
    ? new HttpMailer({
        apiUrl: config.email.apiUrl,
        apiKey: config.email.apiKey,
        from: config.mailFrom,
      })
    : new LogMailer();
}
