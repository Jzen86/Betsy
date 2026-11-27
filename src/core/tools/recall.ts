import type { Tool, ToolParam, ToolResult } from "./types.js";
import { searchHistory, formatHistoryHits, type HistoryRole } from "../memory/history.js";

/**
 * Инструмент «вспомнить»: поиск по истории переписки.
 *
 * Ключ — слово, но выдаются сообщения целиком: смысл живёт в сообщении, и она
 * сама решает, та ли это капча, тот ли разговор (владелец, 27.11.2026).
 * Роль — обязательная развилка: «помнишь, **я** говорил» ищет по его
 * сообщениям, «ты говорила» — по её, иначе она приписывает себе его слова.
 */
export class RecallTool implements Tool {
  name = "recall";
  description =
    "Поиск по истории переписки — то, что уже говорили. Используй, когда он спрашивает " +
    "«помнишь…», ссылается на старое, или когда нужно вспомнить деталь, которой нет в текущем " +
    "контексте. Ищи по словам из вопроса. Роль: если он говорит «я говорил / я сказал» — role=me " +
    "(его сообщения); если «ты говорила / ты сказала» — role=you (твои); неясно — any. " +
    "Выдача — это кандидаты: читай сообщения и решай, про тот ли смысл. Не то — переформулируй " +
    "запрос или возьми следующие (offset), но не больше двух-трёх попыток.";

  parameters: ToolParam[] = [
    {
      name: "query",
      type: "string",
      description: "Слова для поиска: 1–4 значимых слова из вопроса, без «помнишь» и «про»",
      required: true,
    },
    {
      name: "role",
      type: "string",
      description: "me — только его сообщения, you — только твои, any — оба (по умолчанию any)",
      required: false,
    },
    {
      name: "days",
      type: "number",
      description: "За сколько дней назад искать (по умолчанию 7, максимум 365)",
      required: false,
    },
    {
      name: "limit",
      type: "number",
      description: "Сколько сообщений отдать (по умолчанию 5, максимум 10)",
      required: false,
    },
    {
      name: "offset",
      type: "number",
      description: "Пропустить первые N находок, чтобы посмотреть дальше",
      required: false,
    },
  ];

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (!query) {
      return { success: false, output: "", error: "Не указан query — что искать в истории" };
    }

    const roleRaw = typeof params.role === "string" ? params.role.trim().toLowerCase() : "any";
    const role: HistoryRole = roleRaw === "me" || roleRaw === "you" ? roleRaw : "any";

    try {
      const result = searchHistory(query, {
        role,
        days: typeof params.days === "number" ? params.days : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        offset: typeof params.offset === "number" ? params.offset : undefined,
      });

      const body = formatHistoryHits(result, role);
      const hint =
        result.total > result.hits.length && result.hits.length > 0
          ? `\nПоказаны не все: дальше — recall с offset=${(typeof params.offset === "number" ? params.offset : 0) + result.hits.length}.`
          : "";
      return { success: true, output: `${body}${hint}` };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `Поиск по истории не сработал: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
