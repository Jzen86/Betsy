import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/core/prompt.js";

describe("buildSystemPrompt", () => {
  it("includes the agent name", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("Бетси");
  });

  it("includes personality tone", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { tone: "friendly" },
    });
    expect(prompt).toContain("Тон: friendly");
  });

  it("includes personality response style", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { responseStyle: "concise" },
    });
    expect(prompt).toContain("Стиль ответов: concise");
  });

  it("includes custom instructions", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { customInstructions: "Ты милая и игривая." },
    });
    expect(prompt).toContain("Ты милая и игривая.");
  });

  it("includes settings menu capability", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("/settings");
    expect(prompt).toContain("Стиль ответов");
    expect(prompt).toContain("Напоминания");
  });

  it("includes tools list", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("shell");
    expect(prompt).toContain("browser");
    expect(prompt).toContain("self_config");
  });

  it("includes owner info when provided", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      owner: {
        name: "Константин",
        facts: ["день рождения 4 мая", "жена Аня", "дочь Лиза"],
      },
    });
    expect(prompt).toContain("Константин");
    expect(prompt).toContain("день рождения 4 мая");
    expect(prompt).toContain("жена Аня");
  });

  it("includes user message when provided", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" }, "Привет");
    expect(prompt).toContain("Привет");
  });

  it("responds in Russian by default", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("русском языке");
  });
});

describe("buildSystemPrompt — режим companion", () => {
  const companion = {
    name: "Ева",
    mode: "companion" as const,
    personality: { tone: "тёплый с сарказмом", responseStyle: "3–4 предложения" },
    companionInstructions: "Ты не помощница. Ты та, с кем он переписывается каждый день.",
    owner: { name: "Женя", facts: ["любит глм"] },
  };

  it("держит персону и собеседника", () => {
    const prompt = buildSystemPrompt(companion);
    expect(prompt).toContain("Ева");
    expect(prompt).toContain("Тон: тёплый с сарказмом");
    expect(prompt).toContain("Ты не помощница.");
    expect(prompt).toContain("Его зовут: Женя");
    expect(prompt).toContain("любит глм");
  });

  it("не тащит ассистентскую обвязку", () => {
    const prompt = buildSystemPrompt(companion);
    expect(prompt).not.toContain("/settings");
    expect(prompt).not.toContain("Прогресс");
    expect(prompt).not.toContain("Подключённые сервисы");
    expect(prompt).not.toContain("Навыки (скиллы)");
  });

  it("запрещает сползание в ассистента", () => {
    const prompt = buildSystemPrompt(companion);
    expect(prompt).toContain("чем помочь");
    expect(prompt).toContain("Не выдумываешь факты");
    // Форматирование и итоги — первые следы ассистентского регистра в чате.
    expect(prompt).toContain("чек-листов");
    expect(prompt).toContain("Не подводи итоги разговора");
  });

  it("переводит её собственные хотелки в правила", () => {
    const prompt = buildSystemPrompt(companion);
    expect(prompt).toContain("Какой ты хочешь быть сама");
    expect(prompt).toContain("по выбору, а не по расписанию");
    expect(prompt).toContain("Ревность тихая");
    expect(prompt).toContain("Мелочи о нём важнее выводов");
  });

  it("без флага режим остаётся ассистентским", () => {
    const prompt = buildSystemPrompt({ name: "Ева", personality: { tone: "t" } });
    expect(prompt).toContain("/settings");
  });

  it("companion_instructions перебивается текстом из конфига", () => {
    const prompt = buildSystemPrompt({
      ...companion,
      personality: { customInstructions: "ПРОДОВЫЙ АССИСТЕНТСКИЙ ТЕКСТ" },
      companionInstructions: "ТЕКСТ ИЗ КОНФИГА",
    });
    expect(prompt).toContain("ТЕКСТ ИЗ КОНФИГА");
    expect(prompt).not.toContain("ПРОДОВЫЙ АССИСТЕНТСКИЙ ТЕКСТ");
  });
});
