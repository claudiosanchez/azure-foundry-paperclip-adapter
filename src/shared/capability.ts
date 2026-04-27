/**
 * Authoritative routing table — which Foundry deployments speak which API.
 *
 * Per the merge review (2026-04-27): we own this set, it's small, it doesn't
 * move. Hardcoding it eliminates an entire class of runtime risks (catalog
 * auth failures, staleness, races, deletion handling, fallback ladders) that
 * a "look up /v1/models at runtime" approach would introduce.
 *
 * If a deployment isn't in this table, we default to "chat" and let
 * testEnvironment surface a warning. To handle a genuinely new deployment
 * shape, set `apiSurface` explicitly in adapterConfig.
 */

export type ApiSurface = "chat" | "responses";

/**
 * Known Foundry deployments and the API surface they accept.
 *
 * Cross-reference: Foundry catalog at /openai/v1/models exposes
 * `capabilities.chat_completion`. Deployments with chat_completion=false
 * are Responses-API-only (pro reasoning models, codex variants).
 */
export const KNOWN_API_SURFACE: Record<string, ApiSurface> = {
  // Chat completions — flagship and high-volume models.
  "gpt-5-5": "chat",
  "gpt-5-4-mini": "chat",
  "gpt-5-4-nano": "chat",

  // Responses API only — reasoning, codex, and pro variants.
  "gpt-5-4-pro": "responses",
  "gpt-5-3-codex": "responses",
  "gpt-5-pro": "responses",
};

/**
 * Resolve which API surface a deployment uses.
 *
 * Resolution order:
 *   1. Explicit `override` (from `adapterConfig.apiSurface`) — escape hatch
 *      for deployments not yet in the table.
 *   2. Known table entry.
 *   3. Default to "chat" — most deployments support it; the responses-only
 *      variants are the exception.
 */
export function getApiSurface(
  deployment: string,
  override?: ApiSurface | string | null,
): ApiSurface {
  if (override === "chat" || override === "responses") return override;
  return KNOWN_API_SURFACE[deployment] ?? "chat";
}
