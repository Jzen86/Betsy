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

  it("стрим не выпускает служебный блок в чат, даже если маркер разорван", async () => {
    const { makeTextGuard } = await import("../../src/core/engine.js")
    const out: string[] = []
    const guard = makeTextGuard((c) => out.push(c))

    guard.push("Прокси в порядке. ")
    guard.push("Заметки дописываю: <｜DS")
    guard.push("ML｜ calls><｜DSML｜ invoke name=")
    guard.push("files>…")
    guard.flush()

    expect(guard.stopped()).toBe(true)
    // Хвост, который придерживали, теряется вместе с блоком — это цена стрима:
    // уже отправленное назад не вернуть. Главное — теги в чат не попали.
    expect(out.join("")).toContain("Прокси в порядке.")
    expect(out.join("")).not.toContain("DSML")
  })

  it("safeForUser чистит любой путь ответа, включая «последний шанс»", async () => {
    const { safeForUser } = await import("../../src/core/engine.js")
    const wall = `Уже набрала достаточно. Записываю и говорю.\n\n${liveCase}`
    expect(safeForUser(wall, "tool_limit")).toBe("Уже набрала достаточно. Записываю и говорю.")
    expect(safeForUser("обычный ответ")).toBe("обычный ответ")
    expect(safeForUser(undefined)).toBe("")
  })

  it("clipForChat режет длинный ответ по границе и говорит, что сократил", async () => {
    const { clipForChat, HARD_CHAT_CHARS } = await import("../../src/core/engine.js")
    const long = Array.from({ length: 200 }, (_, i) => `Строка ${i} с текстом отчёта.`).join("\n")

    const clipped = clipForChat(long)

    expect(clipped.length).toBeLessThanOrEqual(HARD_CHAT_CHARS + 60)
    expect(clipped).toContain("сократила")
    expect(clipForChat("короткий ответ")).toBe("короткий ответ")
  })

  it("нормальный стрим доходит целиком", async () => {
    const { makeTextGuard } = await import("../../src/core/engine.js")
    const out: string[] = []
    const guard = makeTextGuard((c) => out.push(c))

    guard.push("Всё живо, ")
    guard.push("замечаний нет.")
    guard.flush()

    expect(guard.stopped()).toBe(false)
    expect(out.join("")).toBe("Всё живо, замечаний нет.")
  })
})
