import { describe, it, expect } from "vitest"

describe("engine runaway protection", () => {
  it("MAX_PROMPT_TOKENS is defined", async () => {
    const engine = await import("../../src/core/engine.js")
    expect((engine as any).MAX_PROMPT_TOKENS).toBe(128_000)
  })

  it("MAX_SAME_TOOL is defined as 8", async () => {
    const engine = await import("../../src/core/engine.js")
    expect((engine as any).MAX_SAME_TOOL).toBe(8)
  })

  it("цепи хода в промте берутся из констант, а не из заметок", async () => {
    const engine = await import("../../src/core/engine.js")
    const { limitsNote, sameToolLimitFor } = engine as any

    const chat = limitsNote(sameToolLimitFor(false))
    const service = limitsNote(sameToolLimitFor(true))

    expect(chat).toContain("до 8 раз")
    expect(service).toContain("до 12 раз")
    expect(chat).toContain("5 минут")
  })

  it("служебному ходу потолок выше: повторить там некому", async () => {
    const engine = await import("../../src/core/engine.js")
    const { sameToolLimitFor, MAX_SAME_TOOL, MAX_SAME_TOOL_SERVICE } = engine as any

    expect(sameToolLimitFor(true)).toBe(12)
    expect(sameToolLimitFor(false)).toBe(8)
    expect(MAX_SAME_TOOL_SERVICE).toBeGreaterThan(MAX_SAME_TOOL)
  })
})
