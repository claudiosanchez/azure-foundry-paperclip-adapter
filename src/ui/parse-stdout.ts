/**
 * Parse a single stdout line emitted by the server-side execute() into a
 * structured event the Paperclip dashboard can render.
 *
 * Convention: the server emits JSON-line events on stdout, prefixed with
 * the literal token "AF::" so we can distinguish them from any other noise.
 *
 *   AF::{"kind":"token","text":"Hello"}
 *   AF::{"kind":"tool_call","name":"read_file","arguments":"{\"path\":\"/x\"}"}
 *   AF::{"kind":"usage","input":120,"output":85}
 *   AF::{"kind":"finish","reason":"stop"}
 *
 * Anything not starting with "AF::" is treated as raw log output.
 */

export type AzureFoundryEvent =
  | { kind: "token"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool_call";
      id: string;
      name: string;
      arguments: string;
    }
  | { kind: "tool_result"; id: string; content: string }
  | { kind: "usage"; input: number; output: number }
  | { kind: "finish"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "log"; level: "info" | "warn" | "error"; message: string };

const PREFIX = "AF::";

export function parseAzureFoundryStdoutLine(
  line: string,
): AzureFoundryEvent | null {
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
