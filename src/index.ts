/**
 * Azure AI Foundry adapter for Paperclip.
 *
 * Runs Azure AI Foundry deployments (Azure-hosted OpenAI/codex/embeddings/audio/image
 * models) as managed employees in a Paperclip company, talking directly to the
 * Foundry endpoint over HTTPS — no CLI subprocess.
 *
 * @packageDocumentation
 */
import { ADAPTER_TYPE, ADAPTER_LABEL } from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

// Re-export the plugin-loader factory so `await import(packageName)` works.
export { createServerAdapter } from "./server/index.js";

/**
 * Suggested deployments — chat-completion-capable Foundry models only.
 *
 * IMPORTANT: Some Foundry deployments are served exclusively through Azure's
 * Responses API (`/openai/v1/responses`) and do NOT support chat completions:
 *
 *   gpt-5-4-pro    (capabilities.chat_completion: false — pro reasoning)
 *   gpt-5-3-codex  (capabilities.chat_completion: false — codex/responses-only)
 *   gpt-5-pro      (capabilities.chat_completion: false)
 *
 * Selecting one of those would silently break agents (HTTP 400 "operation is
 * unsupported"). Until this adapter grows a Responses-API branch, only
 * chat-completable deployments are surfaced here.
 *
 * Embeddings/audio/image/realtime models live in a separate plugin
 * (paperclip-plugin-foundry-tools, planned).
 */
export const models = [
  { id: "gpt-5-5", label: "gpt-5-5 (chat — flagship)" },
  { id: "gpt-5-4-mini", label: "gpt-5-4-mini (chat — high-volume)" },
  { id: "gpt-5-4-nano", label: "gpt-5-4-nano (chat — triage)" },
];

/**
 * Documentation shown in the Paperclip UI when configuring an Azure Foundry agent.
 */
export const agentConfigurationDoc = `# Azure AI Foundry Configuration

This adapter calls Azure AI Foundry directly over HTTPS — no CLI subprocess
required. It supports any chat-capable deployment in your Foundry resource.

## Prerequisites

- An Azure AI Foundry resource provisioned (e.g. \`foundry-coxshire-eastus2\`)
- One or more chat deployments (gpt-5.x family, codex, etc.)
- An API key from the resource (Azure portal → Keys and Endpoint)

## Core Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| endpoint | string | (env: AZURE_FOUNDRY_ENDPOINT) | Foundry resource base URL, e.g. https://foundry-coxshire-eastus2.cognitiveservices.azure.com/ |
| apiKey | string \\| secret-ref | (env: AZURE_FOUNDRY_API_KEY) | Resource API key |
| deployment | string | gpt-5-5 | Deployment name (matches Azure-side spelling exactly) |
| apiVersion | string | 2024-10-21 | Foundry API version |

## Generation Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| reasoningEffort | string | (none) | minimal \\| low \\| medium \\| high \\| xhigh — passed to deployments that support it |
| temperature | number | (model default) | Sampling temperature |
| maxOutputTokens | number | (model default) | Hard cap on output tokens |

## Behavior

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| enableToolLoop | boolean | false | When true, executes tool_calls against Paperclip's sandbox in a loop until the model returns final content. When false (MVP default), tool calls are logged and the run terminates after one round-trip. |
| timeoutSec | number | 300 | Run timeout |
| graceSec | number | 10 | SIGTERM grace period |
| instructionsFilePath | string | (none) | Absolute path to a markdown file injected as the system prompt |

## Available Template Variables

The instructions file (and prompt body) supports these placeholders:

- \`{{agentId}}\` — Paperclip agent ID
- \`{{agentName}}\` — Agent display name
- \`{{companyId}}\` — Paperclip company ID
- \`{{companyName}}\` — Company display name
- \`{{runId}}\` — Current heartbeat run ID
- \`{{taskId}}\` — Current task/issue ID (if assigned)
- \`{{taskTitle}}\` — Task title (if assigned)
- \`{{taskBody}}\` — Task description (if assigned)
- \`{{projectName}}\` — Project name (if scoped to a project)
`;
