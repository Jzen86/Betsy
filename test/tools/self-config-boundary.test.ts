import { describe, it, expect } from "vitest";
import { selfConfigTool } from "../../src/core/tools/self-config.js";

/**
 * The line between "her character" and "the machine".
 *
 * `self_config` is how she is allowed to be a personality: her tone, her name, her own
 * instruction text, the owner's facts. It used to be a door to the entire config — `list`
 * flattened every key into a chat message (API keys, the bot token included), and `set`
 * accepted anything, so `security.tools.shell = true` would have put the shell we had just
 * removed back into her hands.
 *
 * These tests fail on the old code: the first two because the keys were readable, the
 * third because the write would have succeeded.
 */
describe("self_config boundary", () => {
  it("refuses to read an API key", async () => {
    const res = await selfConfigTool.execute({ action: "get", key: "llm.api_key" });
    expect(res.success).toBe(false);
    expect(String(res.error)).toBe("forbidden_key");
  });

  it("refuses to read the bot token", async () => {
    const res = await selfConfigTool.execute({ action: "get", key: "telegram.token" });
    expect(res.success).toBe(false);
  });

  it("refuses to re-arm the shell", async () => {
    const res = await selfConfigTool.execute({ action: "set", key: "security.tools.shell", value: "true" });
    expect(res.success).toBe(false);
    expect(String(res.error)).toBe("forbidden_key");
  });

  it("still lets her read her own character", async () => {
    const res = await selfConfigTool.execute({ action: "get", key: "agent.personality" });
    // The key is allowed; whether a config file exists on this machine is another matter.
    expect(String(res.error ?? "")).not.toBe("forbidden_key");
  });

  it("lists only the keys she is allowed to see", async () => {
    const res = await selfConfigTool.execute({ action: "list" });
    expect(res.success).toBe(true);
    const text = String(res.output);
    expect(text).not.toContain("api_key");
    expect(text).not.toContain("telegram.token");
  });
});
