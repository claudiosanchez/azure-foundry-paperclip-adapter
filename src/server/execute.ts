/**
 * Dispatcher — picks the right wire path for the configured deployment and
 * delegates. The actual wire format code lives in execute-chat.ts and
 * execute-responses.ts; the agent loop scaffolding lives in common.ts.
 *
 * Routing decision is made by `getApiSurface()` against a hardcoded table
 * (shared/capability.ts). Per the merge review (2026-04-27), this avoids
 * the runtime catalog HTTP dependency, cache invalidation logic, and
 * fallback ladders that an "ask /v1/models at runtime" approach would need.
 */
import { getApiSurface } from "../shared/capability.js";
import type { ExecuteContext, ExecuteResult } from "./common.js";
import { executeChat } from "./execute-chat.js";
import { executeResponses } from "./execute-responses.js";

export async function execute(ctx: ExecuteContext): Promise<ExecuteResult> {
  const cfg = ctx.config;
  const deployment = String(cfg.deployment ?? "").trim();
  const surface = getApiSurface(deployment, cfg.apiSurface);
  return surface === "responses" ? executeResponses(ctx) : executeChat(ctx);
}

// Re-export the typed entries so consumers (and tests) can call paths directly.
export type { ExecuteContext, ExecuteResult } from "./common.js";
export { executeChat } from "./execute-chat.js";
export { executeResponses } from "./execute-responses.js";
