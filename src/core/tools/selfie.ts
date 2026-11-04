import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { uploadToFal } from "../fal-upload.js";
import { buildWorkflow, sizeFor, type ComfyClient } from "../comfy.js";

const FAL_ENDPOINT = "https://fal.run/xai/grok-imagine-image/edit";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_DEFAULT_MODEL = "google/gemini-3.1-flash-image";
const OPENROUTER_FALLBACK_MODEL = "google/gemini-2.5-flash-image";

const MIRROR_KEYWORDS = /зеркал|mirror/i;
const DIRECT_KEYWORDS = /селфи у лица|крупн|портрет|лицо крупно|close.?up|portrait/i;

function detectMode(context: string): "mirror" | "direct" | "scene" {
  if (MIRROR_KEYWORDS.test(context)) return "mirror";
  if (DIRECT_KEYWORDS.test(context)) return "direct";
  return "scene";
}

const IDENTITY =
  "IMPORTANT: keep the EXACT same person as in the reference image — same face, facial features, hair color and hairstyle. Do NOT invent a new face.";

/**
 * A frame with her in it — not a phone in her hand.
 *
 * The old template made every selfie a mirror shot or an arm's-length close-up, because
 * the words "taking a mirror selfie" and "phone held at arm's length" were written into
 * the prompt itself. The owner's line (04.11): "постоянно зеркало и вытянутая палка не
 * нужно — нужно «в кадре я»". So the default is now just her in the scene, and the phone
 * appears only if the scene asks for it.
 */
function buildPrompt(context: string, mode: "mirror" | "direct" | "scene"): string {
  if (mode === "mirror") {
    return `${IDENTITY} Using the reference image of this exact woman: she is taking a mirror selfie, ${context}. Realistic photo, natural skin texture.`;
  }
  if (mode === "direct") {
    return `${IDENTITY} Using the reference image of this exact woman: close-up portrait of her, ${context}, looking into the camera, face fully visible, natural and casual, realistic photo.`;
  }
  return `${IDENTITY} Using the reference image of this exact woman: ${context}. She is in the frame — her face and figure visible, the main subject. Realistic photo, natural skin texture, natural pose.`;
}

export interface SelfieToolConfig {
  falApiKey: string;
  referencePhotoUrl?: string;
  /** Which backend generates the selfie. Default "fal". */
  provider?: "fal" | "openrouter";
  /** OpenRouter API key (used when provider === "openrouter"). */
  openrouterApiKey?: string;
  /** OpenRouter model id (default google/gemini-3.1-flash-image). */
  openrouterModel?: string;
  /** Local ComfyUI, tried before anything paid. */
  comfy?: ComfyClient;
}

export class SelfieTool implements Tool {
  name = "selfie";
  description =
    "Фото, на котором ты. Любой кадр с тобой в главной роли: портрет, в полный рост, в сцене — кто и чем снимал, неважно и не указывается. " +
    "Лицо берётся с референса, поэтому его не описывай — описывай сцену: поза, одежда или её отсутствие, место, свет, настроение.";
  parameters = [
    { name: "context", type: "string", description: "Описание сцены (в кафе, в новом платье, на пляже) — по-английски, конкретно и телесно.", required: true },
    { name: "mode", type: "string", description: "Необязательно: mirror — если буквально нужно у зеркала, direct — крупный план. По умолчанию — обычный кадр.", required: false },
  ];

  readonly config: SelfieToolConfig;

  constructor(config: SelfieToolConfig) {
    this.config = config;
  }

  /** Set reference photo path or URL. */
  setReferencePhoto(pathOrUrl: string): void {
    this.config.referencePhotoUrl = pathOrUrl;
  }

  /** Resolve reference to a URL that fal.ai can access. */
  private async resolveFalReferenceUrl(ref: string): Promise<string> {
    if (ref.startsWith("http")) return ref;
    // Local file — upload to fal.ai storage
    const buffer = fs.readFileSync(ref);
    return uploadToFal(buffer, path.basename(ref), this.config.falApiKey);
  }

