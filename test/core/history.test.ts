import { describe, it, expect } from "vitest";
import { queryRoots, rankHistory } from "../../src/core/memory/history.js";

const row = (id: number, role: "user" | "assistant", content: string, timestamp = id) => ({
  id,
  role,
  content,
  timestamp,
});

describe("queryRoots", () => {
  it("отбрасывает служебные слова", () => {
    const roots = queryRoots("помнишь, я говорил про свитер");
    expect(roots).toEqual(["свит"]);
  });

  it("сводит словоформы к одному корню", () => {
    expect(queryRoots("капчи")).toEqual(["капч"]);
    expect(queryRoots("капчей")).toEqual(["капч"]);
    expect(queryRoots("капчу")).toEqual(["капч"]);
  });

  it("короткие слова ищет целиком", () => {
    expect(queryRoots("кот")).toEqual(["кот"]);
  });
});

describe("rankHistory", () => {
  it("находит словоформы: капчи → капчей", () => {
    const rows = [
      row(1, "user", "Ева, у тебя поиск капчей сломался"),
      row(2, "user", "сегодня обсуждали обед"),
    ];
    const { hits } = rankHistory(rows, "капчи");
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(1);
  });

  it("не цепляет слово внутри другого слова", () => {
    const rows = [row(1, "user", "мы его обманули и победили")];
    const { hits } = rankHistory(rows, "обед");
    expect(hits).toHaveLength(0);
  });

  it("схлопывает одинаковые сообщения", () => {
    const rows = [
      row(1, "user", "диск df -h / и память free -m"),
      row(2, "user", "диск df -h / и память free -m"),
      row(3, "user", "про память поговорим позже"),
    ];
    const { hits } = rankHistory(rows, "память");
    expect(hits).toHaveLength(2);
  });

  it("сначала те, где совпало больше корней", () => {
    const rows = [
      row(1, "user", "сервер молчит", 100),
      row(2, "user", "сервер и память подросли", 50),
    ];
    const { hits } = rankHistory(rows, "сервер память");
    expect(hits[0].id).toBe(2);
  });

  it("отдаёт сообщение, а не обрезок, и метит длинные", () => {
    const long = "свитер. " + "очень длинный текст ".repeat(200);
    const rows = [row(1, "user", long)];
    const { hits } = rankHistory(rows, "свитер", 100);
    expect(hits[0].truncated).toBe(true);
    expect(hits[0].text.length).toBeLessThan(120);
    expect(hits[0].text.startsWith("свитер.")).toBe(true);
  });

  it("различает роли", () => {
    const rows = [row(1, "user", "я говорил про свитер"), row(2, "assistant", "и свитер сполз")];
    const { hits } = rankHistory(rows, "свитер");
    expect(hits.map((h) => h.role).sort()).toEqual(["assistant", "user"]);
  });

  it("без значимых слов ничего не ищет", () => {
    expect(rankHistory([row(1, "user", "что-то")], "помнишь про то").hits).toHaveLength(0);
  });
});
