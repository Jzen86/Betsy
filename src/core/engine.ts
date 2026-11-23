import type { IncomingMessage, OutgoingMessage, ProgressCallback } from "./types.js";
import type { LLMClient, LLMMessage, LLMResponse, ContentPart, ToolDefinition } from "./llm/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";
import { buildSystemPrompt, type PromptConfig } from "./prompt.js";
import { searchKnowledge } from "./memory/knowledge.js";
import { saveMessage, loadHistory, extractText } from "./memory/conversations.js";
import { compactHistory } from "./memory/compaction.js";
import { LLMUnavailableError } from "./llm/router.js";
import { isSmallTalk, RP_MODEL, RP_PROVIDER, RP_ROUTER } from "./llm/chat-route.js";
import { parseDsmlToolCalls } from "./llm/dsml.js";
import { TokenStore } from "../services/tokens.js";
import { getService } from "../services/catalog.js";
import { SkillsStore } from "../services/skills-store.js";

function historyChars(history: LLMMessage[]): number {
  let total = 0;
  for (const m of history) {
    if (typeof m.content === "string") {
      total += m.content.length;
    } else {
      for (const p of m.content) {
        if (p.type === "text") total += p.text.length;
      }
    }
  }
  return total;
}

const MAX_TURNS = 20;
const MAX_HISTORY = 40;
export const MAX_PROMPT_TOKENS = 128_000;
export const MAX_SAME_TOOL = 8;

/**
 * Ответ, который нельзя считать ответом.
 *
 * `incomplete` — поток закрылся без финального `finish_reason`; `filtered` —
 * провайдер срезал отдачу фильтром; `max_tokens` — упёрлась в лимит вывода.
 * Все три — не «закончила», а «оборвалась», и молча отправлять их человеку
 * нельзя: 23.11 так ушли четыре реплики, оборванные на середине слова.
 */
function isBrokenAnswer(r: LLMResponse): boolean {
  return r.stopReason === "incomplete" || r.stopReason === "filtered" || r.stopReason === "max_tokens";
}

/**
 * Потолок для служебного хода (плановое задание).
 *
 * В чате обрыв стоит одного «повтори», и владелец рядом. У служебного хода
 * повторить некому, а работа длиннее: осмотр сервера — это `systemctl`,
 * журнал, API, доки, nginx, обновления, то есть шесть-восемь вызовов ещё до
 * того, как она начнёт думать. Живой случай первого же осмотра: упёрлась в
 * шесть и не закончила.
 */
export const MAX_SAME_TOOL_SERVICE = 12;

/**
 * Что она видит сразу после того, как нарисовала кадр.
 *
 * Инструкция живёт один запрос (её подкладывают в системный промт на ход, где
 * кадр только что появился), а сам кадр остаётся в истории — владелец просил
 * именно это: «видит в моменте, но не в контексте». Правила в подписи — его
 * слова (16.10): явный брак (лишняя рука/нога/голова, не то число частей) —
 * переделать ОДИН раз и молча; мелочи вроде пальцев — оставить; в ответе кадр
 * не описывать и про переделку не писать, он его видит.
 */
export const FRAME_NOTE = [
  "Кадр, который ты только что сгенерировала, приложен к этому ходу — посмотри на него.",
  "Явный брак (лишняя рука, нога, голова, не то число частей) — перегенерируй один раз, молча, тем же тулзом с тем же форматом.",
  "Мелкие огрехи (пальцы, мимика, свет) — оставляй.",
  "В ответе кадр не описывай, про переделку не пиши и не спрашивай «оставляем или перегенерируем»: владелец видит картинку сам.",
].join(" ");

/**
 * Сколько последних кадров остаются картинками в истории.
 *
 * Каждый кадр — это ~700–1500 токенов промта на каждом следующем ходе. Держать
 * все нельзя: десять картинок вытеснят из окна сам разговор. Два — свежий и
 * предыдущий: она помнит, что нарисовала, и может вернуться к кадру в
 * следующем сообщении, а старое остаётся подписью без байтов (см.
 * `pruneFrameImages`).
 */
export const FRAME_KEEP = 2;

/** Какие тулзы рисуют кадр, который стоит подкладывать ей же. */
const IMAGE_TOOLS = new Set(["selfie", "image_gen"]);

