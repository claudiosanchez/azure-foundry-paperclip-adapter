/** Adapter type identifier registered with Paperclip. */
export const ADAPTER_TYPE = "azure_foundry";

/** Human-readable label shown in the Paperclip UI. */
export const ADAPTER_LABEL = "Azure AI Foundry";

/** Default timeout for a single execution run (seconds). */
export const DEFAULT_TIMEOUT_SEC = 300;

/** Grace period after SIGTERM before SIGKILL (seconds). */
export const DEFAULT_GRACE_SEC = 10;

/** Default Foundry deployment to use if none specified. */
export const DEFAULT_DEPLOYMENT = "gpt-5-5";

/** Default Foundry API version. */
export const DEFAULT_API_VERSION = "2024-10-21";

/** Default OpenAI-compatible v1 path suffix on the Foundry endpoint. */
export const OPENAI_V1_PATH = "/openai/v1";
