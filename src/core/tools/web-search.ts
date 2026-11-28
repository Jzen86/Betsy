import type { Tool, ToolResult } from "./types.js";

/**
 * Поиск в сети по запросу.
 *
 * Зачем отдельный тул, а не `http`: до 28.11 она «искала», дёргая поисковик
 * через `http` и разбирая HTML. С сервера это ловит капчу — в переписке
 * осталось её собственное «сеть капризная, половина поисковиков капчу шлёт».
 * Brave API отдаёт нормальный JSON по запросу, без HTML и без капчи, и работает
 * из РФ напрямую (единственное, что геоблокировано — их дашборд).
 *
 * Ключ живёт в конфиге (`brave.api_key`), не в коде и не в env.
 */
export interface WebSearchOptions {
  apiKey: string;
  /** Сколько результатов по умолчанию. */
  limit?: number;
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

export class WebSearchTool implements Tool {
  name = "web_search";
  description =
    "Поиск в интернете по запросу. Возвращает заголовки, ссылки и краткие выдержки. " +
    "Используй, когда нужен факт из сети, а не догадка; по найденной ссылке можно потом пройти через http.";
  parameters = [
    { name: "query", type: "string", description: "Поисковый запрос", required: true },
    { name: "limit", type: "number", description: "Сколько результатов, по умолчанию 5 (максимум 10)" },
  ];

  private readonly apiKey: string;
  private readonly defaultLimit: number;

  constructor(opts: WebSearchOptions) {
    this.apiKey = opts.apiKey;
    this.defaultLimit = opts.limit ?? 5;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const query = String(params.query ?? "").trim();
    if (!query) return { success: false, output: "", error: "Пустой запрос" };

    const raw = Number(params.limit);
    const count = Math.min(Math.max(Number.isFinite(raw) ? raw : this.defaultLimit, 1), 10);

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    url.searchParams.set("text_decorations", "false");

    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
        },
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status === 401 || res.status === 403) {
        return { success: false, output: "", error: "Поиск не пустил: ключ Brave не принят" };
      }
      if (res.status === 429) {
        return { success: false, output: "", error: "Лимит поиска исчерпан, попробуй позже" };
      }
      if (!res.ok) {
        return { success: false, output: "", error: `Поиск ответил ${res.status}` };
      }

      const data = (await res.json()) as { web?: { results?: BraveResult[] } };
      const results = (data.web?.results ?? []).slice(0, count);
      if (results.length === 0) {
        return { success: true, output: "По этому запросу ничего не нашлось." };
      }

      const lines = results.map((r, i) => {
        const title = (r.title ?? "").replace(/\s+/g, " ").trim();
        const link = (r.url ?? "").trim();
        const snippet = (r.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
        return `${i + 1}. ${title}\n   ${link}${snippet ? `\n   ${snippet}` : ""}`;
      });

      return { success: true, output: lines.join("\n") };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: `Поиск не ответил: ${msg.slice(0, 120)}` };
    }
  }
}
