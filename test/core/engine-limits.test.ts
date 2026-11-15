import { describe, it, expect } from "vitest"

describe("engine runaway protection", () => {
  it("MAX_PROMPT_TOKENS is defined", async () => {
    const engine = await import("../../src/core/engine.js")
    expect((engine as any).MAX_PROMPT_TOKENS).toBe(128_000)
  })

  it("MAX_SAME_TOOL is defined as 20", async () => {
    const engine = await import("../../src/core/engine.js")
    expect((engine as any).MAX_SAME_TOOL).toBe(20)
  })

  it("служебному ходу потолок выше: повторить там некому", async () => {
    const engine = await import("../../src/core/engine.js")
    const { sameToolLimitFor, MAX_SAME_TOOL, MAX_SAME_TOOL_SERVICE, MAX_TOTAL_TOOL_CALLS } = engine as any

    expect(sameToolLimitFor(true)).toBe(30)
    expect(sameToolLimitFor(false)).toBe(20)
    expect(MAX_SAME_TOOL_SERVICE).toBeGreaterThan(MAX_SAME_TOOL)
    // Общий предохранитель обязан быть выше любого одиночного, иначе он
    // сработает первым и потолок инструмента перестанет что-либо значить.
    expect(MAX_TOTAL_TOOL_CALLS).toBeGreaterThan(MAX_SAME_TOOL_SERVICE)
  })
})
