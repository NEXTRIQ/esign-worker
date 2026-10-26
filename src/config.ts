import { z } from "zod";

/** Bindings and variables as configured in wrangler.jsonc and secrets. */
export interface Env {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  ADMIN_TOKEN?: string;
  APP_SECRET?: string;
  EMAIL_API_KEY?: string;
  PUBLIC_BASE_URL?: string;
  ORG_NAME?: string;
  MAIL_FROM?: string;
  OWNER_EMAIL?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_API_URL?: string;
  DEFAULT_EXPIRY_DAYS?: string;
  MAX_EXPIRY_DAYS?: string;
  DOWNLOAD_DAYS?: string;
  MAX_PDF_BYTES?: string;
}

/** Treats an empty string like an unset variable. */
const blankToUndefined = (value: string | undefined) => value?.trim() || undefined;

const days = (fallback: number) => z.coerce.number().int().min(1).max(365).default(fallback);

const ConfigSchema = z
  .object({
    ADMIN_TOKEN: z.string().min(32, "must be at least 32 characters"),
    APP_SECRET: z.string().min(32, "must be at least 32 characters"),
    PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).transform((url) => url.replace(/\/+$/, "")),
    ORG_NAME: z.string().trim().min(1).max(100),
    MAIL_FROM: z.string().trim().min(3).max(200),
    OWNER_EMAIL: z
      .union([z.literal(""), z.email()])
      .optional()
      .transform(blankToUndefined),
    EMAIL_PROVIDER: z.enum(["log", "http"]).default("log"),
    EMAIL_API_URL: z.url({ protocol: /^https$/ }).default("https://api.resend.com/emails"),
    EMAIL_API_KEY: z.string().optional().transform(blankToUndefined),
    DEFAULT_EXPIRY_DAYS: days(14),
    MAX_EXPIRY_DAYS: days(60),
    DOWNLOAD_DAYS: days(30),
    MAX_PDF_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(10 * 1024 * 1024),
  })
  .refine((c) => c.DEFAULT_EXPIRY_DAYS <= c.MAX_EXPIRY_DAYS, {
    path: ["DEFAULT_EXPIRY_DAYS"],
    message: "must not exceed MAX_EXPIRY_DAYS",
  })
  .refine((c) => c.EMAIL_PROVIDER !== "http" || c.EMAIL_API_KEY !== undefined, {
    path: ["EMAIL_API_KEY"],
    message: "is required when EMAIL_PROVIDER is http",
  });

export interface Config {
  adminToken: string;
  appSecret: string;
  publicBaseUrl: string;
  orgName: string;
  mailFrom: string;
  ownerEmail: string | undefined;
  email: { provider: "log" } | { provider: "http"; apiUrl: string; apiKey: string };
  defaultExpiryDays: number;
  maxExpiryDays: number;
  downloadDays: number;
  maxPdfBytes: number;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Validates configuration on every request (it is cheap) so that a missing
 * secret fails closed instead of, say, accepting an empty admin token.
 * Issue messages name the variable but never echo its value.
 */
export function loadConfig(env: Env): Config {
  const parsed = ConfigSchema.safeParse({
    ADMIN_TOKEN: env.ADMIN_TOKEN,
    APP_SECRET: env.APP_SECRET,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
    ORG_NAME: env.ORG_NAME,
    MAIL_FROM: env.MAIL_FROM,
    OWNER_EMAIL: env.OWNER_EMAIL,
    EMAIL_PROVIDER: env.EMAIL_PROVIDER,
    EMAIL_API_URL: env.EMAIL_API_URL,
    EMAIL_API_KEY: env.EMAIL_API_KEY,
    DEFAULT_EXPIRY_DAYS: env.DEFAULT_EXPIRY_DAYS,
    MAX_EXPIRY_DAYS: env.MAX_EXPIRY_DAYS,
    DOWNLOAD_DAYS: env.DOWNLOAD_DAYS,
    MAX_PDF_BYTES: env.MAX_PDF_BYTES,
  });
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`),
    );
  }
  const c = parsed.data;
  return {
    adminToken: c.ADMIN_TOKEN,
    appSecret: c.APP_SECRET,
    publicBaseUrl: c.PUBLIC_BASE_URL,
    orgName: c.ORG_NAME,
    mailFrom: c.MAIL_FROM,
    ownerEmail: c.OWNER_EMAIL,
    email:
      c.EMAIL_PROVIDER === "http"
        ? { provider: "http", apiUrl: c.EMAIL_API_URL, apiKey: c.EMAIL_API_KEY ?? "" }
        : { provider: "log" },
    defaultExpiryDays: c.DEFAULT_EXPIRY_DAYS,
    maxExpiryDays: c.MAX_EXPIRY_DAYS,
    downloadDays: c.DOWNLOAD_DAYS,
    maxPdfBytes: c.MAX_PDF_BYTES,
  };
}
