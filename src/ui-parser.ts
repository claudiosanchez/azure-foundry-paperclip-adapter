/**
 * Browser-sandboxed UI parser for Azure Foundry adapter run logs.
 *
 * IMPORTANT: This module runs in a browser sandbox. It must have:
 *   - Zero runtime imports
 *   - No side effects on module load
 *   - No node-only APIs
 *
 * The Paperclip dashboard fetches this module at runtime and uses it to
 * convert each stdout line emitted by the server-side execute() into a
 * structured event for transcript rendering.
 */

export type AzureFoundryEvent =
  | { kind: "token"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id: string; name: string; arguments: string }
  | { kind: "tool_result"; id: string; content: string }
  | { kind: "usage"; input: number; output: number }
  | { kind: "finish"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "log"; level: "info" | "warn" | "error"; message: string };

const PREFIX = "AF::";

export function parseStdoutLine(line: string): AzureFoundryEvent | null {
  if (!line) return null;
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed.startsWith(PREFIX)) {
    return { kind: "log", level: "info", message: trimmed };
  }
  const payload = trimmed.slice(PREFIX.length);
  try {
    const obj = JSON.parse(payload) as AzureFoundryEvent;
    if (obj && typeof obj === "object" && "kind" in obj) return obj;
    return { kind: "log", level: "warn", message: `unparsed: ${payload}` };
  } catch {
    return { kind: "log", level: "warn", message: `bad-json: ${payload}` };
  }
}
