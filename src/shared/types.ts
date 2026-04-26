/**
 * Adapter configuration shape persisted on a Paperclip agent record under
 * `adapterConfig` for adapterType `azure_foundry`.
 */
export interface AzureFoundryConfig {
  /** Foundry resource endpoint, e.g. "https://foundry-coxshire-eastus2.cognitiveservices.azure.com/". */
  endpoint?: string;

  /** Deployment name (Azure-side), e.g. "gpt-5-5", "gpt-5-3-codex". */
  deployment?: string;

  /** Optional API version override. Defaults to DEFAULT_API_VERSION. */
  apiVersion?: string;

  /** API key for the resource. Stored as Paperclip secret reference or plain. */
  apiKey?: string | { type: "plain" | "ref"; value: string };

  /** Optional reasoning effort hint passed via `reasoning_effort` if supported. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";

  /** Sampling temperature. */
  temperature?: number;

  /** Max output tokens. */
  maxOutputTokens?: number;

  /** Absolute path to a markdown instructions file (system prompt). */
  instructionsFilePath?: string;

  /** Run timeout (seconds). */
  timeoutSec?: number;

  /** SIGTERM grace period (seconds). */
  graceSec?: number;

  /**
   * Toggle: when true (default since M2), the adapter executes tool_calls
   * returned by Foundry against the standalone sandbox and loops until the
   * model returns a tool-call-free response. When false, tool calls are
   * surfaced as events and the run terminates after one round-trip.
   */
  enableToolLoop?: boolean;

  /**
   * Maximum tool-call rounds before the loop bails out. Defaults to 8.
   */
  maxToolHops?: number;
}

/** Session params persisted between heartbeats. */
export interface AzureFoundrySessionParams {
  /** Conversation ID we mint per run for log grouping. */
  conversationId: string;

  /** Total tokens accumulated so far across heartbeats. */
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}
