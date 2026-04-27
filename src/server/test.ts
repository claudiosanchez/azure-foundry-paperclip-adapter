import { OPENAI_V1_PATH } from "../shared/constants.js";

/**
 * Paperclip's adapter-utils contract:
 *
 *   testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>
 *
 * The UI fetches POST /api/companies/:companyId/adapters/:type/test-environment
 * and renders the returned `checks` array. Returning the wrong shape blanks the
 * configuration page (the UI assumes `result.checks.map(...)` is iterable).
 */

interface AdapterEnvironmentTestContext {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
  deployment?: unknown;
}

type CheckLevel = "info" | "warn" | "error";

interface AdapterEnvironmentCheck {
  code: string;
  level: CheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: "pass" | "warn" | "fail";
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}

/** Unwrap Paperclip's secret envelope `{type:"plain"|"ref",value:...}`. */
function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "value" in v && typeof (v as { value: unknown }).value === "string") {
    return (v as { value: string }).value;
  }
  return "";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = ctx.config ?? {};

  const endpoint = (asString(config.endpoint) || process.env.AZURE_FOUNDRY_ENDPOINT || "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = (asString(config.apiKey) || process.env.AZURE_FOUNDRY_API_KEY || "").trim();
  const deployment = asString(config.deployment).trim();

  if (!endpoint) {
    checks.push({
      code: "endpoint_missing",
      level: "error",
      message: "Endpoint is not configured.",
      hint: "Set the Endpoint field to your Foundry resource base URL, e.g. https://foundry-coxshire-eastus2.cognitiveservices.azure.com/",
    });
  } else if (!/^https?:\/\//i.test(endpoint)) {
    checks.push({
      code: "endpoint_malformed",
      level: "error",
      message: `Endpoint does not start with http:// or https://`,
      detail: endpoint,
    });
  } else {
    checks.push({
      code: "endpoint_ok",
      level: "info",
      message: `Endpoint configured`,
      detail: endpoint,
    });
  }

  if (!apiKey) {
    checks.push({
      code: "api_key_missing",
      level: "error",
      message: "API key is not configured.",
      hint: "Paste the resource API key into the API key field, or set AZURE_FOUNDRY_API_KEY in the server env.",
    });
  } else {
    checks.push({
      code: "api_key_present",
      level: "info",
      message: "API key configured",
      detail: `key length ${apiKey.length}`,
    });
  }

  // Live reachability + deployment list (only if endpoint+key look usable).
  let availableDeployments: string[] = [];
  if (endpoint && apiKey && /^https?:\/\//i.test(endpoint)) {
    const url = `${endpoint}${OPENAI_V1_PATH}/models`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, {
        method: "GET",
        headers: { "api-key": apiKey, accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        availableDeployments = (body.data ?? []).map((m) => m.id);
        checks.push({
          code: "endpoint_reachable",
          level: "info",
          message: `Foundry reachable — ${availableDeployments.length} deployment${availableDeployments.length === 1 ? "" : "s"} discovered.`,
          detail: availableDeployments.slice(0, 8).join(", ") || null,
        });
      } else if (res.status === 401 || res.status === 403) {
        checks.push({
          code: "auth_failed",
          level: "error",
          message: `Authentication failed — HTTP ${res.status} from /openai/v1/models`,
          hint: "Verify the API key matches the resource (Azure portal → Keys and Endpoint).",
        });
      } else if (res.status === 404) {
        checks.push({
          code: "endpoint_not_found",
          level: "error",
          message: `Endpoint returned 404 for /openai/v1/models`,
          hint: "Confirm the endpoint URL points at a Foundry/AI-services resource (not e.g. a generic Azure service).",
        });
      } else {
        const txt = await res.text().catch(() => "");
        checks.push({
          code: "http_error",
          level: "error",
          message: `Foundry returned HTTP ${res.status}`,
          detail: txt.slice(0, 200) || null,
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      checks.push({
        code: "network_error",
        level: "error",
        message: `Network error reaching Foundry`,
        detail: message,
        hint: "Check that the endpoint hostname resolves and the server can reach Azure (firewall, VPN, DNS).",
      });
    }
  }

  // Deployment validation — does the configured deployment exist on the resource?
  if (deployment) {
    if (availableDeployments.length === 0) {
      checks.push({
        code: "deployment_unverified",
        level: "warn",
        message: `Deployment "${deployment}" set but not verified (couldn't list models).`,
      });
    } else if (availableDeployments.includes(deployment)) {
      checks.push({
        code: "deployment_ok",
        level: "info",
        message: `Deployment "${deployment}" exists on the resource.`,
      });
    } else {
      checks.push({
        code: "deployment_not_found",
        level: "warn",
        message: `Deployment "${deployment}" not found in /openai/v1/models output.`,
        detail: `Available: ${availableDeployments.slice(0, 12).join(", ")}${availableDeployments.length > 12 ? "…" : ""}`,
        hint: "The /v1/models list returns a model catalog — your deployment name should still work for chat completions, but double-check the spelling on the Azure portal.",
      });
    }
  } else {
    checks.push({
      code: "deployment_missing",
      level: "warn",
      message: "Deployment not set — runs will fail without one.",
      hint: "Pick a deployment from the dropdown.",
    });
  }

  // Roll up overall status.
  let status: "pass" | "warn" | "fail" = "pass";
  for (const c of checks) {
    if (c.level === "error") {
      status = "fail";
      break;
    }
    if (c.level === "warn") status = "warn";
  }

  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
