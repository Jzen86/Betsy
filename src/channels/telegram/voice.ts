import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash-lite-tts";
const GEMINI_DEFAULT_VOICE = "Aoede";

/** Convert arbitrary audio bytes to OGG/Opus (Telegram voice note format) via ffmpeg. */
function toOggOpus(buffer: Buffer, mimeType: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const mt = (mimeType || "").toLowerCase();
    const isWav = buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF";
    const rate = /rate=(\d+)/.exec(mt)?.[1] ?? "24000";

    const args = ["-hide_banner", "-loglevel", "error"];
    // Raw PCM (Gemini preview TTS) has no container — describe it for ffmpeg.
    if (!isWav && (mt.includes("l16") || mt.includes("pcm") || mt.includes("wav"))) {
      args.push("-f", "s16le", "-ar", rate, "-ac", "1");
    }
    args.push("-i", "pipe:0", "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1", "-f", "ogg", "pipe:1");

    let ff;
    try {
      ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.on("error", () => resolve(null));
    ff.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
    ff.stdin.on("error", () => { /* ignore EPIPE */ });
    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

/** Convert arbitrary audio bytes to MP3 (a plain audio file, not a voice note). */
function toMp3(buffer: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", "96k", "-f", "mp3", "pipe:1"];
    let ff;
    try {
      ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.on("error", () => resolve(null));
    ff.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
    ff.stdin.on("error", () => { /* ignore EPIPE */ });
    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

/** Synthesize speech as raw provider bytes (kept for backwards compatibility). */
export async function synthesizeSpeech(
  text: string,
  voiceConfig: Record<string, unknown>,
  falApiKey?: string,
  style?: string,
): Promise<Buffer | null> {
  const provider = (voiceConfig.tts_provider as string) ?? "openai";
  if (provider === "gemini") {
    const raw = await synthesizeGemini(text, voiceConfig, style);
    return raw ? raw.buffer : null;
  }
  if (provider === "minimax") {
    return synthesizeMiniMax(text, voiceConfig, falApiKey);
  }
  return synthesizeOpenAI(text, voiceConfig);
}

/**
 * Подача голоса — отдельным запросом к `interactions`.
 *
 * `generateContent` умеет только голос, но не «как сказать»: шёпот, смех,
 * усталость в нём не передаются, и владелец просил именно этого. У нового
 * эндпоинта стиль идёт аннотацией `speech_metadata`. Он молодой и может
 * отвалиться (429/404), поэтому он первый, а обычный `generateContent` —
 * второй попыткой в той же цепочке: без стиля, но с голосом.
 */
async function geminiInteractions(
  model: string,
  apiKey: string,
  text: string,
  voiceName: string,
  style?: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const content: Record<string, unknown> = { type: "text", text };
    if (style) content.annotations = [{ type: "speech_metadata", style }];

    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ type: "user_input", content: [content] }],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: voiceName }] },
      }),
    });

    if (!res.ok) {
      const why = res.status === 429 ? "quota" : String(res.status);
      console.log(JSON.stringify({ tag: "voice:interactions_fail", model, status: res.status, why }));
      return null;
    }

    const data = (await res.json()) as {
      steps?: Array<{
        content?: Array<{ type?: string; data?: string; mime_type?: string }>;
      }>;
    };
    for (const step of data.steps ?? []) {
      for (const part of step.content ?? []) {
        if (part.data && (part.type === "audio" || part.mime_type)) {
          return { buffer: Buffer.from(part.data, "base64"), mimeType: part.mime_type ?? "audio/wav" };
        }
      }
    }
    return null;
  } catch (err) {
    console.log(JSON.stringify({ tag: "voice:interactions_error", model, error: String(err).slice(0, 100) }));
    return null;
  }
}

