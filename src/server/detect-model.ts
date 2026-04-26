import { DEFAULT_DEPLOYMENT } from "../shared/constants.js";

/**
 * Detect a sensible default deployment to surface in the create-agent UI.
 * Order of precedence:
 *   1. AZURE_FOUNDRY_DEPLOYMENT env var
 *   2. AZURE_FOUNDRY_DEFAULT_DEPLOYMENT env var
 *   3. Constant default (gpt-5-5)
 *
 * In a future iteration this should call /openai/v1/models on the configured
 * Foundry endpoint and return the actual deployment list with capability
 * metadata.
 */
export function detectModel(): { model: string; source: string } {
  const fromEnv =
    process.env.AZURE_FOUNDRY_DEPLOYMENT?.trim() ||
    process.env.AZURE_FOUNDRY_DEFAULT_DEPLOYMENT?.trim();
  if (fromEnv) return { model: fromEnv, source: "env" };
  return { model: DEFAULT_DEPLOYMENT, source: "default" };
}
