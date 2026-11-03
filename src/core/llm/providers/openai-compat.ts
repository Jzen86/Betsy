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
}

function toOpenAIMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        tool_call_id: m.toolCallId!,
        content:
          typeof m.content === "string"
            ? m.content
            : m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n"),
      };
    }

    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
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
      };
    }

    return {
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    } as OpenAI.ChatCompletionMessageParam;
  });
}

function buildResponse(
  content: string,
  finishReason: string | null,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  usage?: { prompt_tokens: number; completion_tokens: number },
): LLMResponse {
  const stopReason =
    finishReason === "tool_calls" ? "tool_use" : finishReason === "stop" ? "end_turn" : "end_turn";

  return {
    text: content,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    stopReason: toolCalls?.length ? "tool_use" : stopReason,
    usage: usage
      ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
      : undefined,
  };
}

/** A client for any host that speaks the OpenAI chat protocol. */
export function createCompatClient(opts: CompatOptions): LLMClient {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    defaultHeaders: opts.headers,
  });

  return {
    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
      const res = await client.chat.completions.create({
        model: opts.model,
        messages: toOpenAIMessages(messages),
        ...(tools?.length ? { tools } : {}),
      });

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
      const stream = await client.chat.completions.create({
        model: opts.model,
        messages: toOpenAIMessages(messages),
        ...(tools?.length ? { tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
      });

      let text = "";
      let finishReason: string | null = null;
      let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
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
