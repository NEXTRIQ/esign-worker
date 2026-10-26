import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    test: {
      setupFiles: ["./test/setup/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              ADMIN_TOKEN: "test-admin-token-0123456789abcdef0123456789",
              APP_SECRET: "test-app-secret-0123456789abcdef0123456789ab",
              PUBLIC_BASE_URL: "https://sign.example.com",
              ORG_NAME: "Acme B.V.",
              MAIL_FROM: "Acme B.V. <signing@example.com>",
              OWNER_EMAIL: "owner@example.com",
              EMAIL_PROVIDER: "log",
            },
          },
        },
      },
    },
  };
});
