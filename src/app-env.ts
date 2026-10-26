import type { MiddlewareHandler } from "hono";
import { loadConfig, type Env } from "./config";
import type { Deps } from "./domain/service";
import { createMailer } from "./email/mailer";

export interface AppEnv {
  Bindings: Env;
  Variables: { deps: Deps };
}

/** Builds the per-request dependencies. Config errors surface through onError. */
export const withDeps: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = loadConfig(c.env);
  c.set("deps", {
    db: c.env.DB,
    bucket: c.env.DOCUMENTS,
    mailer: createMailer(config),
    config,
    now: () => new Date(),
    defer: (work) => c.executionCtx.waitUntil(work),
  });
  await next();
};
