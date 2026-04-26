import { describe, it, expect } from "vitest";
import { parseAzureFoundryStdoutLine } from "./parse-stdout.js";

describe("parseAzureFoundryStdoutLine", () => {
  it("parses a token event", () => {
    const ev = parseAzureFoundryStdoutLine('AF::{"kind":"token","text":"hi"}');
    expect(ev).toEqual({ kind: "token", text: "hi" });
  });

  it("parses a tool_call event", () => {
    const ev = parseAzureFoundryStdoutLine(
      'AF::{"kind":"tool_call","id":"c1","name":"read_file","arguments":"{}"}',
    );
    expect(ev).toEqual({
      kind: "tool_call",
      id: "c1",
      name: "read_file",
      arguments: "{}",
    });
  });

  it("parses usage and finish events", () => {
    expect(parseAzureFoundryStdoutLine('AF::{"kind":"usage","input":10,"output":5}')).toEqual({
      kind: "usage",
      input: 10,
      output: 5,
    });
    expect(parseAzureFoundryStdoutLine('AF::{"kind":"finish","reason":"stop"}')).toEqual({
      kind: "finish",
      reason: "stop",
    });
  });

  it("treats non-prefixed lines as raw log output", () => {
    const ev = parseAzureFoundryStdoutLine("[paperclip] starting run");
    expect(ev).toEqual({ kind: "log", level: "info", message: "[paperclip] starting run" });
  });

  it("returns null for empty input", () => {
    expect(parseAzureFoundryStdoutLine("")).toBeNull();
  });

  it("strips trailing carriage returns", () => {
    const ev = parseAzureFoundryStdoutLine('AF::{"kind":"finish","reason":"stop"}\r');
    expect(ev).toEqual({ kind: "finish", reason: "stop" });
  });

  it("recovers gracefully from malformed JSON", () => {
    const ev = parseAzureFoundryStdoutLine('AF::{not-json');
    expect(ev?.kind).toBe("log");
    expect((ev as { message: string }).message).toContain("bad-json");
  });
});
