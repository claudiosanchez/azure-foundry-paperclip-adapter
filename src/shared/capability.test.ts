import { describe, it, expect } from "vitest";
import { getApiSurface, KNOWN_API_SURFACE } from "./capability.js";

describe("getApiSurface", () => {
  it("routes known chat-completable deployments to chat", () => {
    expect(getApiSurface("gpt-5-5")).toBe("chat");
    expect(getApiSurface("gpt-5-4-mini")).toBe("chat");
    expect(getApiSurface("gpt-5-4-nano")).toBe("chat");
  });

  it("routes known responses-only deployments to responses", () => {
    expect(getApiSurface("gpt-5-4-pro")).toBe("responses");
    expect(getApiSurface("gpt-5-3-codex")).toBe("responses");
    expect(getApiSurface("gpt-5-pro")).toBe("responses");
  });

  it("defaults to chat for unknown deployments", () => {
    expect(getApiSurface("some-future-deployment")).toBe("chat");
    expect(getApiSurface("")).toBe("chat");
  });

  it("honours explicit override over the table", () => {
    expect(getApiSurface("gpt-5-5", "responses")).toBe("responses");
    expect(getApiSurface("gpt-5-4-pro", "chat")).toBe("chat");
  });

  it("ignores garbage override values and falls back to the table", () => {
    expect(getApiSurface("gpt-5-5", "garbage" as unknown as "chat")).toBe("chat");
    expect(getApiSurface("gpt-5-4-pro", null)).toBe("responses");
    expect(getApiSurface("gpt-5-4-pro", undefined)).toBe("responses");
  });

  it("documents the full known table", () => {
    // Snapshot-style assertion — if the table changes, update this test
    // intentionally so the change is visible in PRs.
    expect(KNOWN_API_SURFACE).toEqual({
      "gpt-5-5": "chat",
      "gpt-5-4-mini": "chat",
      "gpt-5-4-nano": "chat",
      "gpt-5-4-pro": "responses",
      "gpt-5-3-codex": "responses",
      "gpt-5-pro": "responses",
    });
  });
});
