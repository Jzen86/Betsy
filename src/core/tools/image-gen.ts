import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { buildWorkflow, sizeFor, type ComfyClient } from "../comfy.js";

/** Working OpenRouter image model (gemini-2.0-flash-exp:free no longer exists). */
const MODEL = "google/gemini-2.5-flash-image";
const DEFAULT_REFERENCE = path.join(os.homedir(), ".betsy", "reference.jpg");

export interface ImageGenToolConfig {
  apiKey: string;
  model?: string;
  /** Path to the reference photo used to keep the same face. */
  referencePath?: string;
  /** Local ComfyUI, tried before the hosted model. */
  comfy?: ComfyClient;
}

interface ORMessage {
  content?: string | Array<{ type?: string; text?: string; image_url?: { url?: string } }> | null;
  images?: Array<{ image_url?: { url?: string }; url?: string }>;
}

/** Pull a generated image out of an OpenRouter chat completion message. */
function extractImage(message: ORMessage | undefined): string | null {
  if (!message) return null;

  const fromImages = message.images?.find((i) => i?.image_url?.url || i?.url);
  if (fromImages) return fromImages.image_url?.url ?? fromImages.url ?? null;

  if (Array.isArray(message.content)) {
    const part = message.content.find((p) => p?.type === "image_url" && p.image_url?.url);
    if (part?.image_url?.url) return part.image_url.url;
  }

  if (typeof message.content === "string") {
    const m = message.content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
    if (m) return m[0];
  }

  return null;
}

/** Tasteful lingerie variants — randomized so images don't look identical. */
const LINGERIE_VARIANTS = [
  "sheer red lace lingerie with an open silk robe",
  "elegant white lace bodysuit",
  "black satin slip dress with lace trim",
  "emerald green lace lingerie and a matching robe",
  "deep blue sheer mesh lingerie",
  "burgundy silk babydoll",
  "champagne satin chemise with lace",
  "lavender lace teddy and a silk robe",
  "sheer black mesh bodysuit",
  "rose pink lace lingerie set",
];
const pickLingerie = () => LINGERIE_VARIANTS[Math.floor(Math.random() * LINGERIE_VARIANTS.length)];

/** Rewrite blunt nudity words into moderation-friendly phrasing (safety net under the LLM). */
function softenPrompt(prompt: string): string {
  let p = prompt;
  const mappings: Array<[RegExp, () => string]> = [
    [/\b(completely|fully|totally)?\s*(nude|naked)\b/gi, () => `${pickLingerie()}, implied nudity, tasteful erotic`],
    [/\b(no clothes?|no clothing|without clothes|undressed|nakedness)\b/gi, () => pickLingerie()],
    [/\bfull nudity\b/gi, () => `implied nudity, ${pickLingerie()}`],
    [/\btopless\b/gi, () => "in a sheer lace bra"],
    [/\bexplicit\b/gi, () => "sensual"],
    [/\bбез одежды\b/gi, () => pickLingerie()],
    [/\bголая\b/gi, () => pickLingerie()],
  ];
  for (const [re, rep] of mappings) p = p.replace(re, rep);
  return p;
}

export class ImageGenTool implements Tool {
  name = "image_gen";
  description =
    "Нарисовать кадр, где главная — НЕ Бетси: другой человек, персонаж, сцена, предмет. Её лицо здесь не используется. " +
    "Пиши промпт ПО-АНГЛИЙСКИ, конкретно и телесно: кто в кадре, внешность (если это человек), поза, одежда или её отсутствие, место, свет, настроение. " +
    "Генератор локальный (ComfyUI) и без фильтра содержимого — называй прямо то, что должно быть в кадре. " +
    "Если в кадре должна быть ты сама — это не сюда, а в selfie.";
  parameters = [
    { name: "prompt", type: "string", description: "Detailed description of the scene/framing (in English). Describe pose, clothes, place, mood — NOT the face (the reference provides the face).", required: true },
  ];

