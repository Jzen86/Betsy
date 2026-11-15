import { describe, it, expect } from "vitest"
import { looksLikeTextToolCall, stripTextToolCalls } from "../../src/core/engine.js"

/**
 * Живой случай 15.11: модель отдала вызов инструмента текстом в нативном
 * синтаксисе, движок счёл это ответом и отправил владельцу 6.6 КБ служебного
 * блока. Заметка, которую она «написала», не попала никуда.
 */
const liveCase = [
  "<|DSML| calls>",
  '<|DSML| invoke name="files">',
  '<|DSML| parameter name="action">append</|DSML| parameter>',
  '<|DSML| parameter name="path">/root/.betsy/files/ops.md</|DSML| parameter>',
  "<|DSML| parameter name=\"content\">### 2026-11-15 — карта машины</|DSML| parameter>",
  "</|DSML| invoke>",
  "</|DSML| calls>",
].join("\n")

const fullwidthCase = liveCase.replace(/\|/g, "｜")

describe("вызов инструмента, приехавший текстом", () => {
  it("узнаёт нативный синтаксис с обычной и с полноширинной чертой", () => {
    expect(looksLikeTextToolCall(liveCase)).toBe(true)
    expect(looksLikeTextToolCall(fullwidthCase)).toBe(true)
  })

  it("не трогает нормальный ответ", () => {
    expect(looksLikeTextToolCall("Всё живо, порт слушает, замечаний нет.")).toBe(false)
    expect(looksLikeTextToolCall("")).toBe(false)
    expect(looksLikeTextToolCall(undefined)).toBe(false)
  })

  it("оставляет текст до служебного блока и выбрасывает блок", () => {
    const mixed = `Посмотрела сервер.\n\n${liveCase}`
    expect(stripTextToolCalls(mixed)).toBe("Посмотрела сервер.")
    expect(stripTextToolCalls(liveCase)).toBe("")
  })
})
