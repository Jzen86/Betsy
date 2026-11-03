import type { LLMClient, LLMMessage, LLMResponse, ToolDefinition, StreamCallback } from "./types.js";
import { createOpenRouterClient } from "./providers/openrouter.js";
import { isBillingError, isRateLimitError, checkBalance } from "./providers/openrouter.js";
import { createCompatClient } from "./providers/openai-compat.js";

const DEFAULT_FALLBACKS = [
  "openrouter/free",
  "qwen/qwen3-coder:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

/**
 * Hosts that speak the OpenAI chat protocol, by provider name.
 *
 * The address used to be a literal inside the OpenRouter client, which was correct
 * while it was the only provider. The owner's arrangement (03.11) is chat through
 * OpenCode Go, which is a *subscription* gateway at its own path and additionally
 * demands `x-opencode-session`; Google AI Studio serves the same protocol at
 * `/v1beta/openai`. A provider whose address is not listed here can still be used by
 * giving `base_url` in the config — that is what makes the third provider a config
 * line rather than a code change.
 */
const PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  opencode: "https://opencode.ai/inference/go/openai/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

/**
 * `google:gemini-3.5-flash-lite` — a fallback that lives on another provider.
 *
 * A bare name keeps the configured provider, so the old configs read exactly as
 * before. The colon form exists because the chain the owner asked for crosses
 * providers on purpose: two Go models, then two Google ones, and the Google half is
 * what survives when the whole gateway is down.
 */
export function parseModelRef(ref: string, defaultProvider: string): { provider: string; model: string } {
  const idx = ref.indexOf(":");
  if (idx > 0 && idx < ref.length - 1 && !ref.slice(0, idx).includes("/")) {
    return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
  }
  return { provider: defaultProvider, model: ref };
}


const BALANCE_CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes
const FALLBACK_RETRY_DELAY = 1000; // 1 second between fallback attempts (fixed, not exponential)
const PER_MODEL_TIMEOUT = 60_000; // 60 seconds max waiting for first response / between chunks

class ModelTimeoutError extends Error {
  constructor() { super("Model timed out"); }
}

export class LLMUnavailableError extends Error {
  constructor() { super("All LLM models unavailable"); }
}

function withModelTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModelTimeoutError()), PER_MODEL_TIMEOUT);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Streaming timeout that resets on each chunk — keeps alive as long as data flows */
function withStreamingTimeout<T>(
  run: (resetTimer: () => void) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new ModelTimeoutError()), PER_MODEL_TIMEOUT);
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reject(new ModelTimeoutError()), PER_MODEL_TIMEOUT);
    };
    run(resetTimer).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface ProviderAccount {
  api_key?: string;
  base_url?: string;
  headers?: Record<string, string>;
}

export interface LLMRouterConfig {
  provider: string;
  api_key: string;
  fast_model: string;
  strong_model: string;
  fallback_models?: string[];
  /** Keys/addresses for providers other than the default one. */
  providers?: Record<string, ProviderAccount>;
}

export class LLMRouter {
  private readonly config: LLMRouterConfig;
  private readonly fallbackModels: string[];

  // Proxies returned to consumers — created once, delegate internally
  private fastProxy: LLMClient | undefined;
  private strongProxy: LLMClient | undefined;

  // Fallback state
  private _mode: "normal" | "degraded" = "normal";
  private currentFallbackIndex = 0;
  private pendingNotification: string | null = null;
  private balanceCheckTimer: ReturnType<typeof setInterval> | null = null;

  // Current active delegates — swapped on fallback
  private fastDelegate!: LLMClient;
  private strongDelegate!: LLMClient;

  constructor(config: LLMRouterConfig) {
    this.config = config;
    this.fallbackModels = config.fallback_models?.length
      ? config.fallback_models
      : DEFAULT_FALLBACKS;

    // Eagerly init delegates so they are always defined
    this.fastDelegate = this.createClient(config.provider, config.fast_model);
    this.strongDelegate = this.createClient(config.provider, config.strong_model);
  }

  get mode(): "normal" | "degraded" {
    return this._mode;
  }

  fast(): LLMClient {
    if (!this.fastProxy) {
      this.fastProxy = this.createProxy(() => this.fastDelegate);
    }
    return this.fastProxy;
  }

  strong(): LLMClient {
    if (!this.strongProxy) {
      this.strongProxy = this.createProxy(() => this.strongDelegate);
    }
    return this.strongProxy;
  }

  destroy(): void {
    this.stopBalanceCheck();
  }

  private createClient(provider: string, model: string): LLMClient {
    const account = this.config.providers?.[provider];
    const apiKey = account?.api_key ?? (provider === this.config.provider ? this.config.api_key : undefined);
    if (!apiKey) {
      throw new Error(`No API key for LLM provider "${provider}" — add providers.${provider}.api_key`);
    }

    if (provider === "openrouter") {
      return createOpenRouterClient({ apiKey, model });
    }

    const baseURL = account?.base_url ?? PROVIDER_BASE_URLS[provider];
    if (!baseURL) {
      throw new Error(`Unknown LLM provider: ${provider} (no base_url configured)`);
    }

    // OpenCode's gateway routes a conversation by session id and refuses requests
    // without one; a stable id per process is enough for a bot that talks in a chain
    // of turns, and it is what lets the gateway reuse its prompt cache.
    const headers: Record<string, string> = { ...(account?.headers ?? {}) };
    if (provider === "opencode" && !headers["x-opencode-session"]) {
      headers["x-opencode-session"] = `ses_betsy_${Math.random().toString(36).slice(2, 12)}`;
    }

    return createCompatClient({ apiKey, model, baseURL, headers });
  }

