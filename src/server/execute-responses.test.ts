import { describe, it, expect } from "vitest";
import { mapResponsesEvent, parseResponsesSse } from "./execute-responses.js";

// ---------------------------------------------------------------------------
// SSE parser — captured fixture replayed through the parser
// ---------------------------------------------------------------------------

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

const FIXTURE_RESPONSES_STREAM = [
  // Server emits event:/data: framing with double-newline separators.
  `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_abc"}}\n\n`,
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n`,
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n`,
  `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello world"}],"id":"msg_1"}}\n\n`,
  `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_abc","usage":{"input_tokens":10,"output_tokens":3,"output_tokens_details":{"reasoning_tokens":0}}}}\n\n`,
].join("");

describe("parseResponsesSse", () => {
  it("parses a complete create→delta→done→completed sequence", async () => {
    const events: { type: string; data: unknown }[] = [];
    for await (const ev of parseResponsesSse(streamFrom(FIXTURE_RESPONSES_STREAM))) {
      events.push({ type: ev.type, data: ev.data });
    }
    const types = events.map((e) => (e.data as { type?: string }).type ?? e.type);
    expect(types).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
  });

  it("drops malformed payloads without throwing", async () => {
    const bad = `event: junk\ndata: {not-json\n\nevent: response.created\ndata: {"type":"response.created"}\n\n`;
    const events: unknown[] = [];
    for await (const ev of parseResponsesSse(streamFrom(bad))) events.push(ev);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Event mapping — make sure the dispatcher's reaction matrix is stable
// ---------------------------------------------------------------------------

describe("mapResponsesEvent", () => {
  it("maps response.completed with usage to a finishReason + usage update", async () => {
    const handler = mapResponsesEvent("response.completed");
    expect(handler).not.toBeNull();
    const update = await handler!(
      {
        type: "response.completed",
        response: {
          id: "resp_abc",
          usage: {
            input_tokens: 14,
            output_tokens: 41,
            output_tokens_details: { reasoning_tokens: 34 },
          },
        },
      },
      async () => {},
      async () => {},
    );
    expect(update?.finishReason).toBe("stop");
    expect(update?.terminate).toBe(true);
    expect(update?.usage).toEqual({ input: 14, output: 41, reasoning: 34 });
  });

  it("maps output_text.delta by calling emitToken", async () => {
    let captured = "";
    const handler = mapResponsesEvent("response.output_text.delta")!;
    await handler(
      { type: "response.output_text.delta", delta: "abc" },
      async (text) => {
        captured += text;
      },
      async () => {},
    );
    expect(captured).toBe("abc");
  });

  it("maps reasoning text deltas to emitThinking, not emitToken", async () => {
    let token = "";
    let thinking = "";
    const handler = mapResponsesEvent("response.reasoning_text.delta")!;
    await handler(
      { type: "response.reasoning_text.delta", delta: "I am thinking..." },
      async (t) => {
        token += t;
      },
      async (t) => {
        thinking += t;
      },
    );
    expect(token).toBe("");
    expect(thinking).toBe("I am thinking...");
  });

  it("maps response.failed to an error update", async () => {
    const handler = mapResponsesEvent("response.failed")!;
    const update = await handler(
      {
        type: "response.failed",
        response: { error: { code: "context_length_exceeded", message: "too big" } },
      },
      async () => {},
      async () => {},
    );
    expect(update?.error).toContain("context_length_exceeded");
    expect(update?.error).toContain("too big");
  });

  it("returns null for unrecognised event kinds", () => {
    expect(mapResponsesEvent("response.in_progress")).toBeNull();
    expect(mapResponsesEvent("unknown.future.event")).toBeNull();
  });
});