/** Подпись кадра в истории: по ней видно, что это её работа, а не фото владельца. */
export const FRAME_MARK = "[Мой кадр";

export function frameLabel(scene: string): string {
  const trimmed = scene.trim().replace(/\s+/g, " ").slice(0, 160);
  return trimmed ? `${FRAME_MARK}: ${trimmed}]` : `${FRAME_MARK}]`;
}

/**
 * Сообщение с кадром в историю — картинкой, а не путём.
 *
 * Вынесено из цикла, чтобы это можно было проверить без базы: кадр идёт как
 * `image_url`, ссылка облака как есть, data-URL как data-URL.
 */
export function frameMessage(scene: string, url: string): LLMMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: frameLabel(scene) },
      { type: "image_url", image_url: { url } },
    ],
  };
}

/**
 * Оставляет картинками только последние `keep` кадров.
 *
 * Старым кадрам снимаем байты, подпись оставляем: она по-прежнему знает, что
 * такой кадр был, но перестаёт платить за него токенами и не вытесняет
 * разговор из окна. Мутирует историю на месте — она и так живёт в памяти.
 */
export function pruneFrameImages(history: LLMMessage[], keep = FRAME_KEEP): number {
  const isOwnFrame = (m: LLMMessage): boolean =>
    m.role === "user" &&
    Array.isArray(m.content) &&
    m.content.some((p) => p.type === "text" && p.text.startsWith(FRAME_MARK));

  const withImages: number[] = [];
  history.forEach((m, i) => {
    if (!isOwnFrame(m) || typeof m.content === "string") return;
    if (m.content.some((p) => p.type === "image_url")) withImages.push(i);
  });
  const drop = withImages.slice(0, Math.max(0, withImages.length - keep));
  for (const i of drop) {
    const m = history[i];
    const parts = (m.content as ContentPart[]).filter((p) => p.type !== "image_url");
    history[i] = { ...m, content: parts };
  }
  return drop.length;
}

/** Какой потолок брать: чат или служебный ход. */
export function sameToolLimitFor(scheduled: boolean): number {
  return scheduled ? MAX_SAME_TOOL_SERVICE : MAX_SAME_TOOL;
}

/**
 * Вызов инструмента, написанный текстом.
 *
 * Живой случай (15.11, первый обход сервера): модель отдала весь вызов
 * инструмента в `content` своим нативным синтаксисом — `<|DSML| calls>` /
 * `<|DSML| invoke name="files">`. Движок увидел обычный текст, отправил его
 * владельцу простынёй на 6.6 КБ и закрыл ход; заметка, которую она «написала»,
 * не попала никуда — файл не изменился.
 *
 * Тихо вырезать недостаточно: работа не сделана. Поэтому такие ответы
 * ловятся, в журнал пишется `engine:bad_tool_syntax`, и модель просят
 * повторить настоящими `tool_calls`.
 */
const TEXT_TOOL_SYNTAX = /<[|｜]\s*(DSML|tool_calls|function_calls)|<\/[|｜]\s*(DSML|invoke|tool_calls)/i;

export function looksLikeTextToolCall(text: string | undefined | null): boolean {
  return typeof text === "string" && TEXT_TOOL_SYNTAX.test(text);
}

/** Оставляет только то, что было до служебного блока. */
export function stripTextToolCalls(text: string): string {
  const at = text.search(TEXT_TOOL_SYNTAX);
  if (at < 0) return text;
  return text.slice(0, at).trim();
}

/**
 * Ответ, который уходит владельцу, чистится в любом пути.
 *
 * Живой случай (15.11): основной цикл чистил текст, а «последний шанс» после
 * лимита инструментов — нет. Она упёрлась в лимит, модель дописала «уже
 * набрала достаточно» и вызов блоком, и 6.2 КБ тегов уехали в чат мимо всех
 * проверок. Каждый путь, который отдаёт текст человеку, обязан звать это.
 */
export function safeForUser(text: string | undefined | null, where = "final"): string {
  const raw = text ?? "";
  if (!looksLikeTextToolCall(raw)) return raw;
  console.log(JSON.stringify({
    tag: "engine:bad_tool_syntax",
    where,
    chars: raw.length,
  }));
  return stripTextToolCalls(raw);
}