  /** Convert a local reference file (or URL) into a data URI for OpenRouter. */
  private toDataUrl(ref: string): string {
    if (ref.startsWith("http") || ref.startsWith("data:")) return ref;
    const buf = fs.readFileSync(ref);
    const ext = path.extname(ref).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  }

  private resolveMode(params: Record<string, unknown>, context: string): "mirror" | "direct" | "scene" {
    return params.mode === "mirror" || params.mode === "direct" || params.mode === "scene"
      ? params.mode
      : detectMode(context);
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const context = String(params.context ?? "");
    if (!context) {
      return { success: false, output: "Не указан контекст для селфи", error: "Missing context" };
    }

    const provider = this.config.provider ?? "fal";
    const apiKey = provider === "openrouter" ? this.config.openrouterApiKey : this.config.falApiKey;

    if (!apiKey) {
      return {
        success: false,
        output: provider === "openrouter"
          ? "Для генерации селфи нужен ключ OpenRouter. Сохрани через self_config."
          : "Для генерации селфи нужен API-ключ fal.ai. Попроси пользователя получить ключ на https://fal.ai/dashboard/keys и прислать его тебе. Сохрани через self_config с ключом fal_api_key.",
      };
    }

    if (!this.config.referencePhotoUrl) {
      return {
        success: false,
        output: "Не задано референсное фото. Попроси пользователя отправить своё фото и написать /setphoto.",
      };
    }

    const mode = this.resolveMode(params, context);
    const prompt = buildPrompt(context, mode);

    // Local first: the reference photo goes in as the face and the prompt as the scene.
    // It needs no API key at all, so it is tried before the key check — a frame drawn on
    // the owner's GPU is free, and it is the only path that keeps her face on a spicy
    // request (the hosted model drops a real person's photo as soon as it balks).
    const local = await this.tryComfy(prompt);
    if (local) return local;

    if (provider === "openrouter") {
      return this.generateOpenRouter(prompt, mode);
    }
    return this.generateFal(prompt, mode);
  }

