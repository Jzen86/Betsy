import { describe, it, expect } from "vitest";
import {
  FORMATS,
  resolveFormat,
  sizeFor,
  formatList,
  buildWorkflow,
  type AspectFormat,
} from "../../src/core/comfy.js";

const KEYS = Object.keys(FORMATS) as AspectFormat[];

describe("frame formats", () => {
  it("offers the five frames the owner asked for", () => {
    expect(KEYS).toEqual(["1:1", "3:4", "4:3", "9:16", "16:9"]);
  });

  it("keeps every side a multiple of 32", () => {
    // Qwen-Image 2.1's VAE is /16 and the patch is 2: an odd side gets padded,
    // which silently changes the frame the caller asked for.
    for (const key of KEYS) {
      expect(FORMATS[key].width % 32, `${key} width`).toBe(0);
      expect(FORMATS[key].height % 32, `${key} height`).toBe(0);
    }
  });

  it("keeps every frame above half a megapixel", () => {
    // Under about 0.5 MP Qwen starts to smear; that is exactly why 9:16 and
    // 16:9 take a 1024 long side instead of the 896 the others use.
    for (const key of KEYS) {
      const { width, height } = FORMATS[key];
      expect(width * height, key).toBeGreaterThanOrEqual(500_000);
    }
  });

  it("is portrait/landscape the way the name says", () => {
    expect(FORMATS["3:4"].height).toBeGreaterThan(FORMATS["3:4"].width);
    expect(FORMATS["4:3"].width).toBeGreaterThan(FORMATS["4:3"].height);
    expect(FORMATS["9:16"].height).toBeGreaterThan(FORMATS["9:16"].width);
    expect(FORMATS["16:9"].width).toBeGreaterThan(FORMATS["16:9"].height);
    expect(FORMATS["1:1"].width).toBe(FORMATS["1:1"].height);
  });

  it("falls back to the caller's frame, not silently to 1:1", () => {
    expect(resolveFormat("9:16")).toBe("9:16");
    expect(resolveFormat(" 4:3 ")).toBe("4:3");
    expect(resolveFormat("vertical")).toBe("1:1");
    expect(resolveFormat(undefined)).toBe("1:1");
    expect(resolveFormat("", "3:4")).toBe("3:4");
    expect(resolveFormat("9x16", "3:4")).toBe("3:4");
  });

  it("returns only width and height", () => {
    expect(sizeFor("16:9")).toEqual({ width: 1024, height: 576 });
    expect(Object.keys(sizeFor("1:1"))).toEqual(["width", "height"]);
  });

  it("lists every format for the tool descriptions", () => {
    for (const key of KEYS) expect(formatList()).toContain(key);
  });
});

describe("buildWorkflow", () => {
  it("sizes the empty latent by the requested frame", () => {
    const graph = buildWorkflow({ prompt: "a lighthouse", width: 576, height: 1024 });
    expect(graph["9"].inputs).toMatchObject({ width: 576, height: 1024 });
  });

  it("defaults to the square when no size is given", () => {
    const graph = buildWorkflow({ prompt: "a lighthouse" });
    expect(graph["9"].inputs).toMatchObject({ width: 896, height: 896 });
  });

  it("puts a reference in the flat image1 slot", () => {
    // A nested `images: {image_1: …}` was accepted silently once and drew a
    // stranger; the slot is flat and that is the whole contract.
    const graph = buildWorkflow({ prompt: "her by the sea", referenceName: "betsy_selfie.jpg" });
    expect(graph["5"].class_type).toBe("TextEncodeQwenImageEditPlus");
    expect(graph["5"].inputs.image1).toEqual(["6", 0]);
    expect(graph["6"].inputs.image).toBe("betsy_selfie.jpg");
    expect(graph["5"].inputs).not.toHaveProperty("images");
  });

  it("uses the plain text encoder when there is no reference", () => {
    const graph = buildWorkflow({ prompt: "a lighthouse" });
    expect(graph["5"].class_type).toBe("TextEncodeQwenImage21");
    expect(graph["15"].inputs.negative).toEqual(["5", 1]);
  });
});
