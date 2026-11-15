import { describe, it, expect } from "vitest"

describe("engine runaway protection", () => {
  it("MAX_PROMPT_TOKENS is defined", async () => {
    const engine = await import("../../src/core/engine.js")
    expect((engine as any).MAX_PROMPT_TOKENS).toBe(128_000)
  })

  it("MAX_SAME_TOOL is defined as 5", async () => {
    const engine = await import("../../src/core/engine.js")
    expect((engine as any).MAX_SAME_TOOL).toBe(5)
  })

  it("служебному ходу потолок выше: повторить там некому", async () => {
    const engine = await import("../../src/core/engine.js")
    const { sameToolLimitFor, MAX_SAME_TOOL, MAX_SAME_TOOL_SERVICE } = engine as any

    expect(sameToolLimitFor(true)).toBe(12)
    expect(sameToolLimitFor(false)).toBe(5)
    expect(MAX_SAME_TOOL_SERVICE).toBeGreaterThan(MAX_SAME_TOOL)
  })
})
