import { describe, it, expect } from "vitest";
import { buildAzureFoundryConfig } from "./build-config.js";

describe("buildAzureFoundryConfig", () => {
  it("sets defaults when only required fields are provided", () => {
    const cfg = buildAzureFoundryConfig({});
    expect(cfg.deployment).toBe("gpt-5-5");
    expect(cfg.apiVersion).toBe("2024-10-21");
    expect(cfg.timeoutSec).toBe(300);
    expect(cfg.graceSec).toBe(10);
  });

  it("trims string fields and drops empties", () => {
    const cfg = buildAzureFoundryConfig({
      endpoint: "  https://x.example/  ",
      apiKey: "   ",
      deployment: "gpt-5-4-pro",
    });
    expect(cfg.endpoint).toBe("https://x.example/");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.deployment).toBe("gpt-5-4-pro");
  });

  it("coerces numeric strings", () => {
    const cfg = buildAzureFoundryConfig({
      temperature: "0.3",
      maxOutputTokens: "1024",
      timeoutSec: "120",
    });
    expect(cfg.temperature).toBe(0.3);
    expect(cfg.maxOutputTokens).toBe(1024);
    expect(cfg.timeoutSec).toBe(120);
  });

  it("validates reasoningEffort against the allowed set", () => {
    expect(buildAzureFoundryConfig({ reasoningEffort: "high" }).reasoningEffort).toBe("high");
    expect(buildAzureFoundryConfig({ reasoningEffort: "extreme" }).reasoningEffort).toBeUndefined();
  });

  it("preserves enableToolLoop boolean explicitly", () => {
    expect(buildAzureFoundryConfig({ enableToolLoop: false }).enableToolLoop).toBe(false);
    expect(buildAzureFoundryConfig({ enableToolLoop: true }).enableToolLoop).toBe(true);
    expect(buildAzureFoundryConfig({}).enableToolLoop).toBeUndefined();
  });
});