/** Gemini TTS via Google AI Studio (generateContent + AUDIO modality). */
async function geminiGenerateContentStyled(
  model: string,
  apiKey: string,
  text: string,
  voiceName: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(JSON.stringify({ tag: "voice:tts_fail", model, status: res.status, body: body.slice(0, 100) }));
      return null;
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
    };
    for (const c of data.candidates ?? []) {
      for (const p of c.content?.parts ?? []) {
        if (p.inlineData?.data) {
          return {
            buffer: Buffer.from(p.inlineData.data, "base64"),
            mimeType: p.inlineData.mimeType ?? "audio/wav",
          };
        }
      }
    }
    return null;
  } catch (err) {
    console.log(JSON.stringify({ tag: "voice:tts_error", model, error: String(err).slice(0, 100) }));
    return null;
  }
}

/**
 * Голос по всем моделям и всем ключам, пока хоть одна не ответит.
 *
 * Ключей может быть несколько (`gemini_api_keys`), как и моделей
 * (`gemini_models`): бесплатный тир считает запросы, и один ключ с лимитом
 * RPM — это «голос есть утром и нет вечером». Перебор идёт по модели, внутри
 * по ключам, потому что разные модели упираются в разные лимиты.
 */
async function synthesizeGemini(
  text: string,
  voiceConfig: Record<string, unknown>,
  style?: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const voiceName = (voiceConfig.voice_id as string) ?? GEMINI_DEFAULT_VOICE;

  const keys: string[] =
    Array.isArray(voiceConfig.gemini_api_keys) && voiceConfig.gemini_api_keys.length
      ? (voiceConfig.gemini_api_keys as unknown[]).filter(
          (k): k is string => typeof k === "string" && k.trim().length > 0,
        )
      : [(voiceConfig.gemini_api_key ?? voiceConfig.google_api_key) as string | undefined].filter(
          (k): k is string => Boolean(k),
        );
  if (!keys.length) return null;

  const chain = [
    ...(Array.isArray(voiceConfig.gemini_models) ? (voiceConfig.gemini_models as unknown[]) : []),
    (voiceConfig.gemini_model as string) ?? GEMINI_DEFAULT_MODEL,
  ].filter((m): m is string => typeof m === "string" && m.length > 0);
  const models = [...new Set(chain)];

  for (const model of models) {
    for (const key of keys) {
      const styled = await geminiInteractions(model, key, text, voiceName, style);
      if (styled) {
        console.log(JSON.stringify({ tag: "voice:tts_ok", model, style: style ?? null, via: "interactions" }));
        return styled;
      }
      const plain = await geminiGenerateContentStyled(model, key, text, voiceName);
      if (plain) {
        console.log(JSON.stringify({ tag: "voice:tts_ok", model, style: null, via: "generateContent" }));
        return plain;
      }
    }
  }
  return null;
}

