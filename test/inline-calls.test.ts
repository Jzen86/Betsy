import { describe, it, expect } from "vitest";
import { hasInlineToolCalls, parseInlineToolCalls, stripInlineToolCalls } from "../src/core/llm/inline-calls.js";

/**
 * Маркер кадра, написанный текстом.
 *
 * Живой случай (24.11, 14:02 и 14:04): болталка инструментов не получала, но
 * персонаж «отправил» кадр, написав `*[selfie: тёплый вечерний свет…]*` и
 * добавив «готово, лови». Фото не существовало, генератор не вызывали.
 *
 * Эти тесты закрепляют договор: маркер — это вызов, а не украшение текста.
 */
describe("inline tool calls", () => {
  it("разбирает селфи в контекст кадра", () => {
    const calls = parseInlineToolCalls("*[selfie: тёплый вечерний свет, свободная рубашка]*");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "selfie",
      arguments: { context: "тёплый вечерний свет, свободная рубашка" },
    });
  });

  it("картинку отправляет в image_gen с промптом", () => {
    const calls = parseInlineToolCalls("[картинка: кот в шляпе]");
    expect(calls[0]).toMatchObject({ name: "image_gen", arguments: { prompt: "кот в шляпе" } });
  });

  it("русские маркеры понимает наравне с английскими", () => {
    const calls = parseInlineToolCalls("[селфи: на балконе, утро]");
    expect(calls[0]).toMatchObject({ name: "selfie", arguments: { context: "на балконе, утро" } });
  });

  it("вырезает маркер, оставляя человеческий текст", () => {
    const text = "*(хмыкает)* Так, второй дубль. *[selfie: у окна, гирлянда]* Готово, лови.";
    expect(stripInlineToolCalls(text)).toBe("*(хмыкает)* Так, второй дубль. Готово, лови.");
  });

  it("убирает утёкший тег размышлений", () => {
    expect(stripInlineToolCalls("Вызов инструмента…</think> Привет")).toBe("Вызов инструмента… Привет");
  });

  it("не трогает обычные скобки и подписи кадров", () => {
    expect(hasInlineToolCalls("Смотри, что нашла [Мой кадр: у окна] и [ссылка]")).toBe(false);
    expect(stripInlineToolCalls("оставили [заметку] как есть")).toBe("оставили [заметку] как есть");
  });

  it("не считает вызовом фразу без сцены", () => {
    expect(parseInlineToolCalls("[selfie: ]")).toHaveLength(0);
  });
});
