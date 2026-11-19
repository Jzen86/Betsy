import { describe, it, expect } from "vitest";
import { framePreviewMessage, FRAME_NOTE } from "../../src/core/engine.js";

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const CLOUD_URL = "https://example.com/frame.jpg";

describe("framePreviewMessage", () => {
  it("attaches the frame as an image part, not as a path in text", () => {
    // The whole point: she has to see the picture. A path or a filename would
    // be just more text, and the model cannot open files.
    const msg = framePreviewMessage([DATA_URL]);
    expect(msg?.role).toBe("user");
    const parts = msg!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: DATA_URL } });
    expect(parts[0].text).toBe(FRAME_NOTE);
  });

  it("keeps a cloud link as a link", () => {
    const msg = framePreviewMessage([CLOUD_URL]);
    const parts = msg!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[1].image_url?.url).toBe(CLOUD_URL);
  });

  it("sends both frames of a turn in the order they were drawn", () => {
    const second = `${DATA_URL}AA==`;
    const msg = framePreviewMessage([DATA_URL, second]);
    const parts = msg!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.filter((p) => p.type === "image_url").map((p) => p.image_url?.url)).toEqual([
      DATA_URL,
      second,
    ]);
  });

  it("adds nothing when no frame was drawn", () => {
    expect(framePreviewMessage([])).toBeUndefined();
  });

  it("tells her what to do with a broken frame without narrating it", () => {
    // The owner's rules (16.10): gross breakage — redo once, silently; small
    // flaws — keep; and do not turn the reply into a review of the picture.
    expect(FRAME_NOTE).toContain("перегенерируй один раз");
    expect(FRAME_NOTE).toContain("не описывай");
  });
});
