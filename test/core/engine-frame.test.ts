import { describe, it, expect } from "vitest";
import type { LLMMessage } from "../../src/core/llm/types.js";
import { frameMessage, frameLabel, pruneFrameImages, FRAME_KEEP, FRAME_NOTE } from "../../src/core/engine.js";

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const CLOUD_URL = "https://example.com/frame.jpg";

const parts = (m: LLMMessage) =>
  m.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;

describe("frameMessage", () => {
  it("puts the frame in history as an image, not as a path", () => {
    // She has to see the picture; a path or filename is just more text she
    // cannot open.
    const msg = frameMessage("маяк в шторм", DATA_URL);
    expect(msg.role).toBe("user");
    expect(parts(msg)[1]).toEqual({ type: "image_url", image_url: { url: DATA_URL } });
    expect(parts(msg)[0].text).toContain("маяк в шторм");
  });

  it("keeps a cloud link as a link", () => {
    expect(parts(frameMessage("сцена", CLOUD_URL))[1].image_url?.url).toBe(CLOUD_URL);
  });

  it("labels the frame as hers, so it is not read as a photo from the owner", () => {
    expect(frameLabel("рыжий кот")).toBe("[Мой кадр: рыжий кот]");
    expect(frameLabel("   ")).toBe("[Мой кадр]");
    expect(frameLabel("x".repeat(400)).length).toBeLessThanOrEqual("[Мой кадр: ]".length + 160);
  });

  it("does not carry the redo instruction with it into later turns", () => {
    // FRAME_NOTE is injected into the system prompt for one request; if it was
    // baked into the message, every later message would nag her to redraw.
    for (const p of parts(frameMessage("сцена", DATA_URL))) {
      expect(p.text ?? "").not.toContain("перегенерируй");
    }
    expect(FRAME_NOTE).toContain("перегенерируй один раз");
  });
});

describe("pruneFrameImages", () => {
  const frame = (n: number) => frameMessage(`сцена ${n}`, `${DATA_URL}${n}`);

  it("keeps the last two frames and only their text on the older ones", () => {
    const history: LLMMessage[] = [
      { role: "user", content: "привет" },
      frame(1),
      frame(2),
      frame(3),
      { role: "assistant", content: "готово" },
    ];

    expect(pruneFrameImages(history)).toBe(1);
    const imgs = history.filter((m) => parts(m).some?.((p) => p.type === "image_url"));
    expect(imgs).toHaveLength(FRAME_KEEP);

    // The old frame keeps its label: she still knows such a frame existed.
    const first = parts(history[1]);
    expect(first.some((p) => p.type === "image_url")).toBe(false);
    expect(first[0].text).toContain("сцена 1");
  });

  it("does nothing while the frames fit", () => {
    const history: LLMMessage[] = [frame(1), frame(2)];
    expect(pruneFrameImages(history)).toBe(0);
    expect(history).toHaveLength(2);
    expect(parts(history[0]).some((p) => p.type === "image_url")).toBe(true);
  });

  it("leaves a photo the owner sent untouched", () => {
    // His photos come through the same shape; they are not ours to strip.
    const owner: LLMMessage = {
      role: "user",
      content: [
        { type: "text", text: "смотри" },
        { type: "image_url", image_url: { url: DATA_URL } },
      ],
    };
    const history: LLMMessage[] = [owner, frame(1), frame(2), frame(3)];
    pruneFrameImages(history);
    expect(parts(history[0]).some((p) => p.type === "image_url")).toBe(true);
  });
});
