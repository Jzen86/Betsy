import { describe, it, expect } from "vitest";
import { parseModelRef } from "../src/core/llm/router.js";

/**
 * A fallback chain that crosses providers.
 *
 * The owner's arrangement (03.11) is two OpenCode Go models, then two Google ones —
 * and the Google half is the only part that survives when the whole gateway goes down.
 * Before this, every fallback was a model id on one hardcoded host, so a cross-provider
 * chain could not be expressed at all: the config had a single `provider` and no way to
 * say "and now a different account".
 *
 * The syntax is a provider prefix before the colon, and a bare name keeps the default —
 * which is what makes every existing config still mean what it meant.
 */
describe("parseModelRef", () => {
  it("keeps the default provider for a bare model name", () => {
    expect(parseModelRef("deepseek-v4.1-flash", "opencode")).toEqual({
      provider: "opencode",
      model: "deepseek-v4.1-flash",
    });
  });

  it("reads the provider from the prefix", () => {
    expect(parseModelRef("google:gemini-3.5-flash-lite", "opencode")).toEqual({
      provider: "google",
      model: "gemini-3.5-flash-lite",
    });
  });

  it("does not mistake a vendor path for a provider", () => {
    // `qwen/qwen3-coder:free` is one OpenRouter model id: the colon is part of the id,
    // and the part before it contains a slash. Reading that as a provider would send
    // the request to a host named "qwen/qwen3-coder", which does not exist.
    expect(parseModelRef("qwen/qwen3-coder:free", "openrouter")).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3-coder:free",
    });
  });

  it("leaves a trailing colon alone", () => {
    expect(parseModelRef("google:", "opencode")).toEqual({ provider: "opencode", model: "google:" });
  });
});
