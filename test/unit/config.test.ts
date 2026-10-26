import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type Env } from "../../src/config";

const valid = {
  DB: {} as D1Database,
  DOCUMENTS: {} as R2Bucket,
  ADMIN_TOKEN: "a".repeat(32),
  APP_SECRET: "b".repeat(32),
  PUBLIC_BASE_URL: "https://sign.example.com/",
  ORG_NAME: "Acme B.V.",
  MAIL_FROM: "signing@example.com",
} satisfies Env;

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(valid);
    expect(config).toMatchObject({
      publicBaseUrl: "https://sign.example.com",
      defaultExpiryDays: 14,
      maxExpiryDays: 60,
      downloadDays: 30,
      email: { provider: "log" },
      ownerEmail: undefined,
    });
  });

  it("fails closed on short secrets without echoing them", () => {
    let error: unknown;
    try {
      loadConfig({ ...valid, ADMIN_TOKEN: "short-token" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain("ADMIN_TOKEN");
    expect(String(error)).not.toContain("short-token");
  });

  it("requires an API key for the HTTP email provider", () => {
    expect(() => loadConfig({ ...valid, EMAIL_PROVIDER: "http" })).toThrow(/EMAIL_API_KEY/);
    expect(
      loadConfig({ ...valid, EMAIL_PROVIDER: "http", EMAIL_API_KEY: "k" }).email.provider,
    ).toBe("http");
  });

  it("rejects a default expiry above the maximum", () => {
    expect(() =>
      loadConfig({ ...valid, DEFAULT_EXPIRY_DAYS: "90", MAX_EXPIRY_DAYS: "30" }),
    ).toThrow(/DEFAULT_EXPIRY_DAYS/);
  });
});