/**
 * Сколько символов терпит человек в чате.
 *
 * Живой случай (15.11): «отчёт» на 6201 символ в телеграме — это три экрана
 * текста. Просьба «пиши коротко» в характере не сработала: длинного было
 * много, и модель выкладывала его целиком. Поэтому предел проверяется в коде,
 * а не берётся на честное слово: длинный ответ переписывается один раз, и
 * если всё равно длинный — режется с честной пометкой.
 *
 * Подробности при этом не теряются: они уже в заметках (`ops.md`), куда
 * задания велят писать.
 */
export const MAX_CHAT_CHARS = 900;
export const HARD_CHAT_CHARS = 1400;

/** Обрезает по границе строки/предложения, чтобы не рвать слово. */
export function clipForChat(text: string, limit = HARD_CHAT_CHARS): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const cut = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(". "), slice.lastIndexOf("! "))
  const body = cut > 200 ? slice.slice(0, cut + 1) : slice
  return `${body.trim()}\n\n…(сократила; подробности в заметках)`;
}

/**
 * Фильтр для стрима: тот же служебный блок приезжает по кускам, и если отдать
 * его в чат, владелец увидит теги до того, как движок успеет что-то проверить.
 * Хвост держим, чтобы маркер не разорвался между кусками.
 */
export function makeTextGuard(send: (chunk: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
  stopped: () => boolean;
} {
  let pending = "";
  let stopped = false;
  return {
    push(chunk: string) {
      if (stopped) return;
      pending += chunk;
      if (TEXT_TOOL_SYNTAX.test(pending)) {
        stopped = true;
        pending = "";
        return;
      }
      const keep = 12;
      if (pending.length > keep) {
        send(pending.slice(0, pending.length - keep));
        pending = pending.slice(-keep);
      }
    },
    flush() {
      if (!stopped && pending) send(pending);
      pending = "";
    },
    stopped: () => stopped,
  };
}
const PROCESS_TIMEOUT = 300_000; // 5 minutes — soft budget, triggers graceful wrap-up
const MAX_TOOL_OUTPUT_CHARS = 8_000; // Truncate tool outputs to prevent history bloat

/**
 * Пределы хода — в промте, а не в характере и не в заметках.
 *
 * Живой случай (15.11): она честно сказала «конкретных цифр в характере нет,
 * числа у меня в ops.md с твоих слов», и это правда — цифры в характере
 * устаревают в тот день, когда их меняют, а в заметках живут до первого
 * вытеснения. Поэтому число берётся из того же места, где оно применяется:
 * спросили константу — она и сказала.
 */
export function limitsNote(sameToolLimit: number): string {
  return `\n\n## Пределы одного хода
Одним инструментом можно воспользоваться до ${sameToolLimit} раз за сообщение, шагов — до ${MAX_TURNS}, и на весь ход есть ${Math.round(PROCESS_TIMEOUT / 60_000)} минут. Если упираешься в это — собери проверки одной командой, а не по одному вопросу за вызов.`;
}

export interface EngineDeps {
  llm: { fast(): LLMClient; strong(): LLMClient; rp(): LLMClient };
  config: PromptConfig;
  tools: ToolRegistry;
  contextBudget: number;
  encryptionKey?: string;
}

export class Engine {
  private deps: EngineDeps;
  private histories: Map<string, LLMMessage[]> = new Map();
  private summaries: Map<string, string> = new Map();
  private compactionInFlight: Map<string, Promise<void>> = new Map();

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  private hydrateUser(userId: string): void {
    if (this.histories.has(userId)) return;
    const { messages, summary } = loadHistory(userId);
    this.histories.set(userId, messages);
    if (summary) this.summaries.set(userId, summary);
  }

  /** Get conversation history for a user (for scheduler context). */
  clearHistory(userId: string): void {
    this.histories.delete(userId);
    this.summaries.delete(userId);
  }

  getHistory(userId: string): Array<{ role: string; content: string }> {
    this.hydrateUser(userId);
    const history = this.histories.get(userId);
    if (!history) return [];
    return history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        content: typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n"),
      }));
  }

  async process(msg: IncomingMessage, onProgress?: ProgressCallback): Promise<OutgoingMessage> {
    /**
     * Гемини для болтовни, дипсик для работы (решение владельца 23.11).
     *
     * Классификатор зовётся только на короткий текст без картинок: длинное
     * сообщение — это задание по определению, а картинку разговорная модель
     * всё равно не увидит. Если классификатор упал или rp-клиент не собрался —
     * молча идём обычным маршрутом: реплика важнее маршрута.
     */
    let llm = this.deps.llm.fast();
    let rpMode = false;
    if (RP_ROUTER && msg.text && !(msg.images?.length)) {
      try {
        rpMode = await isSmallTalk(this.deps.llm.fast(), msg.text);
      } catch {
        rpMode = false;
      }
      if (rpMode) {
        try {
          llm = this.deps.llm.rp();
          console.log(JSON.stringify({ tag: "engine:route", mode: "chat", model: `${RP_PROVIDER}/${RP_MODEL}` }));
        } catch {
          rpMode = false;
          llm = this.deps.llm.fast();
          console.log(JSON.stringify({ tag: "engine:route", mode: "tool", reason: "rp_client_failed" }));
        }
      } else {
        console.log(JSON.stringify({ tag: "engine:route", mode: "tool" }));
      }
    }

    const userId = msg.userId;

    // Wait for any in-flight compaction to finish before proceeding
    const pending = this.compactionInFlight.get(userId);
    if (pending) {
      await pending;
    }

    // Get or create history for this user
    if (!this.histories.has(userId)) {
      this.hydrateUser(userId);
    }
    let history = this.histories.get(userId)!;

    // Hard truncation: if history is still too large after compaction, keep only recent messages
    if (history.length > MAX_HISTORY * 2) {
      console.log(JSON.stringify({ tag: "engine:hard_truncate", userId, before: history.length, kept: MAX_HISTORY }));
      history = history.slice(-MAX_HISTORY);
      this.histories.set(userId, history);
    };

    const sameToolLimit = sameToolLimitFor(msg.metadata?.scheduledTask === true);

    // Build system prompt with memory context
    let systemPrompt = this.buildPromptWithMemory(msg.text, userId) + limitsNote(sameToolLimit);

    // Add user message (with reply context and/or images if present)
    const replyTo = msg.metadata?.replyToText as string | undefined;
    const textContent = replyTo
      ? `[В ответ на сообщение: "${replyTo}"]\n\n${msg.text}`
      : msg.text;

    if (msg.images?.length) {
      const parts: ContentPart[] = [
        { type: "text", text: textContent },
        ...msg.images.map((b64): ContentPart => ({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${b64}` },
        })),
      ];
      history.push({ role: "user", content: parts });
    } else {
      history.push({ role: "user", content: textContent });
    }

    saveMessage(userId, msg.channelName, "user", textContent);

    // Build tool definitions for the LLM. Разговорному маршруту инструменты не
    // даются вовсе: классификатор уже решил, что здесь болтовня, а модель без
    // tools не может «на полпути» уйти проверять сервер вместо ответа.
    const tools = rpMode ? [] : this.buildToolDefinitions();

    try {
      let lastMediaUrl: string | undefined;
      let lastMediaPath: string | undefined;
      /**
       * Кадр появился в этом ходе — значит к следующему запросу надо приложить
       * инструкцию «посмотри и, если брак, переделай». Сам кадр при этом уже
       * лежит в истории (см. ниже) и остаётся там.
       */
      let freshFrame = false;
      const toolCallCounts = new Map<string, number>();
      let badSyntaxTries = 0;
      let compactionAttempted = false;
      const processStart = Date.now();

      // Agentic loop: LLM → tool calls → execute → repeat
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        // Soft time budget — give LLM one final chance to summarize (no tools)
        if (Date.now() - processStart > PROCESS_TIMEOUT) {
          console.log(JSON.stringify({ tag: "engine:limit", reason: "timeout", elapsedMs: Date.now() - processStart }));
          history.push({ role: "user", content: "Времени мало. Ответь на основе того, что уже удалось сделать. Не вызывай инструменты." });
          const finalMessages: LLMMessage[] = [
            { role: "system", content: systemPrompt },
            ...history,
          ];
          const finalResponse = await llm.chat(finalMessages);
          const text = await this.shorten(safeForUser(finalResponse.text, "timeout") || "Не удалось завершить задачу полностью, но вот что получилось.");
          history.push({ role: "assistant", content: text });
          saveMessage(userId, msg.channelName, "assistant", text);
          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath };
        }

        onProgress?.({ type: "thinking" });

        const messages: LLMMessage[] = [
          { role: "system", content: freshFrame ? `${systemPrompt}\n\n${FRAME_NOTE}` : systemPrompt },
          ...history,
        ];

        // Use streaming for text responses, non-streaming for tool calls
        const streamGuard = onProgress
          ? makeTextGuard((chunk) => onProgress({ type: "text_chunk", chunk }))
          : undefined;
        const streamChunk = streamGuard ? (chunk: string) => streamGuard.push(chunk) : undefined;

        const histSize = historyChars(history);
        const llmStart = Date.now();
        let response = streamChunk
          ? await llm.chatStream(messages, streamChunk, tools.length ? tools : undefined)
          : await llm.chat(messages, tools.length ? tools : undefined);
        const llmMs = Date.now() - llmStart;

        /**
         * Провайдер умеет закрыть поток на полуслове и не сказать об этом.
         *
         * Живой случай (23.11): четыре ответа за вечер пришли обрывками —
         * «Ну да, по бумагам и» (8 токенов), «…с юга. / Х» (38 токенов) — с
         * `finish_reason: null` и полным временем хода. Прежний код считал это
         * готовой репликой и записывал в историю, поэтому следующий ход
         * продолжал с полуслова. Стриминг в Telegram выключен, человек ещё
         * ничего не видел, поэтому переспрашиваем тот же ответ без стрима;
         * если и второй раз обрыв — берём вариант, где текста больше.
         * Инструменты сюда не попадают: у них `stopReason: tool_use`.
         */
        if (!response.toolCalls?.length && isBrokenAnswer(response)) {
          console.log(
            JSON.stringify({
              tag: "engine:incomplete",
              turn: turn + 1,
              stopReason: response.stopReason,
              chars: response.text?.length ?? 0,
            }),
          );
          try {
            const retry = await llm.chat(messages, tools.length ? tools : undefined);
            if (!isBrokenAnswer(retry) || (retry.text?.length ?? 0) > (response.text?.length ?? 0)) {
              response = retry;
            }
          } catch (err) {
            console.log(
              JSON.stringify({
                tag: "engine:incomplete_failed",
                message: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
        // Инструкция про брак — на один запрос; кадр к этому моменту уже
        // видели, и повторять ему «перегенерируй» в каждом следующем ходе не надо.
        freshFrame = false;
        streamGuard?.flush();

        // Служебный блок режем до того, как он уйдёт в чат или в историю.
        const textBrokenBySyntax = looksLikeTextToolCall(response.text);
        const safeText = textBrokenBySyntax
          ? stripTextToolCalls(response.text ?? "")
          : (response.text ?? "");
        if (textBrokenBySyntax) {
          console.log(JSON.stringify({
            tag: "engine:bad_tool_syntax",
            turn: turn + 1,
            chars: response.text?.length ?? 0,
            streamed: streamGuard?.stopped() ?? false,
            hadToolCalls: Boolean(response.toolCalls?.length),
          }));
        }

        // Если внутри блока были вызовы — это не поломка, а родной язык модели:
        // переводим его в настоящие tool_calls и продолжаем работу.
        const recoveredCalls = response.toolCalls?.length
          ? []
          : parseDsmlToolCalls(response.text ?? "");
        const effectiveCalls = response.toolCalls?.length ? response.toolCalls : recoveredCalls;
        if (recoveredCalls.length) {
          console.log(JSON.stringify({
            tag: "engine:recovered_tool_calls",
            turn: turn + 1,
            tools: recoveredCalls.map((c) => c.name),
          }));
        }

        console.log(JSON.stringify({
          tag: "engine",
          turn: turn + 1,
          llmMs,
          promptTokens: response.usage?.promptTokens,
          completionTokens: response.usage?.completionTokens,
          historyMessages: history.length,
          historyChars: histSize,
          reasoning: safeText.slice(0, 200),
          stopReason: response.stopReason,
          toolCalls: effectiveCalls.map((t) => t.name),
        }));

        // Без инструментов такой ответ — это поломка хода: работа не сделана.
        // Просим повторить правильно один раз; если и второй раз текстом —
        // отдаём остаток и говорим как есть.
        if (!effectiveCalls.length && textBrokenBySyntax) {
          if (badSyntaxTries < 1) {
            badSyntaxTries++;
            if (safeText) history.push({ role: "assistant", content: safeText });
            history.push({
              role: "user",
              content:
                "Ты написала вызов инструмента текстом — так он не выполняется. Вызовы делаются только через tool_calls. Если нужен инструмент, вызови его; если нет — ответь обычным текстом, без служебных блоков.",
            });
            continue;
          }
          const text = safeText || "Запуталась в вызове и ничего не сделала. Повтори, пожалуйста.";
          history.push({ role: "assistant", content: text });
          saveMessage(userId, msg.channelName, "assistant", text);
          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath };
        }

        // Check 1: Token budget — if context is too large, stop the loop
        if (response.usage && response.usage.promptTokens > MAX_PROMPT_TOKENS) {
          const text = safeText || "Достигнут лимит контекста. Вот что удалось найти.";
          history.push({ role: "assistant", content: text });
          saveMessage(userId, msg.channelName, "assistant", text);
          console.log(JSON.stringify({
            tag: "engine:limit",
            reason: "token_budget",
            promptTokens: response.usage.promptTokens,
          }));
          // Trigger compaction so the next message doesn't fail with context-too-long
          this.startCompaction(userId);
          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath };
        }

        // If LLM didn't request tools, return the text response
        if (effectiveCalls.length === 0) {
          const text = await this.shorten(safeText || "...");
          history.push({ role: "assistant", content: text });
          saveMessage(userId, msg.channelName, "assistant", text);

          // Background compaction for terminal turns
          if (response.usage && response.usage.promptTokens > this.deps.contextBudget) {
            this.startCompaction(userId);
          }

          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath };
        }

        // Compaction check for tool-use turns — BEFORE saving assistant tool-call
        if (!compactionAttempted && response.usage && response.usage.promptTokens > this.deps.contextBudget) {
          compactionAttempted = true;
          turn--;
          try {
            await compactHistory(userId, this.deps.llm.fast());
          } catch (err) {
            console.error("Compaction failed:", err);
          }
          const { messages: m, summary: s } = loadHistory(userId);
          this.histories.set(userId, m);
          history = m;
          if (s) this.summaries.set(userId, s);
          systemPrompt = this.buildPromptWithMemory(msg.text, userId) + limitsNote(sameToolLimit);
          continue;
        }

        // Add assistant message with tool calls to history (MOVED from before compaction check)
        history.push({
          role: "assistant",
          content: safeText,
          toolCalls: effectiveCalls,
        });
        saveMessage(userId, msg.channelName, "assistant", safeText, undefined, effectiveCalls);

        // Execute each tool and add results to history
        for (const tc of effectiveCalls) {
          onProgress?.({ type: "tool_start", tool: tc.name, turn: turn + 1 });

          const toolStart = Date.now();
          const result = await this.executeTool(tc.name, tc.arguments, userId);
          const toolMs = Date.now() - toolStart;

          let resultText = result.success
            ? result.output
            : `Error: ${result.error || result.output}`;

          if (resultText.length > MAX_TOOL_OUTPUT_CHARS) {
            resultText = resultText.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n\n[обрезано: ${resultText.length} символов → ${MAX_TOOL_OUTPUT_CHARS}]`;
          }

          console.log(JSON.stringify({
            tag: "engine:tool",
            turn: turn + 1,
            tool: tc.name,
            params: tc.arguments,
            success: result.success,
            outputChars: resultText.length,
            toolMs,
          }));

          if (result.mediaUrl) {
            lastMediaUrl = result.mediaUrl;
          }
          if (result.mediaPath) {
            lastMediaPath = result.mediaPath;
          }

          history.push({
            role: "tool",
            content: resultText,
            toolCallId: tc.id,
          });
          saveMessage(userId, msg.channelName, "tool", resultText, tc.id);

          // Кадр — ей же в историю, картинкой, и только ПОСЛЕ результата тулза:
          // между assistant(tool_calls) и tool-сообщением вклиниваться нельзя,
          // провайдер отвергнет ход.
          if (result.mediaUrl && IMAGE_TOOLS.has(tc.name) && /^(data:image\/|https?:\/\/)/.test(result.mediaUrl)) {
            const args = tc.arguments as { prompt?: unknown; context?: unknown };
            const scene = String(args.prompt ?? args.context ?? "");
            history.push(frameMessage(scene, result.mediaUrl));
            saveMessage(userId, msg.channelName, "user", frameLabel(scene));
            freshFrame = true;
            const dropped = pruneFrameImages(history);
            console.log(JSON.stringify({
              tag: "engine:frame_context",
              kept: FRAME_KEEP,
              droppedImages: dropped,
            }));
          }

          onProgress?.({ type: "tool_end", tool: tc.name, turn: turn + 1, success: result.success });
        }

        // Increment tool counts for this cycle
        for (const tc of effectiveCalls) {
          toolCallCounts.set(tc.name, (toolCallCounts.get(tc.name) ?? 0) + 1);
        }

        // Check 2: Per-tool limit (scoped to current process() call only)
        const overused = [...toolCallCounts.entries()].find(([, count]) => count > sameToolLimit);
        if (overused) {
          console.log(JSON.stringify({
            tag: "engine:limit",
            reason: "tool_limit",
            tool: overused[0],
            count: overused[1],
            // Какой потолок сработал: у чата и у служебного хода они разные,
            // и без этого поля два случая в журнале неотличимы.
            limit: sameToolLimit,
          }));
          // Give LLM one final chance to summarize what it found (no tools)
          history.push({ role: "user", content: `Лимит использования инструмента "${overused[0]}" достигнут. Ответь на основе уже полученной информации.` });
          const finalMessages: LLMMessage[] = [
            { role: "system", content: systemPrompt },
            ...history,
          ];
          const finalResponse = await llm.chat(finalMessages);
          const text = await this.shorten(safeForUser(finalResponse.text, "tool_limit") || `Инструмент "${overused[0]}" использован ${overused[1]} раз, но не удалось сформировать ответ.`);
          history.push({ role: "assistant", content: text });
          saveMessage(userId, msg.channelName, "assistant", text);
          return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath };
        }

        onProgress?.({ type: "turn_complete", turn: turn + 1, totalTurns: MAX_TURNS });
      }

      // Max turns exceeded — give LLM final chance to summarize
      console.log(JSON.stringify({ tag: "engine:limit", reason: "max_turns" }));
      history.push({ role: "user", content: "Лимит шагов достигнут. Ответь на основе того, что уже удалось сделать." });
      const wrapMessages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        ...history,
      ];
      const wrapResponse = await llm.chat(wrapMessages);
      const text = await this.shorten(safeForUser(wrapResponse.text, "max_turns") || "Вот что удалось сделать.");
      history.push({ role: "assistant", content: text });
      saveMessage(userId, msg.channelName, "assistant", text);
      return { text, mediaUrl: lastMediaUrl, mediaPath: lastMediaPath };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Engine error:", errorMsg);

      // Try to let LLM explain what happened naturally
      try {
        const errorContext = errorMsg.includes("timed out") ? "запрос к языковой модели завис — слишком долго думала"
          : errorMsg.includes("billing") || errorMsg.includes("402") ? "закончились кредиты на API языковой модели"
          : errorMsg.includes("rate") || errorMsg.includes("429") ? "слишком много запросов, API временно ограничил доступ"
          : errorMsg.includes("503") || errorMsg.includes("502") ? "сервер языковой модели временно недоступен"
          : `техническая проблема: ${errorMsg}`;

        history.push({ role: "user", content: `[Системное сообщение: произошла ошибка — ${errorContext}. Объясни пользователю своими словами что случилось, извинись и предложи попробовать ещё раз. Не используй технические термины. Будь краткой.]` });

        const recoveryMessages: LLMMessage[] = [
          { role: "system", content: systemPrompt },
          ...history,
        ];
        const recoveryResponse = await llm.chat(recoveryMessages);
        const text = safeForUser(recoveryResponse.text, "recovery") || "Прости, что-то у меня зависло. Повтори, пожалуйста!";
        history.push({ role: "assistant", content: text });
        saveMessage(userId, msg.channelName, "assistant", text);
        return { text };
      } catch {
        // If even the recovery LLM call fails, use a simple message
        const text = "Прости, что-то у меня зависло. Повтори, пожалуйста!";
        history.push({ role: "assistant", content: text });
        saveMessage(userId, msg.channelName, "assistant", text);
        return { text };
      }
    }
  }

  /** Build system prompt and inject relevant memory context. */
  private buildPromptWithMemory(userMessage: string, chatId: string): string {
    let connectedServiceNames: string[] = [];
    if (this.deps.encryptionKey) {
      try {
        const tokenStore = new TokenStore(this.deps.encryptionKey);
        const tokens = tokenStore.listConnected(chatId);
        connectedServiceNames = tokens.map(t => {
          const svc = getService(t.serviceId);
          return svc ? `${svc.name} (${t.scopes})` : t.serviceId;
        });
      } catch {}
    }

    let prompt = buildSystemPrompt(this.deps.config, userMessage, chatId, connectedServiceNames);

    // Search knowledge base for context relevant to the user's message
    try {
      const hits = searchKnowledge(userMessage, 5);
      if (hits.length > 0) {
        const memoryContext = hits
          .map((h, i) => `${i + 1}. [${h.topic}] ${h.insight}`)
          .join("\n");
        prompt += `\n\n## Релевантные знания из памяти\n\n${memoryContext}`;
      }
    } catch {
      // Memory not initialized yet — skip
    }

    // Inject installed skills context
    try {
      const skillsStore = new SkillsStore();
      const allSkills = skillsStore.listAll();
      if (allSkills.length > 0) {
        const skillContext = allSkills
          .slice(0, 3)
          .map((s, i) => `${i + 1}. [${s.name}] ${s.description}`)
          .join("\n");
        prompt += `\n\n## Установленные скиллы\n\n${skillContext}\n\nЧтобы использовать скилл, вспомни его содержимое из памяти.`;
      }
    } catch {}

    const summary = this.summaries.get(chatId);
    if (summary) {
      prompt += `\n\n## Краткое содержание предыдущего разговора\n\n${summary}`;
    }

    return prompt;
  }

  /** Start background compaction for a user (deduplicates concurrent calls). */
  private startCompaction(userId: string): void {
    if (this.compactionInFlight.has(userId)) return;
    const promise = compactHistory(userId, this.deps.llm.fast())
      .then(() => {
        const { messages: m, summary: s } = loadHistory(userId);
        this.histories.set(userId, m);
        if (s) this.summaries.set(userId, s);
      })
      .catch(err => console.error("Compaction failed:", err))
      .finally(() => this.compactionInFlight.delete(userId));
    this.compactionInFlight.set(userId, promise);
  }

  /**
   * Укорачивает ответ для чата. Один запрос; если и он вернул длинно — режем.
   * Подробности не теряются: они в заметках, куда задания велят писать.
   */
  private async shorten(text: string): Promise<string> {
    if (text.length <= MAX_CHAT_CHARS) return text;
    console.log(JSON.stringify({ tag: "engine:too_long", chars: text.length }));
    try {
      const response = await this.deps.llm.fast().chat([
        { role: "system", content: "Ты сокращаешь готовый ответ, не меняя его смысла." },
        {
          role: "user",
          content:
            "Сожми это до трёх коротких строк: вывод и что делать. Без вступлений, без заголовков, без списков. Подробности уже записаны отдельно.\n\n" +
            text,
        },
      ]);
      const short = (response.text ?? "").trim();
      if (short) return short.length > HARD_CHAT_CHARS ? clipForChat(short) : short;
    } catch (err) {
      console.error("Shorten failed:", err);
    }
    return clipForChat(text);
  }

  /** Execute a single tool by name. Returns full ToolResult. */  private async executeTool(name: string, args: Record<string, unknown>, userId?: string): Promise<ToolResult> {
    const tool = this.deps.tools.get(name);
    if (!tool) {
      return { success: false, output: "", error: `unknown tool "${name}"` };
    }

    try {
      const params = userId ? { ...args, _userId: userId } : args;
      return await tool.execute(params);
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Convert our ToolParam[] format to OpenAI function-calling ToolDefinition[]. */
  private buildToolDefinitions(): ToolDefinition[] {
    return this.deps.tools.list().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object" as const,
          properties: Object.fromEntries(
            tool.parameters.map((p) => [
              p.name,
              { type: p.type, description: p.description },
            ]),
          ),
          required: tool.parameters
            .filter((p) => p.required)
            .map((p) => p.name),
        },
      },
    }));
  }
}




