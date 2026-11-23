import { describe, it, expect } from "vitest";
import { buildResponse, toOpenAIMessages } from "../../src/core/llm/providers/openai-compat";
import { isSmallTalk } from "../../src/core/llm/chat-route";
import type { LLMClient, LLMMessage } from "../../src/core/llm/types";

/**
 * Почему это тестируется отдельно от HTTP.
 *
 * 23.11 у неё за вечер уехало четыре обрубка («Ну да, по бумагам и», 8 токенов),
 * и причина была не в сети, а в переводе `finish_reason → stopReason`: пустое
 * значение превращалось в `end_turn`, то есть «я закончила». Сеть в тесте не
 * нужна — нужна таблица соответствий, которая падает, если кто-то снова
 * «упростит» её до `finish_reason === "stop" ? "end_turn" : "end_turn"`.
 */
describe("finish_reason → stopReason", () => {
  it("пустой finish_reason — обрыв, а не конец", () => {
    expect(buildResponse("Ну да, по бумагам и", null).stopReason).toBe("incomplete");
  });

  it("незнакомое значение тоже обрыв: гадать нечем", () => {
    expect(buildResponse("текст", "whatever").stopReason).toBe("incomplete");
  });

  it("stop — честный конец", () => {
    expect(buildResponse("готово", "stop").stopReason).toBe("end_turn");
  });

  it("length — упёрлась в лимит вывода", () => {
    expect(buildResponse("обрезано", "length").stopReason).toBe("max_tokens");
  });

  it("content_filter — срезал фильтр провайдера", () => {
    expect(buildResponse("обрезано", "content_filter").stopReason).toBe("filtered");
  });

  it("tool_calls — инструменты, даже если finish_reason пустой", () => {
    const r = buildResponse("", null, [{ id: "1", name: "shell", arguments: {} }]);
    expect(r.stopReason).toBe("tool_use");
  });
});

describe("toOpenAIMessages со stripTools", () => {
  const history: LLMMessage[] = [
    { role: "user", content: "посмотри сервер" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "uptime" } }] },
    { role: "tool", toolCallId: "c1", content: "load average: 0.3" },
    { role: "assistant", content: "всё живо" },
  ];

  it("разговорный маршрут получает только человеческий текст", () => {
    const out = toOpenAIMessages(history, true);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(out)).not.toContain("tool_calls");
    expect(JSON.stringify(out)).not.toContain("load average");
  });

  it("обычный маршрут получает историю целиком", () => {
    const out = toOpenAIMessages(history);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("пустой assistant-вызов без текста не превращается в пустую реплику", () => {
    const out = toOpenAIMessages(history, true);
    expect(out.every((m) => typeof m.content === "string" ? m.content.trim().length > 0 : true)).toBe(true);
  });
});

function fakeLlm(answer: string, counter?: { calls: number }): LLMClient {
  return {
    async chat() {
      if (counter) counter.calls += 1;
      return { text: answer, stopReason: "end_turn" };
    },
    async chatStream() {
      throw new Error("stream not used in the classifier");
    },
  };
}

describe("isSmallTalk", () => {
  it("длинное сообщение — работа по определению, классификатор не зовётся", async () => {
    const counter = { calls: 0 };
    const res = await isSmallTalk(fakeLlm("CHAT", counter), "а".repeat(401));
    expect(res).toBe(false);
    expect(counter.calls).toBe(0);
  });

  it("CHAT без TOOL — болтовня", async () => {
    expect(await isSmallTalk(fakeLlm("CHAT"), "скучно, расскажи что-нибудь")).toBe(true);
  });

  it("TOOL — работа, даже если в ответе есть слово CHAT", async () => {
    expect(await isSmallTalk(fakeLlm("TOOL (не CHAT)"), "проверь диск")).toBe(false);
  });

  it("пустое сообщение считается болтовнёй", async () => {
    expect(await isSmallTalk(fakeLlm("TOOL"), "   ")).toBe(true);
  });
});
