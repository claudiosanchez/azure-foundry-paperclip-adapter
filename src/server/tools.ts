/**
 * Tool definitions surfaced to the model + dispatch layer.
 *
 * The schemas are passed to Foundry as the `tools` parameter; the dispatcher
 * routes tool_calls back to the sandbox implementations.
 */
import {
  listDirectory,
  readFile,
  runShell,
  searchGrep,
  writeFile,
  type SandboxOptions,
} from "./sandbox.js";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const DEFAULT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a UTF-8 text file inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file (relative to workspace root, or absolute inside it).",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a UTF-8 text file inside the workspace, replacing any existing contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
          content: { type: "string", description: "File contents." },
          createParents: { type: "boolean", description: "Create missing parent directories.", default: false },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the contents of a directory inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path. Defaults to workspace root." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a shell command inside the workspace. Returns stdout, stderr, exit code. Has a timeout and output cap.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
          cwd: { type: "string", description: "Optional working directory inside the workspace." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_grep",
      description: "Recursive text search across the workspace using grep.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Pattern to search for (passed to grep -e)." },
          path: { type: "string", description: "Subdirectory to search. Defaults to workspace root." },
        },
        required: ["pattern"],
      },
    },
  },
];

export interface ToolDispatchResult {
  ok: boolean;
  result: unknown;
  errorMessage?: string;
}

export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  opts: SandboxOptions,
): Promise<ToolDispatchResult> {
  try {
    switch (name) {
      case "read_file":
        return { ok: true, result: await readFile(args as { path: string }, opts) };
      case "write_file":
        return {
          ok: true,
          result: await writeFile(
            args as { path: string; content: string; createParents?: boolean },
            opts,
          ),
        };
      case "list_directory":
        return { ok: true, result: await listDirectory(args as { path?: string }, opts) };
      case "run_shell":
        return { ok: true, result: await runShell(args as { command: string; cwd?: string }, opts) };
      case "search_grep":
        return { ok: true, result: await searchGrep(args as { pattern: string; path?: string }, opts) };
      default:
        return { ok: false, result: null, errorMessage: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, result: null, errorMessage: (err as Error).message };
  }
}
