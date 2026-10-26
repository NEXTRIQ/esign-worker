import { Hono } from "hono";
import { withDeps, type AppEnv } from "./app-env";
import { ConfigError } from "./config";
import { ConflictError, NotFoundError, ValidationError } from "./domain/model";
import { PAGE_CSP, securityHeaders } from "./lib/headers";
import { redactTokens } from "./lib/redact";
import { adminRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";
import { statusPage } from "./views/pages";

// No request-logging middleware on purpose: request URLs contain signing tokens.
const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
app.use("*", withDeps);

app.get("/healthz", (c) => c.json({ ok: true }));
app.route("/api", adminRoutes);
app.route("/", publicRoutes);

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
  c.header("Content-Security-Policy", PAGE_CSP);
  return c.html(statusPage(c.var.deps?.config.orgName ?? "", "not_found"), 404);
});

app.onError((error, c) => {
  const api = c.req.path.startsWith("/api/");
  if (api && error instanceof ValidationError) {
    return c.json({ error: "validation_failed", fields: error.fields }, 422);
  }
  if (error instanceof NotFoundError) {
    return api
      ? c.json({ error: "not_found" }, 404)
      : c.html(statusPage(c.var.deps?.config.orgName ?? "", "not_found"), 404);
  }
  if (api && error instanceof ConflictError) {
    return c.json({ error: "conflict", status: error.status }, 409);
  }
  if (error instanceof ConfigError) {
    // Names of the invalid variables only; values never reach the logs.
    console.error(error.message);
  } else {
    console.error(`unhandled error on ${c.req.method} ${redactTokens(c.req.path)}`, error);
  }
  if (api) return c.json({ error: "internal_error" }, 500);
  c.header("Content-Security-Policy", PAGE_CSP);
  return c.html(statusPage(c.var.deps?.config.orgName ?? "", "error"), 500);
});

export default app;
