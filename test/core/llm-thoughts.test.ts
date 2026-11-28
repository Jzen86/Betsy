import { describe, it, expect } from "vitest";
import { buildResponse, stripThoughts } from "../../src/core/llm/providers/openai-compat";

/**
 * Gemma думает вслух в самом ответе.
 *
 * Живой случай 28.11: в чат ушёл внутренний разбор комплимента списком
 * («Комплимент смутил и попал в точку…»), потому что OpenAI-совместимый слой
 * положил `<thought>` прямо в `content`, а движок принял это за реплику.
 * Тест держит границу: мысли не отправляются человеку никогда.
 */
describe("thoughts inside content", () => {
  it("вырезает закрытый блок мыслей", () => {
    expect(stripThoughts("<thought>разбор</thought>Привет, милашка.")).toBe("Привет, милашка.");
  });

  it("обрезанный блок мыслей не остаётся текстом", () => {
    expect(stripThoughts("<thought>разбор без конца")).toBe("");
  });

  it("закрытый блок посреди текста не съедает остальное", () => {
    expect(stripThoughts("Начало. <thought>внутри</thought> Конец.")).toBe("Начало.  Конец.");
  });

  it("только мысли — это обрыв, а не ответ", () => {
    const r = buildResponse("<thought>разбор</thought>", "stop");
    expect(r.text).toBe("");
    expect(r.stopReason).toBe("incomplete");
  });

  it("обычный ответ не трогает", () => {
    const r = buildResponse("ок", "stop");
    expect(r.text).toBe("ок");
    expect(r.stopReason).toBe("end_turn");
  });
});