async function synthesizeMiniMax(
  text: string,
  voiceConfig: Record<string, unknown>,
  falKey?: string,
): Promise<Buffer | null> {
  if (!falKey) return null;

  const voiceId = (voiceConfig.voice_id as string) ?? "Calm_Woman";
  const speed = (voiceConfig.speed as number) ?? 1.0;
  const pitch = (voiceConfig.pitch as number) ?? 0;
  const emotion = (voiceConfig.emotion as string) ?? "happy";

  try {
    const body: Record<string, unknown> = {
      text,
      voice_setting: { voice_id: voiceId, speed, pitch, vol: 1, emotion },
      output_format: "url",
    };

    const norm = voiceConfig.normalization as Record<string, unknown> | undefined;
    if (norm?.enabled) {
      body.normalization_setting = {
        enabled: true,
        target_loudness: norm.target_loudness ?? -18,
        target_range: norm.target_range ?? 8,
        target_peak: norm.target_peak ?? -0.5,
      };
    }

    const mod = voiceConfig.voice_modify as Record<string, unknown> | undefined;
    if (mod) {
      (body.voice_setting as Record<string, unknown>).voice_modify = {
        pitch: mod.pitch ?? 0,
        intensity: mod.intensity ?? 0,
        timbre: mod.timbre ?? 0,
      };
    }

    const res = await fetch("https://fal.run/fal-ai/minimax/speech-02-hd", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, unknown>;
    const audioUrl = (data.audio as Record<string, unknown>)?.url as string | undefined;
    if (!audioUrl) return null;

    const audioRes = await fetch(audioUrl);
    return Buffer.from(await audioRes.arrayBuffer());
  } catch {
    return null;
  }
}

async function synthesizeOpenAI(
  text: string,
  voiceConfig: Record<string, unknown>,
): Promise<Buffer | null> {
  const apiKey = voiceConfig.openai_key as string | undefined;
  if (!apiKey) return null;

  const voiceId = (voiceConfig.voice_id as string) ?? "nova";

  try {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey });
    const response = await client.audio.speech.create({
      model: "tts-1",
      voice: voiceId as "alloy",
      input: text.slice(0, 4096),
      response_format: "opus",
    });

    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/** Synthesize text to OGG/Opus bytes for any configured provider (gemini/minimax/openai). */
export async function synthesizeVoiceOgg(
  text: string,
  voiceConfig: Record<string, unknown>,
  falApiKey?: string,
  style?: string,
): Promise<Buffer | null> {
  const provider = (voiceConfig.tts_provider as string) ?? "openai";
  if (provider === "gemini") {
    const raw = await synthesizeGemini(text, voiceConfig, style);
    if (!raw) return null;
    return toOggOpus(raw.buffer, raw.mimeType);
  }
  if (provider === "minimax") {
    const mp3 = await synthesizeMiniMax(text, voiceConfig, falApiKey);
    if (!mp3) return null;
    return toOggOpus(mp3, "audio/mpeg");
  }
  // OpenAI TTS with response_format=opus already yields OGG/Opus
  return synthesizeOpenAI(text, voiceConfig);
}

/** Send a voice response through a grammY context. Always delivers real OGG/Opus. */
export async function sendVoiceResponse(
  ctx: {
    replyWithVoice: (file: unknown) => Promise<unknown>;
    replyWithAudio?: (file: unknown) => Promise<unknown>;
  },
  text: string,
  voiceConfig: Record<string, unknown>,
  falApiKey?: string,
): Promise<boolean> {
  const ogg = await synthesizeVoiceOgg(text, voiceConfig, falApiKey);
  if (!ogg) return false;

  const tmpFile = path.join(os.tmpdir(), `betsy-tts-${Date.now()}.ogg`);
  try {
    fs.writeFileSync(tmpFile, ogg);
    const { InputFile } = await import("grammy");
    await ctx.replyWithVoice(new InputFile(tmpFile));
    return true;
  } catch (err) {
    // Telegram refuses voice notes for an account whose privacy setting bars them —
    // `VOICE_MESSAGES_FORBIDDEN`, and it hits *every* bot at once, so it is not a sign
    // that anything is broken here. What must not happen is the line being lost: the
    // same audio is re-containerised as an MP3 and sent as a file, which is still
    // something to listen to. Measured on the live install (04.11): the OGG failed for
    // both bots, the MP3 went through in one call.
    console.error("voice: replyWithVoice failed:", err instanceof Error ? err.message : err);
    const mp3 = await toMp3(ogg);
    if (!mp3 || !ctx.replyWithAudio) return false;
    const mp3File = path.join(os.tmpdir(), `betsy-tts-${Date.now()}.mp3`);
    try {
      fs.writeFileSync(mp3File, mp3);
      const { InputFile } = await import("grammy");
      await ctx.replyWithAudio(new InputFile(mp3File));
      return true;
    } catch (e2) {
      console.error("voice: replyWithAudio failed too:", e2 instanceof Error ? e2.message : e2);
      return false;
    } finally {
      try { fs.unlinkSync(mp3File); } catch { /* ignore */ }
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
