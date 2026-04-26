import { promises as fs } from "node:fs";
import {
  DEFAULT_API_VERSION,
  DEFAULT_DEPLOYMENT,
  DEFAULT_GRACE_SEC,
  DEFAULT_TIMEOUT_SEC,
  OPENAI_V1_PATH,
} from "../shared/constants.js";
import type {
  AzureFoundryConfig,
  AzureFoundrySessionParams,
  ChatMessage,
} from "../shared/types.js";

/**
 * Minimal subset of the adapter execute() context that we use. The full
 * shape is defined by @paperclipai/adapter-utils — this duck-types just
 * what we need so the package compiles standalone, and the real type can
 * be tightened once we depend on adapter-utils for real.
 */
export interface ExecuteContext {
  prompt: string;
  config: AzureFoundryConfig & Record<string, unknown>;
  session?: AzureFoundrySessionParams | null;
  templateVars?: Record<string, string>;
  onLog: (
    stream: "stdout" | "stderr",
    chunk: string,
  ) => Promise<void> | void;
  onSession?: (params: AzureFoundrySessionParams) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface ExecuteResult {
  exitCode: number;
  finishReason: string;
  outputText: string;
  usage: { input: number; output: number };
}

const PREFIX = "AF::";

function emit(
  ctx: ExecuteContext,
  event: Record<string, unknown>,
): Promise<void> | void {
  return ctx.onLog("stdout", `${PREFIX}${JSON.stringify(event)}\n`);
}

function emitLog(ctx: ExecuteContext, msg: string) {
  return ctx.onLog("stdout", `[azure_foundry] ${msg}\n`);
}

function resolveApiKey(cfg: AzureFoundryConfig): string {
  const k = cfg.apiKey;
  if (typeof k === "string") return k;
  if (k && typeof k === "object" && "value" in k) return (k as { value: string }).value;
  return process.env.AZURE_FOUNDRY_API_KEY?.trim() ?? "";
}

function expandTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return typeof v === "string" ? v : "";
  });
}

async function loadInstructions(
  cfg: AzureFoundryConfig,
  vars: Record<string, string>,
): Promise<string | null> {
  if (!cfg.instructionsFilePath) return null;
  try {
    const raw = await fs.readFile(cfg.instructionsFilePath, "utf8");
    return expandTemplate(raw, vars);
  } catch (err) {
    return `[failed to read instructions: ${(err as Error).message}]`;
  }
}

/**
 * MVP execute: one round-trip Foundry chat.completions call with streaming.
 * Tool calls are surfaced as events but not executed yet — that's milestone 2.
 */
export async function execute(ctx: ExecuteContext): Promise<ExecuteResult> {
  const cfg = ctx.config;

  const endpoint = (cfg.endpoint ?? process.env.AZURE_FOUNDRY_ENDPOINT ?? "")
    .toString()
    .trim()
    .replace(/\/+$/, "");
  if (!endpoint) {
    await emit(ctx, { kind: "error", message: "AZURE_FOUNDRY_ENDPOINT not configured" });
    return { exitCode: 2, finishReason: "config_error", outputText: "", usage: { input: 0, output: 0 } };
  }

  const apiKey = resolveApiKey(cfg);
  if (!apiKey) {
    await emit(ctx, { kind: "error", message: "AZURE_FOUNDRY_API_KEY not configured" });
    return { exitCode: 2, finishReason: "config_error", outputText: "", usage: { input: 0, output: 0 } };
  }

  const deployment = (cfg.deployment ?? DEFAULT_DEPLOYMENT).toString().trim();
  const apiVersion = (cfg.apiVersion ?? DEFAULT_API_VERSION).toString().trim();
  const timeoutMs = (cfg.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const _graceMs = (cfg.graceSec ?? DEFAULT_GRACE_SEC) * 1000;

  await emitLog(
    ctx,
    `Starting Foundry run: deployment=${deployment} apiVersion=${apiVersion} endpoint=${endpoint}`,
  );

  const vars = ctx.templateVars ?? {};
  const systemContent = await loadInstructions(cfg, vars);
  const userContent = expandTemplate(ctx.prompt, vars);

  const messages: ChatMessage[] = [];
  if (systemContent) messages.push({ role: "system", content: systemContent });
  messages.push({ role: "user", content: userContent });

  const url = `${endpoint}${OPENAI_V1_PATH}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const body: Record<string, unknown> = {
    model: deployment,
    messages,
    stream: true,
  };
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
  if (cfg.maxOutputTokens !== undefined) body.max_completion_tokens = cfg.maxOutputTokens;
  if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (ctx.signal) {
    ctx.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  let outputText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = "unknown";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      await emit(ctx, {
        kind: "error",
        message: `Foundry HTTP ${res.status}: ${text.slice(0, 500)}`,
      });
      return {
        exitCode: 1,
        finishReason: "http_error",
        outputText: "",
        usage: { input: 0, output: 0 },
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on SSE event boundaries.
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!rawLine || !rawLine.startsWith("data:")) continue;
        const data = rawLine.slice("data:".length).trim();
        if (data === "[DONE]") {
          finishReason = finishReason === "unknown" ? "stop" : finishReason;
          continue;
        }

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          outputText += delta.content;
          await emit(ctx, { kind: "token", text: delta.content });
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            await emit(ctx, {
              kind: "tool_call",
              id: tc.id ?? `idx-${tc.index}`,
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            });
          }
        }
        const fr = chunk.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }
      }
    }

    await emit(ctx, { kind: "usage", input: inputTokens, output: outputTokens });
    await emit(ctx, { kind: "finish", reason: finishReason });

    if (ctx.onSession) {
      const conversationId =
        ctx.session?.conversationId ??
        `af-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await ctx.onSession({
        conversationId,
        totalInputTokens: (ctx.session?.totalInputTokens ?? 0) + inputTokens,
        totalOutputTokens: (ctx.session?.totalOutputTokens ?? 0) + outputTokens,
      });
    }

    return {
      exitCode: finishReason === "stop" || finishReason === "tool_calls" ? 0 : 1,
      finishReason,
      outputText,
      usage: { input: inputTokens, output: outputTokens },
    };
  } catch (err) {
    await emit(ctx, { kind: "error", message: (err as Error).message });
    return {
      exitCode: 1,
      finishReason: "exception",
      outputText,
      usage: { input: inputTokens, output: outputTokens },
    };
  } finally {
    clearTimeout(timer);
  }
}
