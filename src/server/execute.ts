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
import { DEFAULT_TOOLS, dispatchToolCall, type ToolDefinition } from "./tools.js";
import { makeSandboxOptions, type SandboxOptions } from "./sandbox.js";

/**
 * Adapter execute() context — accepts both Paperclip's full shape
 * (AdapterExecutionContext from @paperclipai/adapter-utils, with config +
 * per-invocation context) and the simpler standalone shape used by our
 * unit tests (top-level prompt + templateVars).
 */
export interface ExecuteContext {
  /** Standalone form — prompt at top level. Overridden by ctx.context.prompt. */
  prompt?: string;
  config: AzureFoundryConfig & Record<string, unknown>;
  /** Paperclip per-invocation context — has prompt, taskId, taskTitle, etc. */
  context?: Record<string, unknown>;
  /** Paperclip agent metadata. */
  agent?: { id?: string; name?: string; companyId?: string };
  /** Paperclip runtime — session, taskKey. */
  runtime?: { sessionParams?: Record<string, unknown> | null; taskKey?: string | null };
  session?: AzureFoundrySessionParams | null;
  templateVars?: Record<string, string>;
  /** Workspace root for sandbox tools. Defaults to process.cwd(). */
  workspaceRoot?: string;
  /** Override the tool set surfaced to the model. */
  tools?: ToolDefinition[];
  onLog: (
    stream: "stdout" | "stderr",
    chunk: string,
  ) => Promise<void> | void;
  onSession?: (params: AzureFoundrySessionParams) => Promise<void> | void;
  signal?: AbortSignal;
}

const DEFAULT_HEARTBEAT_PROMPT = `You are an autonomous agent woken up on a scheduled heartbeat.

You have shell, file, and search tools to inspect the workspace. If there's a
task assigned to you (look for taskId / taskTitle / taskBody in your context),
work on it. Otherwise, look for unassigned issues to claim, or report idle.

When done, summarize what you accomplished in plain text.`;

function asStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function buildPrompt(ctx: ExecuteContext): string {
  // Highest priority: explicit prompt in ctx.context (Paperclip's invocation prompt).
  const ctxPrompt = asStr(ctx.context?.prompt);
  if (ctxPrompt) return ctxPrompt;

  // Standalone test path.
  if (asStr(ctx.prompt)) return ctx.prompt!;

  // Build from task fields if present.
  const taskId = asStr(ctx.context?.taskId);
  const taskTitle = asStr(ctx.context?.taskTitle);
  const taskBody = asStr(ctx.context?.taskBody);
  if (taskId || taskTitle || taskBody) {
    return [
      `You have a task assigned to you.`,
      taskId ? `Task ID: ${taskId}` : "",
      taskTitle ? `Title: ${taskTitle}` : "",
      taskBody ? `\n${taskBody}` : "",
      `\nWork on the task using your tools, then summarize what you did.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Fallback heartbeat prompt.
  return DEFAULT_HEARTBEAT_PROMPT;
}

function buildTemplateVars(ctx: ExecuteContext): Record<string, string> {
  const out: Record<string, string> = { ...(ctx.templateVars ?? {}) };
  const cContext = ctx.context ?? {};
  const stringFields = [
    "agentId",
    "agentName",
    "companyId",
    "companyName",
    "runId",
    "taskId",
    "taskTitle",
    "taskBody",
    "projectName",
  ];
  for (const k of stringFields) {
    const v = asStr(cContext[k]);
    if (v) out[k] = v;
  }
  // Paperclip also exposes agent and runtime separately.
  if (ctx.agent?.name && !out.agentName) out.agentName = ctx.agent.name;
  if (ctx.agent?.id && !out.agentId) out.agentId = ctx.agent.id;
  if (ctx.agent?.companyId && !out.companyId) out.companyId = ctx.agent.companyId;
  return out;
}

export interface ExecuteResult {
  exitCode: number;
  finishReason: string;
  outputText: string;
  usage: { input: number; output: number };
  toolHops: number;
}

const PREFIX = "AF::";
const DEFAULT_MAX_TOOL_HOPS = 8;
/** Per-tool-result body soft-cap kept in conversation memory after this hop. */
const TOOL_RESULT_HISTORY_BUDGET = 1500;
/** How many of the most-recent tool-result messages stay un-truncated. */
const TOOL_RESULT_RECENT_KEEP = 2;
/** 429 retry policy. */
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BASE_MS = 1500;

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

function expandTemplate(text: string | undefined | null, vars: Record<string, string>): string {
  if (typeof text !== "string" || text.length === 0) return "";
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

/** Tool call accumulator across streamed deltas. */
interface PartialToolCall {
  id: string;
  name: string;
  argumentsRaw: string;
}

interface TurnResult {
  finishReason: string;
  contentDelta: string;
  toolCalls: PartialToolCall[];
  inputTokens: number;
  outputTokens: number;
}

async function postWithRateLimitRetry(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  ctrl: AbortController,
  onLog: (msg: string) => Promise<void> | void,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
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
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : RATE_LIMIT_BASE_MS * Math.pow(2, attempt);
    await onLog(
      `Foundry 429 — backing off ${delayMs}ms (attempt ${attempt + 1}/${RATE_LIMIT_RETRIES})`,
    );
    // Drain body to free socket.
    await res.text().catch(() => "");
    await new Promise<void>((r) => setTimeout(r, delayMs));
    attempt++;
  }
}

async function runStreamingTurn(
  ctx: ExecuteContext,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  ctrl: AbortController,
): Promise<TurnResult> {
  const res = await postWithRateLimitRetry(
    url,
    apiKey,
    body,
    ctrl,
    (msg) => emitLog(ctx, msg),
  );

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Foundry HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let contentDelta = "";
  let finishReason = "unknown";
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCallsByIndex = new Map<number, PartialToolCall>();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const rawLine = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!rawLine || !rawLine.startsWith("data:")) continue;
      const data = rawLine.slice("data:".length).trim();
      if (data === "[DONE]") {
        if (finishReason === "unknown") finishReason = "stop";
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
        contentDelta += delta.content;
        await emit(ctx, { kind: "token", text: delta.content });
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const slot = toolCallsByIndex.get(tc.index) ?? {
            id: "",
            name: "",
            argumentsRaw: "",
          };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.argumentsRaw += tc.function.arguments;
          toolCallsByIndex.set(tc.index, slot);
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

  // Materialize tool calls in index order.
  const toolCalls = Array.from(toolCallsByIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((tc) => tc.name.length > 0);

  return { finishReason, contentDelta, toolCalls, inputTokens, outputTokens };
}

/**
 * Streaming agent loop:
 *   send messages → stream → if tool_calls: execute, append, repeat → else stop.
 */
export async function execute(ctx: ExecuteContext): Promise<ExecuteResult> {
  const cfg = ctx.config;

  const endpoint = (cfg.endpoint ?? process.env.AZURE_FOUNDRY_ENDPOINT ?? "")
    .toString()
    .trim()
    .replace(/\/+$/, "");
  if (!endpoint) {
    await emit(ctx, { kind: "error", message: "AZURE_FOUNDRY_ENDPOINT not configured" });
    return { exitCode: 2, finishReason: "config_error", outputText: "", usage: { input: 0, output: 0 }, toolHops: 0 };
  }

  const apiKey = resolveApiKey(cfg);
  if (!apiKey) {
    await emit(ctx, { kind: "error", message: "AZURE_FOUNDRY_API_KEY not configured" });
    return { exitCode: 2, finishReason: "config_error", outputText: "", usage: { input: 0, output: 0 }, toolHops: 0 };
  }

  const deployment = (cfg.deployment ?? DEFAULT_DEPLOYMENT).toString().trim();
  const apiVersion = (cfg.apiVersion ?? DEFAULT_API_VERSION).toString().trim();
  const timeoutMs = (cfg.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const _graceMs = (cfg.graceSec ?? DEFAULT_GRACE_SEC) * 1000;
  const enableToolLoop = cfg.enableToolLoop !== false; // default true now that M2 is here
  const maxToolHops =
    typeof cfg.maxToolHops === "number" && cfg.maxToolHops > 0
      ? cfg.maxToolHops
      : DEFAULT_MAX_TOOL_HOPS;

  await emitLog(
    ctx,
    `Foundry run: deployment=${deployment} toolLoop=${enableToolLoop} maxHops=${maxToolHops} endpoint=${endpoint}`,
  );

  const useLegacy = apiVersion !== DEFAULT_API_VERSION && apiVersion !== "";
  const url = useLegacy
    ? `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`
    : `${endpoint}${OPENAI_V1_PATH}/chat/completions`;

  const vars = buildTemplateVars(ctx);
  const rawPrompt = buildPrompt(ctx);
  const systemContent = await loadInstructions(cfg, vars);
  const userContent = expandTemplate(rawPrompt, vars);

  const messages: ChatMessage[] = [];
  if (systemContent) messages.push({ role: "system", content: systemContent });
  messages.push({ role: "user", content: userContent });

  const sandboxOpts: SandboxOptions = makeSandboxOptions({
    rootDir: ctx.workspaceRoot ?? process.cwd(),
  });
  const tools = ctx.tools ?? DEFAULT_TOOLS;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (ctx.signal) {
    ctx.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  let finalText = "";
  let totalInput = 0;
  let totalOutput = 0;
  let finishReason = "unknown";
  let toolHops = 0;

  try {
    for (let hop = 0; hop <= maxToolHops; hop++) {
      const body: Record<string, unknown> = {
        model: deployment,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
      if (cfg.maxOutputTokens !== undefined) body.max_completion_tokens = cfg.maxOutputTokens;
      if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
      if (enableToolLoop) body.tools = tools;

      const turn = await runStreamingTurn(ctx, url, apiKey, body, ctrl);
      totalInput += turn.inputTokens;
      totalOutput += turn.outputTokens;
      if (turn.contentDelta) finalText += turn.contentDelta;
      finishReason = turn.finishReason;

      // No tool calls — we're done.
      if (turn.toolCalls.length === 0) {
        break;
      }

      // Tool loop disabled — surface and stop.
      if (!enableToolLoop) {
        for (const tc of turn.toolCalls) {
          await emit(ctx, {
            kind: "tool_call",
            id: tc.id,
            name: tc.name,
            arguments: tc.argumentsRaw,
          });
        }
        break;
      }

      // Hop budget exhausted.
      if (hop === maxToolHops) {
        await emit(ctx, {
          kind: "error",
          message: `tool hop budget exhausted (${maxToolHops})`,
        });
        finishReason = "hop_budget_exhausted";
        break;
      }

      // Truncate older tool-result message bodies to keep context bounded.
      // Keep the N most-recent intact; squash everything older to a one-line summary.
      const toolResultIdx: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === "tool") toolResultIdx.push(i);
      }
      const truncateBefore = toolResultIdx.length - TOOL_RESULT_RECENT_KEEP;
      for (let k = 0; k < truncateBefore; k++) {
        const i = toolResultIdx[k];
        const m = messages[i];
        const content = typeof m.content === "string" ? m.content : "";
        if (content.length > TOOL_RESULT_HISTORY_BUDGET) {
          messages[i] = {
            ...m,
            content:
              content.slice(0, TOOL_RESULT_HISTORY_BUDGET) +
              `\n…[truncated ${content.length - TOOL_RESULT_HISTORY_BUDGET} chars from older tool result]`,
          };
        }
      }

      // Execute tool calls and append messages.
      const assistantToolMessage: ChatMessage = {
        role: "assistant",
        content: turn.contentDelta || null,
        tool_calls: turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.argumentsRaw },
        })),
      };
      messages.push(assistantToolMessage);

      for (const tc of turn.toolCalls) {
        await emit(ctx, {
          kind: "tool_call",
          id: tc.id,
          name: tc.name,
          arguments: tc.argumentsRaw,
        });

        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = tc.argumentsRaw ? JSON.parse(tc.argumentsRaw) : {};
        } catch (err) {
          parsedArgs = {};
          await emit(ctx, {
            kind: "log",
            level: "warn",
            message: `bad JSON in tool args for ${tc.name}: ${(err as Error).message}`,
          });
        }

        const dispatched = await dispatchToolCall(tc.name, parsedArgs, sandboxOpts);
        const resultPayload = dispatched.ok
          ? dispatched.result
          : { error: dispatched.errorMessage ?? "unknown error" };
        const resultJson = JSON.stringify(resultPayload);

        await emit(ctx, {
          kind: "tool_result",
          id: tc.id,
          content: resultJson.length > 2000 ? resultJson.slice(0, 2000) + "…[truncated]" : resultJson,
        });

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultJson,
        });
      }
      toolHops++;
    }

    await emit(ctx, { kind: "usage", input: totalInput, output: totalOutput });
    await emit(ctx, { kind: "finish", reason: finishReason });

    if (ctx.onSession) {
      const conversationId =
        ctx.session?.conversationId ??
        `af-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await ctx.onSession({
        conversationId,
        totalInputTokens: (ctx.session?.totalInputTokens ?? 0) + totalInput,
        totalOutputTokens: (ctx.session?.totalOutputTokens ?? 0) + totalOutput,
      });
    }

    const ok = finishReason === "stop" || finishReason === "tool_calls";
    return {
      exitCode: ok ? 0 : 1,
      finishReason,
      outputText: finalText,
      usage: { input: totalInput, output: totalOutput },
      toolHops,
    };
  } catch (err) {
    await emit(ctx, { kind: "error", message: (err as Error).message });
    return {
      exitCode: 1,
      finishReason: "exception",
      outputText: finalText,
      usage: { input: totalInput, output: totalOutput },
      toolHops,
    };
  } finally {
    clearTimeout(timer);
  }
}
