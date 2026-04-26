/**
 * Standalone sandbox tool implementations.
 *
 * These are intentionally minimal so the package stays self-contained for
 * testing. When integrated with Paperclip, adapter-utils provides richer
 * sandbox primitives (workspace-rooted paths, run_id-tagged shell, etc.) —
 * the dispatch layer in tools.ts can be swapped to delegate there.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface SandboxOptions {
  /** Absolute root the sandbox is rooted at — paths outside are rejected. */
  rootDir: string;
  /** Per-tool execution timeout in ms. */
  toolTimeoutMs: number;
  /** Max bytes of stdout/stderr returned per shell call. */
  shellOutputLimit: number;
  /** Max bytes returned per file read. */
  fileReadLimit: number;
}

const DEFAULTS: SandboxOptions = {
  rootDir: process.cwd(),
  toolTimeoutMs: 60_000,
  shellOutputLimit: 64 * 1024,
  fileReadLimit: 256 * 1024,
};

export function makeSandboxOptions(
  partial?: Partial<SandboxOptions>,
): SandboxOptions {
  return { ...DEFAULTS, ...(partial ?? {}) };
}

function resolveSafe(root: string, p: string): string {
  if (typeof p !== "string" || !p.length) {
    throw new Error("path must be a non-empty string");
  }
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const normalizedRoot = path.resolve(root);
  if (!abs.startsWith(normalizedRoot + path.sep) && abs !== normalizedRoot) {
    throw new Error(`path escapes sandbox root: ${p}`);
  }
  return abs;
}

export async function readFile(
  args: { path: string },
  opts: SandboxOptions,
): Promise<{ path: string; content: string; truncated: boolean; bytes: number }> {
  const abs = resolveSafe(opts.rootDir, args.path);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`not a file: ${args.path}`);
  const buf = await fs.readFile(abs);
  const truncated = buf.byteLength > opts.fileReadLimit;
  const slice = truncated ? buf.subarray(0, opts.fileReadLimit) : buf;
  return {
    path: path.relative(opts.rootDir, abs) || ".",
    content: slice.toString("utf8"),
    truncated,
    bytes: stat.size,
  };
}

export async function writeFile(
  args: { path: string; content: string; createParents?: boolean },
  opts: SandboxOptions,
): Promise<{ path: string; bytesWritten: number }> {
  const abs = resolveSafe(opts.rootDir, args.path);
  if (args.createParents) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
  }
  const data = String(args.content ?? "");
  await fs.writeFile(abs, data, "utf8");
  return {
    path: path.relative(opts.rootDir, abs) || ".",
    bytesWritten: Buffer.byteLength(data, "utf8"),
  };
}

export async function listDirectory(
  args: { path?: string },
  opts: SandboxOptions,
): Promise<{ path: string; entries: Array<{ name: string; type: "file" | "dir" | "other" }> }> {
  const target = args.path ?? ".";
  const abs = resolveSafe(opts.rootDir, target);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries = dirents.map((d) => ({
    name: d.name,
    type: d.isFile() ? ("file" as const) : d.isDirectory() ? ("dir" as const) : ("other" as const),
  }));
  return { path: path.relative(opts.rootDir, abs) || ".", entries };
}

export async function runShell(
  args: { command: string; cwd?: string },
  opts: SandboxOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
  if (typeof args.command !== "string" || !args.command.trim()) {
    throw new Error("command required");
  }
  const cwd = args.cwd ? resolveSafe(opts.rootDir, args.cwd) : opts.rootDir;

  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", args.command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: { kind: "out" | "err"; buf: Buffer }[] = [];
    let totalSize = 0;
    let truncated = false;

    const handleChunk = (kind: "out" | "err") => (buf: Buffer) => {
      if (totalSize >= opts.shellOutputLimit) {
        truncated = true;
        return;
      }
      const remaining = opts.shellOutputLimit - totalSize;
      const slice = buf.byteLength > remaining ? buf.subarray(0, remaining) : buf;
      chunks.push({ kind, buf: slice });
      totalSize += slice.byteLength;
      if (totalSize >= opts.shellOutputLimit) truncated = true;
    };

    child.stdout.on("data", handleChunk("out"));
    child.stderr.on("data", handleChunk("err"));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, opts.toolTimeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks.filter((c) => c.kind === "out").map((c) => c.buf)).toString("utf8");
      const stderr = Buffer.concat(chunks.filter((c) => c.kind === "err").map((c) => c.buf)).toString("utf8");
      resolve({ stdout, stderr, exitCode: code ?? -1, truncated });
    });
  });
}

export async function searchGrep(
  args: { pattern: string; path?: string },
  opts: SandboxOptions,
): Promise<{ matches: Array<{ file: string; line: number; text: string }>; truncated: boolean }> {
  if (typeof args.pattern !== "string" || !args.pattern.length) {
    throw new Error("pattern required");
  }
  // Delegate to grep — fast, well-tested. Path defaults to root.
  const target = args.path ?? ".";
  const abs = resolveSafe(opts.rootDir, target);
  const command = `grep -RIn --color=never -e ${JSON.stringify(args.pattern)} ${JSON.stringify(abs)} 2>/dev/null | head -n 200`;
  const { stdout, truncated } = await runShell({ command }, opts);
  const matches = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) return null;
      return { file: path.relative(opts.rootDir, m[1]) || m[1], line: Number(m[2]), text: m[3] };
    })
    .filter((x): x is { file: string; line: number; text: string } => x !== null);
  return { matches, truncated };
}
