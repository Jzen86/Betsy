import { describe, it, expect } from "vitest"
import { parseDsmlToolCalls, hasDsmlToolCalls, stripDsmlBlocks } from "../../src/core/llm/dsml.js"

const live = `Лимит shell выбрала — заметки дописываю сейчас.

<|DSML| calls>
<|DSML| invoke name="files">
<|DSML| parameter name="action">append</|DSML| parameter>
<|DSML| parameter name="path">/root/.betsy/files/ops.md</|DSML| parameter>
<|DSML| parameter name="content">### 2026-11-15 — карта
строка вторая
</|DSML| parameter>
</|DSML| invoke>
<|DSML| invoke name="shell">
<|DSML| parameter name="command">df -h /</|DSML| parameter>
</|DSML| invoke>
</|DSML| calls>`

describe("родной диалект вызова инструментов", () => {
  it("видит вызовы и в обычной, и в полноширинной черте", () => {
    expect(hasDsmlToolCalls(live)).toBe(true)
    expect(hasDsmlToolCalls(live.replace(/\|/g, "｜"))).toBe(true)
    expect(hasDsmlToolCalls("Всё в порядке, замечаний нет.")).toBe(false)
  })

  it("разбирает два вызова с параметрами и многострочным значением", () => {
    const calls = parseDsmlToolCalls(live)

    expect(calls).toHaveLength(2)
    expect(calls[0].name).toBe("files")
    expect(calls[0].arguments.action).toBe("append")
    expect(calls[0].arguments.path).toBe("/root/.betsy/files/ops.md")
    expect(String(calls[0].arguments.content)).toContain("2026-11-15")
    expect(String(calls[0].arguments.content)).toContain("строка вторая")

    expect(calls[1].name).toBe("shell")
    expect(calls[1].arguments.command).toBe("df -h /")
  })

  it("приводит числа и булевы к типам, а не к строкам", () => {
    const text = `<|DSML| invoke name="x">
<|DSML| parameter name="n">42</|DSML| parameter>
<|DSML| parameter name="flag">true</|DSML| parameter>
<|DSML| parameter name="s">42a</|DSML| parameter>
</|DSML| invoke>`

    const [call] = parseDsmlToolCalls(text)
    expect(call.arguments.n).toBe(42)
    expect(call.arguments.flag).toBe(true)
    expect(call.arguments.s).toBe("42a")
  })

  it("оставляет текст до блока и ничего не выдумывает на пустом месте", () => {
    expect(stripDsmlBlocks(live)).toBe("Лимит shell выбрала — заметки дописываю сейчас.")
    expect(stripDsmlBlocks("обычный ответ")).toBe("обычный ответ")
    expect(parseDsmlToolCalls("обычный ответ")).toEqual([])
    expect(parseDsmlToolCalls(null)).toEqual([])
  })
})
