import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliver } from "../../src/channels/telegram/handlers.js";

/**
 * A grammY `Context` stub: `deliver` only touches the reply* methods and
 * `api.deleteMessage`. What matters here is WHICH method is called, because a
 * document where a photo belongs is exactly the bug this locks.
 */
function fakeCtx() {
  const calls: Array<{ kind: string; caption?: string }> = [];
  const record = (kind: string) => async (_file: unknown, opts?: { caption?: string }) => {
    calls.push({ kind, caption: opts?.caption });
    return { message_id: calls.length };
  };
  const ctx = {
    reply: async (_text: string, _opts?: { parse_mode?: string }) => {
      calls.push({ kind: "text" });
      return { message_id: calls.length };
    },
    replyWithPhoto: record("photo"),
    replyWithDocument: record("document"),
    replyWithVideo: record("video"),
    replyWithAudio: record("audio"),
    replyWithVoice: record("voice"),
    api: { deleteMessage: async () => true },
  };
  return { ctx: ctx as never, calls };
}

const tmpPng = (() => {
  const p = path.join(os.tmpdir(), `betsy-deliver-probe-${process.pid}.png`);
  // Header bytes are enough: `deliver` decides by extension and size, not content.
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return p;
})();

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("deliver", () => {
  it("sends a generated frame as a photo with the text as caption", async () => {
    const { ctx, calls } = fakeCtx();
    await deliver(ctx, { text: "Держи", mediaUrl: PNG_DATA_URL });
    expect(calls.map((c) => c.kind)).toEqual(["photo"]);
    expect(calls[0].caption).toContain("Держи");
  });

  it("sends an image file as a photo, not a document", async () => {
    const { ctx, calls } = fakeCtx();
    await deliver(ctx, { text: "Смотри", mediaPath: tmpPng });
    expect(calls.map((c) => c.kind)).toEqual(["photo"]);
  });

  it("drops the copied file when the frame itself is already attached", async () => {
    // The live failure (19.11): the engine had the picture, she saved it to /tmp
    // and sent that copy through send_file — the document won and the photo was
    // lost. One photo, no attachment.
    const { ctx, calls } = fakeCtx();
    await deliver(ctx, { text: "Держи", mediaUrl: PNG_DATA_URL, mediaPath: tmpPng });
    expect(calls.map((c) => c.kind)).toEqual(["photo"]);
  });

  it("still sends a non-image file as a document", async () => {
    const pdf = path.join(os.tmpdir(), `betsy-deliver-probe-${process.pid}.pdf`);
    fs.writeFileSync(pdf, Buffer.from("%PDF-1.4"));
    try {
      const { ctx, calls } = fakeCtx();
      await deliver(ctx, { text: "Отчёт", mediaPath: pdf });
      expect(calls.map((c) => c.kind)).toEqual(["document"]);
    } finally {
      fs.unlinkSync(pdf);
    }
  });

  it("falls back to text when there is no media at all", async () => {
    const { ctx, calls } = fakeCtx();
    await deliver(ctx, { text: "Просто текст" });
    expect(calls.map((c) => c.kind)).toEqual(["text"]);
  });
});
