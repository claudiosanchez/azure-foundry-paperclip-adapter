import {
  DEFAULT_API_VERSION,
  DEFAULT_DEPLOYMENT,
  DEFAULT_GRACE_SEC,
  DEFAULT_TIMEOUT_SEC,
} from "../shared/constants.js";
import type { AzureFoundryConfig } from "../shared/types.js";

/**
 * Form values from Paperclip's create-agent dialog.
 */
export interface AzureFoundryFormValues {
  endpoint?: string;
  deployment?: string;
  apiKey?: string;
  apiVersion?: string;
  reasoningEffort?: string;
  temperature?: number | string;
  maxOutputTokens?: number | string;
  instructionsFilePath?: string;
  enableToolLoop?: boolean;
  timeoutSec?: number | string;
  graceSec?: number | string;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asTrimmed(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Translate UI form values into the persisted `adapterConfig` shape.
 * Paperclip wraps secret-ish fields in `{ type: "plain", value: ... }` when
 * the agent record is updated; here we just produce the inner shape and let
 * the server normalize.
 */
export function buildAzureFoundryConfig(
  values: AzureFoundryFormValues,
): AzureFoundryConfig {
  const cfg: AzureFoundryConfig = {};

  const endpoint = asTrimmed(values.endpoint);
  if (endpoint) cfg.endpoint = endpoint;

  cfg.deployment = asTrimmed(values.deployment) ?? DEFAULT_DEPLOYMENT;
  cfg.apiVersion = asTrimmed(values.apiVersion) ?? DEFAULT_API_VERSION;

  const apiKey = asTrimmed(values.apiKey);
  if (apiKey) cfg.apiKey = apiKey;

  const re = asTrimmed(values.reasoningEffort);
  if (re && ["minimal", "low", "medium", "high", "xhigh"].includes(re)) {
    cfg.reasoningEffort = re as AzureFoundryConfig["reasoningEffort"];
  }

  const temperature = asNumber(values.temperature);
  if (temperature !== undefined) cfg.temperature = temperature;

  const maxOutputTokens = asNumber(values.maxOutputTokens);
  if (maxOutputTokens !== undefined) cfg.maxOutputTokens = maxOutputTokens;

  const instructionsFilePath = asTrimmed(values.instructionsFilePath);
  if (instructionsFilePath) cfg.instructionsFilePath = instructionsFilePath;

  if (typeof values.enableToolLoop === "boolean") {
    cfg.enableToolLoop = values.enableToolLoop;
  }

  cfg.timeoutSec = asNumber(values.timeoutSec) ?? DEFAULT_TIMEOUT_SEC;
  cfg.graceSec = asNumber(values.graceSec) ?? DEFAULT_GRACE_SEC;

  return cfg;
}
