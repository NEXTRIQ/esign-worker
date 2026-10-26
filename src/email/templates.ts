import type { EmailMessage } from "./mailer";

/**
 * Plain-text templates. Plain text keeps the messages readable everywhere,
 * avoids HTML-injection concerns with user-supplied titles and makes the
 * signing link impossible to disguise behind other link text.
 */

function formatDate(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function invitationEmail(input: {
  orgName: string;
  signerName: string;
  signerEmail: string;
  title: string;
  message: string | null;
  signingUrl: string;
  expiresAt: string;
}): EmailMessage {
  const note = input.message ? `\nMessage from ${input.orgName}:\n${input.message}\n` : "";
  return {
    to: input.signerEmail,
    subject: `Please sign: ${input.title}`,
    text: [
      `Hello ${input.signerName},`,
      "",
      `${input.orgName} has asked you to review and sign "${input.title}".`,
      note,
      "Open your personal signing link:",
      input.signingUrl,
      "",
      `The link expires on ${formatDate(input.expiresAt)}. Do not forward this email: anyone with the link can sign.`,
      "",
      `If you did not expect this request, you can ignore this email.`,
    ].join("\n"),
  };
}

export function signerCompletionEmail(input: {
  orgName: string;
  signerName: string;
  signerEmail: string;
  title: string;
  downloadUrl: string;
  downloadDays: number;
  signedPdf: Uint8Array;
  filename: string;
}): EmailMessage {
  return {
    to: input.signerEmail,
    subject: `Signed: ${input.title}`,
    text: [
      `Hello ${input.signerName},`,
      "",
      `You signed "${input.title}" for ${input.orgName}. The signed PDF, including the signature evidence page, is attached.`,
      "",
      `You can also download it for the next ${input.downloadDays} days:`,
      input.downloadUrl,
    ].join("\n"),
    attachments: [
      { filename: input.filename, contentType: "application/pdf", content: input.signedPdf },
    ],
  };
}

export function ownerCompletionEmail(input: {
  ownerEmail: string;
  signerName: string;
  signerEmail: string;
  title: string;
  requestId: string;
  signedAt: string;
  signedSha256: string;
  signedPdf: Uint8Array;
  filename: string;
}): EmailMessage {
  return {
    to: input.ownerEmail,
    subject: `Signed by ${input.signerName}: ${input.title}`,
    text: [
      `"${input.title}" was signed by ${input.signerName} <${input.signerEmail}> at ${input.signedAt}.`,
      "",
      `Request ID: ${input.requestId}`,
      `Signed PDF SHA-256: ${input.signedSha256}`,
      "",
      "The signed PDF is attached. The evidence record is available from the admin API.",
    ].join("\n"),
    attachments: [
      { filename: input.filename, contentType: "application/pdf", content: input.signedPdf },
    ],
  };
}
