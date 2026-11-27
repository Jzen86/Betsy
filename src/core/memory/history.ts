import { getDB } from "./db.js";

/**
 * Поиск по истории переписки.
 *
 * Зачем это, а не knowledge: в `knowledge` попадает только то, что она решила
 * записать, а в истории лежит всё — включая мелочи, которые писать было лень
 * (владелец, 27.11.2026). Память в виде ленты честнее: она не теряет того,
 * что сочли неважным.
 *
 * Ищем по словам, но отдаём **сообщение целиком**: слово — только ключ, смысл
 * живёт в сообщении, и обрезанный кусок его искажает (владелец, 27.11.2026).
 * Про тот ли это смысл, решает она, а не поиск.
 *
 * Почему не FTS5: он не знает русских словоформ («капчи» ≠ «капчей»), а база
 * маленькая — искать по словам в JS дешевле, чем строить и поддерживать
 * индекс. Замер: ~160 токенов на запрос при сниппетах; с целыми сообщениями
 * дороже, поэтому сообщения режутся потолком и параметром limit.
 */

export type HistoryRole = "me" | "you" | "any";

export interface HistoryHit {
  id: number;
  role: "user" | "assistant";
  timestamp: number;
  text: string;
  truncated: boolean;
}

export interface HistorySearchOptions {
  role?: HistoryRole;
  days?: number;
  limit?: number;
  offset?: number;
  maxChars?: number;
}

export interface HistorySearchResult {
  total: number;
  hits: HistoryHit[];
  roots: string[];
}

/** Потолок на одно сообщение: длинные простыни режем, остальное отдаём как есть. */
const DEFAULT_MAX_CHARS = 1200;

const STOP = new Set([
  "помнишь", "помню", "я", "ты", "говорил", "говорила", "сказал", "сказала",
  "что", "про", "как", "мы", "мне", "меня", "тебе", "тебя", "это", "там",
  "был", "была", "было", "были", "быть", "и", "а", "но", "не", "на", "в",
  "с", "у", "же", "ли", "да", "ну", "вот", "когда", "где", "почему", "зачем",
  "ещё", "еще", "уже", "может", "если", "то", "так", "всё", "все", "она",
  "он", "они", "его", "её", "их", "нам", "вам", "мой", "твой", "свой",
]);

function normalizeWords(text: string): string[] {
  return text.toLowerCase().match(/[a-zа-яё0-9]+/g) ?? [];
}

/**
 * Корни для поиска.
 *
 * Русские словоформы держатся за первые 4 знака: «капчи», «капчей», «капчу»
 * сходятся на «капч»; «свитер», «свитера» — на «свит». Поэтому слова длиннее
 * четырёх обрезаются до четырёх, а короткие ищутся целиком — иначе «кот»
 * цеплял бы «который».
 */
export function queryRoots(query: string): string[] {
  const words = normalizeWords(query).filter((w) => !STOP.has(w) && w.length >= 3);
  const roots = new Set<string>();
  for (const w of words) roots.add(w.length > 4 ? w.slice(0, 4) : w);
  return [...roots];
}

function rootMatches(word: string, root: string): boolean {
  if (root.length <= 3) return word === root;
  return word.startsWith(root);
}

/** Целое сообщение, но не длиннее потолка; режем по границе слова. */
function messageText(content: string, maxChars: number): { text: string; truncated: boolean } {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return { text: flat, truncated: false };
  let cut = maxChars;
  while (cut > 0 && flat[cut] !== " ") cut--;
  return { text: `${flat.slice(0, cut > 0 ? cut : maxChars)}…`, truncated: true };
}

/** Ключ дедупа: одинаковые телеметрии и повторы не должны занимать все места. */
function dedupeKey(content: string): string {
  return content.toLowerCase().replace(/[^a-zа-яё0-9]+/g, "").slice(0, 120);
}

interface RankRow {
  id: number;
  role: string;
  content: string;
  timestamp: number;
}

/**
 * Ранжирование — чистая функция без базы, чтобы проверять логику в тестах.
 * Сначала те, где совпало больше разных корней, при равенстве — свежие.
 */
export function rankHistory(
  rows: RankRow[],
  query: string,
  maxChars = DEFAULT_MAX_CHARS,
): { hits: HistoryHit[]; roots: string[] } {
  const roots = queryRoots(query);
  if (roots.length === 0) return { hits: [], roots };

  const seen = new Set<string>();
  const scored: { hit: HistoryHit; score: number }[] = [];

  for (const row of rows) {
    const content = String(row.content ?? "");
    if (!content) continue;
    const words = normalizeWords(content);
    let score = 0;
    for (const root of roots) {
      if (words.some((w) => rootMatches(w, root))) score++;
    }
    if (score === 0) continue;
    const key = dedupeKey(content);
    if (seen.has(key)) continue;
    seen.add(key);
    const { text, truncated } = messageText(content, maxChars);
    scored.push({
      score,
      hit: {
        id: row.id,
        role: row.role === "user" ? "user" : "assistant",
        timestamp: row.timestamp,
        text,
        truncated,
      },
    });
  }

  scored.sort((a, b) => b.score - a.score || b.hit.timestamp - a.hit.timestamp);
  return { hits: scored.map((s) => s.hit), roots };
}

export function searchHistory(query: string, opts: HistorySearchOptions = {}): HistorySearchResult {
  const role = opts.role ?? "any";
  const days = Math.min(Math.max(opts.days ?? 7, 1), 365);
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
  const offset = Math.max(opts.offset ?? 0, 0);
  const maxChars = Math.min(Math.max(opts.maxChars ?? DEFAULT_MAX_CHARS, 200), 2000);

  const db = getDB();
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const roleSql = role === "me" ? "user" : role === "you" ? "assistant" : null;

  const rows = db
    .prepare(
      `SELECT id, role, content, timestamp FROM conversations
       WHERE channel = 'telegram' AND timestamp >= ?
         AND role IN ('user', 'assistant')
         ${roleSql ? "AND role = ?" : ""}
       ORDER BY timestamp DESC`,
    )
    .all(...(roleSql ? [since, roleSql] : [since])) as RankRow[];

  const { hits, roots } = rankHistory(rows, query, maxChars);
  return { total: hits.length, hits: hits.slice(offset, offset + limit), roots };
}

/** Человеческий формат для промта: дата, кто сказал, и сообщение целиком. */
export function formatHistoryHits(result: HistorySearchResult, role: HistoryRole): string {
  if (result.hits.length === 0) {
    return "В истории за этот период ничего не нашлось по этим словам.";
  }
  const who = (r: "user" | "assistant") => (r === "user" ? "он" : "ты");
  const lines = result.hits.map((h) => {
    const d = new Date(h.timestamp * 1000).toISOString().slice(5, 10).replace("-", ".");
    return `[${d} ${who(h.role)}] ${h.text}`;
  });
  const order = role === "me" ? "его сообщения" : role === "you" ? "твои сообщения" : "оба голоса";
  const cut = result.hits.some((h) => h.truncated) ? " (длинные обрезаны)" : "";
  return `Нашлось ${result.total} (${order}, показаны ${result.hits.length})${cut}:\n${lines.join("\n")}`;
}
