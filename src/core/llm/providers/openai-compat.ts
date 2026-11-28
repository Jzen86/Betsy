import OpenAI from "openai";
import type { LLMClient, LLMMessage, LLMResponse, ToolDefinition, StreamCallback } from "../types.js";

/**
 * One OpenAI-compatible endpoint, whatever is behind it.
 *
 * Betsy shipped with a single client whose base URL was OpenRouter's, written as a
 * literal inside `createOpenRouterClient`. That was true while OpenRouter was the only
 * provider, and it stopped being true the moment a second one appeared — the owner's
 * choice (03.11) is chat through OpenCode Go, images through a local ComfyUI and voice
 * through Google TTS, so at least three hosts now speak the same protocol and differ
 * only in address and headers.
 *
 * The client below is that protocol and nothing else: the caller names the host. The
 * OpenRouter-specific parts (balance endpoint, 402 handling, free-model list) stay in
 * `openrouter.ts`, because those are properties of *that* provider and must not leak
 * onto a host that has no balance at all.
 */
export interface CompatOptions {
  apiKey: string;
  model: string;
  baseURL: string;
  headers?: Record<string, string>;
  /** Extra request fields, e.g. Google's `reasoning_effort`. */
  extraBody?: Record<string, unknown>;
  /**
   * Выкинуть из истории tool-сообщения и tool_calls.
   *
   * Нужно разговорному маршруту: он уходит на модель, которой не дают
   * инструменты, а чужие `tool_call_id` в промпте ломают запрос (400).
   * Оставляем от таких реплик только текст, который модель сказала человеку.
   */
  stripTools?: boolean;
}

export function toOpenAIMessages(
  messages: LLMMessage[],
  stripTools = false,
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];

  for (const m of messages) {
    if (stripTools && m.role === "tool") continue;

    if (stripTools && m.role === "assistant" && m.toolCalls?.length) {
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      if (text.trim()) out.push({ role: "assistant", content: text });
      continue;
    }

    if (m.role === "tool") {
      out.push({
        role: "tool" as const,
        tool_call_id: m.toolCallId!,
        content:
          typeof m.content === "string"
            ? m.content
            : m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n"),
      });
      continue;
    }

    if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant" as const,
        content: typeof m.content === "string" ? m.content : null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      });
      continue;
    }

    out.push({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    } as OpenAI.ChatCompletionMessageParam);
  }

  return out;
}

/**
 * Причина остановки без `finish_reason` — это обрыв, а не ответ.
 *
 * Живой случай (23.11): провайдер закрыл поток на середине слова, финального
 * `finish_reason` не пришло, и прежний код переводил `null` в `end_turn` —
 * владелец получал «Ну да, по бумагам и» как законченную реплику, а движок
 * записывал её в историю. Поэтому неизвестное и пустое теперь `incomplete`,
 * а `length` и `content_filter` перестали притворяться нормальным концом.
 */
export function buildResponse(
  content: string,
  finishReason: string | null,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  usage?: { prompt_tokens: number; completion_tokens: number },
): LLMResponse {
  let stopReason: LLMResponse["stopReason"];
  if (toolCalls?.length || finishReason === "tool_calls" || finishReason === "function_call") {
    stopReason = "tool_use";
  } else if (finishReason === "length") {
    stopReason = "max_tokens";
  } else if (finishReason === "content_filter") {
    stopReason = "filtered";
  } else if (finishReason === "stop" || finishReason === "end_turn") {
    stopReason = "end_turn";
  } else {
    stopReason = "incomplete";
  }

  return {
    text: content,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    stopReason,
    usage: usage
      ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
      : undefined,
  };
}

/**
 * Пишет неудачный запрос в журнал целиком, если владелец включил тумблер.
 *
 * Тело ответа провайдер в ошибку не всегда кладёт («400 status code (no body)» —
 * так Google отвечает на запрос из неподдерживаемого региона), поэтому в
 * журнале остаётся сам запрос: без него разбирать 400 приходилось догадками.
 * Включается `BETSY_LLM_ERROR_LOG=1` в дропине юнита; выключен — молчит.
 */
function logLlmFailure(arg: Record<string, unknown>, err: unknown): void {
  if (process.env.BETSY_LLM_ERROR_LOG !== "1") return;
  let payload = "";
  try {
    payload = JSON.stringify(arg).slice(0, 1200);
  } catch {
    payload = "unserializable";
  }
  const e = err as { status?: number; statusCode?: number; message?: string } | null;
  console.log(
    JSON.stringify({
      tag: "engine:llm_error",
      model: arg.model,
      status: e?.status ?? e?.statusCode ?? null,
      message: String(e?.message ?? err).slice(0, 240),
      payload,
    }),
  );
}

/** A client for any host that speaks the OpenAI chat protocol. */
export function createCompatClient(opts: CompatOptions): LLMClient {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    defaultHeaders: opts.headers,
  });

  /**
   * `tool`-сообщения допустимы только вместе с описанием инструментов.
   *
   * Google-слой отвечает 400 `function_response.name: Cannot find field`, если
   * в истории остался ответ инструмента, а `tools` в запросе не передан
   * (проверено 28.11: тот же запрос без `tools` → 400, с пустым `assistant` → 200).
   * Так бывает на запасном пути: история с вызовами уходит в модель, которой
   * инструменты не дают. Поэтому чистим историю не только по явному
   * `stripTools`, но и всякий раз, когда инструментов в запросе нет.
   */
  const strip = (tools?: ToolDefinition[]): boolean => opts.stripTools === true || !(tools && tools.length > 0);

  return {
    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
      const arg = {
        model: opts.model,
        messages: toOpenAIMessages(messages, strip(tools)),
        ...(tools?.length ? { tools } : {}),
        ...(opts.extraBody ?? {}),
      };

      let res;
      try {
        res = await client.chat.completions.create(arg);
      } catch (err) {
        logLlmFailure(arg as unknown as Record<string, unknown>, err);
        throw err;
      }

      const choice = res.choices[0];
      const message = choice?.message;

      const toolCalls = message?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
      }));

      return buildResponse(
        message?.content ?? "",
        choice?.finish_reason ?? null,
        toolCalls,
        res.usage
          ? { prompt_tokens: res.usage.prompt_tokens, completion_tokens: res.usage.completion_tokens }
          : undefined,
      );
    },

    async chatStream(
      messages: LLMMessage[],
      onChunk: StreamCallback,
      tools?: ToolDefinition[],
    ): Promise<LLMResponse> {
      const arg = {
        model: opts.model,
        messages: toOpenAIMessages(messages, strip(tools)),
        ...(tools?.length ? { tools } : {}),
        ...(opts.extraBody ?? {}),
        stream: true,
        stream_options: { include_usage: true },
      };

      let stream;
      try {
        stream = await client.chat.completions.create(arg);
      } catch (err) {
        logLlmFailure(arg as unknown as Record<string, unknown>, err);
        throw err;
      }
      // `arg` собран переменной, поэтому перегрузка `create` отдаёт объединение
      // «ответ или поток» и TS теряет итератор. Здесь поток по построению.
      const chunks = stream as unknown as AsyncIterable<OpenAI.ChatCompletionChunk>;

      let text = "";
      let finishReason: string | null = null;
      let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of chunks) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          text += delta.content;
          onChunk(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
            }
            const entry = toolCallMap.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
          };
        }
      }

      const toolCalls =
        toolCallMap.size > 0
          ? [...toolCallMap.values()].map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: JSON.parse(tc.args || "{}") as Record<string, unknown>,
            }))
          : undefined;

      return buildResponse(text, finishReason, toolCalls, usage);
    },
  };
}