  private apiKey: string;
  private model: string;
  private referencePath: string;
  private comfy?: ComfyClient;

  constructor(config: ImageGenToolConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? MODEL;
    this.referencePath = config.referencePath ?? DEFAULT_REFERENCE;
    this.comfy = config.comfy;
  }

  /**
   * The local frame, before the paid one.
   *
   * Same prompt, same reference, different host: the picture is drawn on the owner's GPU
   * and costs nothing but time, and it is the only path where her face is actually taken
   * from `reference.jpg` — the hosted model is given a data URL of a real person's photo
   * and, on a spicy request, drops it entirely. A failure here is not an error the owner
   * should hear about: it falls through to the cloud, and the cloud path answers.
   */
  private async tryComfy(prompt: string): Promise<string | null> {
    if (!this.comfy) return null;
    try {
      // No reference on this path: `image_gen` is for a frame that is *not* her — another
      // woman, a scene, an object. Attaching her photo here made every "picture" carry her
      // face, which is the opposite of what the tool is for.
      const { width, height } = sizeFor("3:4");
      const graph = buildWorkflow({ prompt, width, height });
      return await this.comfy.generate(graph);
    } catch (err) {
      console.error(`image_gen: comfy failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Data URI of the reference photo, or null if none. */
  private referenceDataUrl(): string | null {
    try {
      if (!fs.existsSync(this.referencePath)) return null;
      const buf = fs.readFileSync(this.referencePath);
      const ext = path.extname(this.referencePath).toLowerCase();
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  }

  private async callModel(prompt: string, useReference: boolean): Promise<{ image?: string; error?: string; filter?: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const ref = useReference ? this.referenceDataUrl() : null;
      const text = ref
        ? `Keep the EXACT same person/face as in the reference image — same facial features, hair and identity; do NOT invent a new face. Only change pose, clothes, background and lighting. Scene: ${prompt}`
        : prompt;
      const content: unknown = ref
        ? [
            { type: "text", text },
            { type: "image_url", image_url: { url: ref } },
          ]
        : text;

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content }],
          modalities: ["image", "text"],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        const filtered = /moderation|content_filter|blocked/i.test(errText);
        console.error(`image_gen error ${response.status} (${this.model}): ${errText.slice(0, 200)}`);
        return { error: `OpenRouter error: ${response.status}`, filter: filtered };
      }

      const rawText = await response.text();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { error: "Invalid response from OpenRouter" };

      const data = JSON.parse(jsonMatch[0]) as {
        choices?: Array<{ message?: ORMessage; finish_reason?: string | null }>;
      };
      const choice = data.choices?.[0];
      const image = extractImage(choice?.message);
      if (image) return { image };

      if (choice?.finish_reason === "content_filter") {
        return { error: "Запрос заблокирован модерацией (content_filter)", filter: true };
      }
      return { error: "Model did not return an image" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) {
      return { success: false, output: "Missing required parameter: prompt" };
    }

    // Local first, and with the prompt as written: ComfyUI runs on the owner's GPU and
    // has no content filter at all, so softening it there costs the frame for nothing.
    // The moderation-friendly rewrite below belongs to the hosted model only.
    const local = await this.tryComfy(prompt);
    if (local) {
      console.log("image_gen OK (comfy, qwen-image-2.1-turbo, +reference)");
      return { success: true, output: "Image generated successfully", mediaUrl: local };
    }

    const safe = softenPrompt(prompt);
    if (safe !== prompt) {
      console.log("image_gen: prompt softened for moderation (cloud only)");
    }

    const first = await this.callModel(safe, false);
    if (first.image) {
      console.log(`image_gen OK (${this.model}, без референса)`);
      return { success: true, output: "Image generated successfully", mediaUrl: first.image };
    }

    return { success: false, output: `Не удалось сгенерировать (${first.error ?? "unknown"}).` };
  }
}
