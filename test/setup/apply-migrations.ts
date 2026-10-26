import { applyD1Migrations, env } from "cloudflare:test";

// Runs outside per-test storage isolation, so the schema persists for every test.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