  private isRetryable(err: unknown): boolean {
    return isBillingError(err) || isRateLimitError(err) || err instanceof ModelTimeoutError;
  }

  private createProxy(getDelegate: () => LLMClient): LLMClient {
    return {
      chat: async (messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> => {
        // Try each model once: primary + all fallbacks
        const maxAttempts = this.fallbackModels.length + 1;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            const response = await withModelTimeout(getDelegate().chat(messages, tools));
            return this.attachNotification(response);
          } catch (err) {
            if (this.isRetryable(err)) {
              console.log(`⚠️ LLM: attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : err}`);
              await this.handleLLMError(err);
              continue;
            }
            throw err;
          }
        }
        throw new LLMUnavailableError();
      },

      chatStream: async (messages: LLMMessage[], onChunk: StreamCallback, tools?: ToolDefinition[]): Promise<LLMResponse> => {
        // Try each model once: primary + all fallbacks
        const maxAttempts = this.fallbackModels.length + 1;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          let chunksDelivered = false;
          try {
            const response = await withStreamingTimeout((resetTimer) =>
              getDelegate().chatStream(
                messages,
                (chunk) => { chunksDelivered = true; resetTimer(); onChunk(chunk); },
                tools,
              ),
            );
            return this.attachNotification(response);
          } catch (err) {
            if (this.isRetryable(err)) {
              console.log(`⚠️ LLM: stream attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : err}`);
              await this.handleLLMError(err);
              if (!chunksDelivered) continue;
            }
            throw err;
          }
        }
        throw new LLMUnavailableError();
      },
    };
  }

  /**
   * Handle a billing or rate limit error by switching models.
   * Returns true if successfully switched and caller should retry.
   */
  // Note: concurrent requests during fallback transition may race (second call
  // advances fallback index). Acceptable since the agentic loop is sequential.
  private async handleLLMError(err: unknown): Promise<boolean> {
    if (this._mode === "normal") {
      return this.enterDegradedMode(err);
    }

    // Already degraded — try next fallback
    return this.tryNextFallback();
  }

  private enterDegradedMode(err: unknown): boolean {
    this.currentFallbackIndex = 0;
    const model = this.fallbackModels[0];
    if (!model) return false;

    console.log(`⚠️ LLM: переключение на fallback модель: ${model}`);
    this._mode = "degraded";
    this.switchDelegates(model);
    this.pendingNotification = "⚠️ Основная модель не отвечает — временно работаю на запасной.";
    // The balance poll is OpenRouter's: it asks that API whether the account was topped
    // up. On any other provider there is no such endpoint, and polling one that does not
    // exist would keep the router degraded forever for no reason.
    if (isBillingError(err) && this.config.provider === "openrouter") {
      this.startBalanceCheck();
    }
    return true;
  }

  private async tryNextFallback(): Promise<boolean> {
    this.currentFallbackIndex++;
    if (this.currentFallbackIndex >= this.fallbackModels.length) {
      console.log("⚠️ LLM: все fallback модели пройдены, ни одна не ответила");
      throw new LLMUnavailableError();
    }

    const model = this.fallbackModels[this.currentFallbackIndex];
    console.log(`⚠️ LLM: переключение на следующую fallback модель: ${model}`);
    this.switchDelegates(model);
    await new Promise((r) => setTimeout(r, FALLBACK_RETRY_DELAY));
    return true;
  }

  private switchDelegates(ref: string): void {
    const { provider, model } = parseModelRef(ref, this.config.provider);
    const client = this.createClient(provider, model);
    this.fastDelegate = client;
    this.strongDelegate = client;
  }

  private restoreMainModels(): void {
    console.log("✅ LLM: основная модель снова отвечает, возвращаюсь на неё");
    this._mode = "normal";
    this.fastDelegate = this.createClient(this.config.provider, this.config.fast_model);
    this.strongDelegate = this.createClient(this.config.provider, this.config.strong_model);
    this.pendingNotification = "✅ Снова работаю на основной модели.";
    this.stopBalanceCheck();
  }

  private startBalanceCheck(): void {
    if (this.balanceCheckTimer) return;
    this.balanceCheckTimer = setInterval(async () => {
      try {
        const balance = await checkBalance(this.config.api_key);
        if (balance.hasBalance) {
          this.restoreMainModels();
        }
      } catch (err) {
        console.error("LLM: ошибка проверки баланса:", err instanceof Error ? err.message : err);
      }
    }, BALANCE_CHECK_INTERVAL);
    if (this.balanceCheckTimer && typeof this.balanceCheckTimer === "object" && "unref" in this.balanceCheckTimer) {
      (this.balanceCheckTimer as NodeJS.Timeout).unref();
    }
  }

  private stopBalanceCheck(): void {
    if (this.balanceCheckTimer) {
      clearInterval(this.balanceCheckTimer);
      this.balanceCheckTimer = null;
    }
  }

  private attachNotification(response: LLMResponse): LLMResponse {
    if (this.pendingNotification && response.text) {
      const text = this.pendingNotification + "\n\n" + response.text;
      this.pendingNotification = null;
      return { ...response, text };
    }
    return response;
  }
}
