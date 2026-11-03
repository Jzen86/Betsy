import OpenAI from "openai";
import type { LLMClient } from "../types.js";
import { createCompatClient } from "./openai-compat.js";

/**
 * OpenRouter, keeping the parts that are OpenRouter's own.
 *
 * The chat protocol moved to `openai-compat.ts` when a second provider appeared: the
 * client is the same everywhere, the *account* is not. Balance, the 402 that means
 * "top up", and the free-model list only exist here, so only here do they apply —
 * pushed onto a host with no balance concept they produce a degradation that never
 * had a cause (the same class of bug the live install hit on 18.10).
 */
export interface OpenRouterOptions {
  apiKey: string;
  model: string;
}

const BILLING_KEYWORDS = [
  "insufficient_quota",
  "credits",
  "billing",
  "payment",
  "exceeded your current quota",
];

/** Check if an error indicates the account balance is exhausted. */
export function isBillingError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status === 402) return true;
  if (err.status === 429 || err.status === 400 || err.status === 403) {
    const msg = (err.message ?? "").toLowerCase();
    return BILLING_KEYWORDS.some((kw) => msg.includes(kw));
  }
  return false;
}

/** Check if an error is a rate limit, transient, or model-not-found (treat as "try next model"). */
export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status === 404) return true; // dead model
  if (err.status === 429 && !isBillingError(err)) return true;
  if (err.status === 408 || err.status === 502 || err.status === 503 || err.status === 504) return true;
  if (err.status === 400 && /provider returned error/i.test(err.message ?? "")) return true;
  return false;
}

export interface BalanceInfo {
  hasBalance: boolean;
  usage: number;
  limit: number;
}

/** Check OpenRouter account balance via API. */
export async function checkBalance(apiKey: string): Promise<BalanceInfo> {
  const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Balance check failed: ${res.status}`);
  const data = (await res.json()) as { data?: { usage?: number; limit?: number | null } };
  const usage = data.data?.usage ?? 0;
  const limit = data.data?.limit ?? null;
  return {
    hasBalance: limit === null || (limit > 0 && usage < limit),
    usage,
    limit: limit ?? 0,
  };
}

export function createOpenRouterClient(opts: OpenRouterOptions): LLMClient {
  return createCompatClient({
    apiKey: opts.apiKey,
    model: opts.model,
    baseURL: "https://openrouter.ai/api/v1",
    headers: {
      "HTTP-Referer": "https://github.com/Aimagine-life/betsy",
      "X-Title": "Betsy",
    },
  });
}