  private async tryComfy(prompt: string): Promise<ToolResult | null> {
    const comfy = this.config.comfy;
    const ref = this.config.referencePhotoUrl;
    if (!comfy || !ref || ref.startsWith("http") || ref.startsWith("data:")) return null;
    try {
      const ext = path.extname(ref) || ".jpg";
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      const referenceName = await comfy.upload(fs.readFileSync(ref), `betsy_selfie${ext}`, mime);
      const { width, height } = sizeFor("3:4");
      const graph = buildWorkflow({ prompt, referenceName, width, height });
      const image = await comfy.generate(graph);
      console.log("📸 Selfie(comfy) OK");
      return { success: true, output: "Селфи сгенерировано", mediaUrl: image };
    } catch (err) {
      console.error(`📸 Selfie: comfy failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async generateFal(prompt: string, mode: "mirror" | "direct" | "scene"): Promise<ToolResult> {
    try {
      const refUrl = await this.resolveFalReferenceUrl(this.config.referencePhotoUrl!);
      console.log(`📸 Selfie(fal): mode=${mode}, ref=${refUrl.slice(0, 80)}`);

      const response = await fetch(FAL_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Key ${this.config.falApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: refUrl,
          prompt,
          num_images: 1,
          output_format: "jpeg",
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`📸 Selfie fal.ai error ${response.status}: ${errText.slice(0, 300)}`);
        return { success: false, output: `Ошибка fal.ai: ${response.status}`, error: errText.slice(0, 300) };
      }

      const data = (await response.json()) as { images?: Array<{ url: string }> };
      const imageUrl = data.images?.[0]?.url;
      if (!imageUrl) {
        console.error("📸 Selfie: no image in fal.ai response", JSON.stringify(data).slice(0, 300));
        return { success: false, output: "fal.ai не вернул изображение", error: "No image in response" };
      }
      console.log(`📸 Selfie(fal) OK: ${imageUrl.slice(0, 80)}`);
      return { success: true, output: "Селфи сгенерировано", mediaUrl: imageUrl };
    } catch (err) {
      console.error(`📸 Selfie exception: ${err instanceof Error ? err.message : err}`);
      return { success: false, output: "Ошибка при генерации селфи", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Extract a generated image from an OpenRouter message (multiple shapes). */
  private extractImage(message: unknown): string | null {
    const m = message as {
      images?: Array<{ image_url?: { url?: string }; url?: string }>;
      content?: string | Array<{ type?: string; image_url?: { url?: string } }> | null;
    } | undefined;
    if (!m) return null;

    const fromImages = m.images?.find((i) => i?.image_url?.url || i?.url);
    if (fromImages) return fromImages.image_url?.url ?? fromImages.url ?? null;

    if (Array.isArray(m.content)) {
      const part = m.content.find((p) => p?.type === "image_url" && p.image_url?.url);
      if (part?.image_url?.url) return part.image_url.url;
    }
    if (typeof m.content === "string") {
      const b64 = m.content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
      if (b64) return b64[0];
    }
    return null;
  }

  private async callOpenRouterModel(
    model: string,
    refUrl: string,
    prompt: string,
    mode: "mirror" | "direct" | "scene",
  ): Promise<{ image?: string; filter?: boolean; error?: string }> {
    console.log(`📸 Selfie(openrouter/${model}): mode=${mode}`);
    try {
      const response = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.openrouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          modalities: ["image", "text"],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: refUrl } },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`📸 Selfie openrouter error ${response.status}: ${errText.slice(0, 200)}`);
        return { error: `OpenRouter ${response.status}` };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: unknown; finish_reason?: string | null }>;
        usage?: { completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      const image = this.extractImage(choice?.message);
      if (image) {
        console.log(`📸 Selfie(openrouter) OK out_tokens=${data.usage?.completion_tokens ?? "?"}`);
        return { image };
      }
      if (choice?.finish_reason === "content_filter") {
        console.error("📸 Selfie: blocked by content filter");
        return { filter: true, error: "content_filter" };
      }
      console.error("📸 Selfie: no image in openrouter response", JSON.stringify(data).slice(0, 200));
      return { error: "no image" };
    } catch (err) {
      console.error(`📸 Selfie openrouter exception: ${err instanceof Error ? err.message : err}`);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async generateOpenRouter(prompt: string, mode: "mirror" | "direct" | "scene"): Promise<ToolResult> {
    const primary = this.config.openrouterModel ?? OPENROUTER_DEFAULT_MODEL;
    const refUrl = this.toDataUrl(this.config.referencePhotoUrl!);

    const first = await this.callOpenRouterModel(primary, refUrl, prompt, mode);
    if (first.image) {
      return { success: true, output: "Селфи сгенерировано", mediaUrl: first.image };
    }
    if (first.filter) {
      return {
        success: false,
        output: "Не вышло: модерация Google заблокировала картинку. Попробуй другой ракурс/описание помягче — или пришли менее откровенный референс.",
      };
    }

    // Fallback model (different provider route often bypasses transient failures)
    const secondary = this.config.openrouterModel ? primary : OPENROUTER_FALLBACK_MODEL;
    const second = await this.callOpenRouterModel(secondary, refUrl, prompt, mode);
    if (second.image) {
      return { success: true, output: "Селфи сгенерировано", mediaUrl: second.image };
    }
    if (second.filter) {
      return {
        success: false,
        output: "Не вышло: модерация Google заблокировала картинку. Попробуй другой ракурс/описание помягче — или пришли менее откровенный референс.",
      };
    }
    return { success: false, output: `OpenRouter не вернул изображение (${second.error ?? first.error ?? "unknown"})` };
  }
}

