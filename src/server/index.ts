/**
 * Server-side adapter module exports.
 */
import { ADAPTER_TYPE, ADAPTER_LABEL } from "../shared/constants.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { detectModel } from "./detect-model.js";
import { listSkills, syncSkills } from "./skills.js";
import { models, agentConfigurationDoc } from "../index.js";

export { execute, testEnvironment, detectModel, listSkills, syncSkills };

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Plugin-loader entry point.
 *
 * Paperclip's external-adapter plugin loader calls `createServerAdapter()`
 * from the package root after install. We return a `ServerAdapterModule`
 * shape (duck-typed against @paperclipai/adapter-utils so the package
 * still compiles standalone).
 */
export function createServerAdapter() {
  return {
    type: ADAPTER_TYPE,
    label: ADAPTER_LABEL,
    execute,
    testEnvironment,
    sessionCodec,
    listSkills,
    syncSkills,
    models,
    supportsLocalAgentJwt: false,
    agentConfigurationDoc,
    detectModel: async () => {
      const d = detectModel();
      return { model: d.model, provider: "azure_foundry", source: d.source };
    },
  };
}

/**
 * Session codec — Paperclip persists this between heartbeats so the same
 * conversation can continue across runs.
 *
 * Foundry chat completions are stateless; we only need a stable conversationId
 * for log grouping plus running token totals. The full message history is
 * reconstructed from Paperclip's run/event store on each heartbeat.
 */
export const sessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const conversationId =
      readNonEmptyString(record.conversationId) ??
      readNonEmptyString(record.conversation_id);
    if (!conversationId) return null;
    return {
      conversationId,
      totalInputTokens:
        typeof record.totalInputTokens === "number" ? record.totalInputTokens : 0,
      totalOutputTokens:
        typeof record.totalOutputTokens === "number" ? record.totalOutputTokens : 0,
    };
  },
  serialize(params: unknown) {
    if (!params || typeof params !== "object") return null;
    const p = params as Record<string, unknown>;
    const conversationId =
      readNonEmptyString(p.conversationId) ??
      readNonEmptyString(p.conversation_id);
    if (!conversationId) return null;
    return {
      conversationId,
      totalInputTokens: typeof p.totalInputTokens === "number" ? p.totalInputTokens : 0,
      totalOutputTokens: typeof p.totalOutputTokens === "number" ? p.totalOutputTokens : 0,
    };
  },
  getDisplayId(params: unknown) {
    if (!params || typeof params !== "object") return null;
    const p = params as Record<string, unknown>;
    return (
      readNonEmptyString(p.conversationId) ??
      readNonEmptyString(p.conversation_id)
    );
  },
};
