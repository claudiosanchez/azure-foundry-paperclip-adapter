import { OPENAI_V1_PATH } from "../shared/constants.js";

export interface TestEnvironmentResult {
  ok: boolean;
  detail: string;
  deploymentsSample?: string[];
}

/**
 * Smoke-test that the configured Foundry endpoint + apiKey can list deployments.
 * Called by Paperclip when the user clicks "Test connection" in the agent
 * config dialog, and by the heartbeat preflight before the first run.
 */
export async function testEnvironment(args: {
  endpoint?: string;
  apiKey?: string;
}): Promise<TestEnvironmentResult> {
  const endpoint = (args.endpoint ?? process.env.AZURE_FOUNDRY_ENDPOINT ?? "").trim();
  const apiKey = (args.apiKey ?? process.env.AZURE_FOUNDRY_API_KEY ?? "").trim();

  if (!endpoint) return { ok: false, detail: "AZURE_FOUNDRY_ENDPOINT not set" };
  if (!apiKey) return { ok: false, detail: "AZURE_FOUNDRY_API_KEY not set" };

  const base = endpoint.replace(/\/+$/, "");
  const url = `${base}${OPENAI_V1_PATH}/models`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      method: "GET",
      headers: { "api-key": apiKey, accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return {
        ok: false,
        detail: `${res.status} ${res.statusText} from ${url}`,
      };
    }

    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = (body.data ?? []).map((m) => m.id).slice(0, 8);
    return {
      ok: true,
      detail: `Reachable. ${body.data?.length ?? 0} model entries returned.`,
      deploymentsSample: ids,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `Network error: ${(err as Error).message}`,
    };
  }
}
