import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SelfieTool } from "../../../src/core/tools/selfie.js";

describe("SelfieTool", () => {
  it("has correct name and parameters", () => {
    const tool = new SelfieTool({ falApiKey: "test", referencePhotoUrl: "https://example.com/photo.jpg" });
    expect(tool.name).toBe("selfie");
    expect(tool.parameters).toHaveLength(3);
    expect(tool.parameters[0].name).toBe("context");
    expect(tool.parameters[0].required).toBe(true);
    expect(tool.parameters[1].name).toBe("mode");
    expect(tool.parameters[1].required).toBe(false);
    expect(tool.parameters[2].name).toBe("format");
    expect(tool.parameters[2].required).toBe(false);
  });

  it("returns error when fal_api_key is missing", async () => {
    const tool = new SelfieTool({ falApiKey: "", referencePhotoUrl: "https://example.com/photo.jpg" });
    const result = await tool.execute({ context: "в кафе" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("fal.ai");
  });

  it("returns error when reference photo is missing", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "" });
    const result = await tool.execute({ context: "в кафе" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("фото");
  });

  it("detects mirror mode from keywords", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "перед зеркалом в новом платье" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toContain("mirror selfie");

    vi.unstubAllGlobals();
  });

  it("detects direct mode from keywords", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "крупный план, в кафе с кофе" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toContain("close-up portrait");

    vi.unstubAllGlobals();
  });

  it("returns mediaUrl on success", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    }));

    const result = await tool.execute({ context: "на пляже" });
    expect(result.success).toBe(true);
    expect(result.mediaUrl).toBe("https://fal.media/result.jpg");

    vi.unstubAllGlobals();
  });

  it("respects explicit mode parameter", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "просто так", mode: "mirror" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toContain("mirror selfie");

    vi.unstubAllGlobals();
  });

  it("handles API errors gracefully", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    }));

    const result = await tool.execute({ context: "тест" });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    vi.unstubAllGlobals();
  });

  it("asks the local graph for the frame the model named", async () => {
    const ref = path.join(os.tmpdir(), `betsy-selfie-ref-${process.pid}.jpg`);
    fs.writeFileSync(ref, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const graphs: Array<Record<string, { inputs: Record<string, unknown> }>> = [];
    const comfy = {
      upload: async () => "betsy_selfie.jpg",
      generate: async (graph: Record<string, { inputs: Record<string, unknown> }>) => {
        graphs.push(graph);
        return "data:image/png;base64,AA==";
      },
    };

    try {
      const tool = new SelfieTool({
        falApiKey: "",
        referencePhotoUrl: ref,
        comfy: comfy as never,
      });

      const wide = await tool.execute({ context: "на пляже", format: "16:9" });
      expect(wide.success).toBe(true);
      expect(graphs[0]["9"].inputs).toMatchObject({ width: 1024, height: 576 });
      expect(graphs[0]["5"].inputs.image1).toEqual(["6", 0]);

      // No format at all — a selfie is a standing woman, so 3:4, not a square.
      const byDefault = await tool.execute({ context: "на пляже" });
      expect(byDefault.success).toBe(true);
      expect(graphs[1]["9"].inputs).toMatchObject({ width: 672, height: 896 });

      // A name the model made up lands on the same default instead of 1:1.
      await tool.execute({ context: "на пляже", format: "панорама" });
      expect(graphs[2]["9"].inputs).toMatchObject({ width: 672, height: 896 });
    } finally {
      fs.unlinkSync(ref);
    }
  });

  it("says the selfie is on its way, so she stops hunting for the file", async () => {
    const ref = path.join(os.tmpdir(), `betsy-selfie-ref2-${process.pid}.jpg`);
    fs.writeFileSync(ref, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    try {
      const comfy = {
        upload: async () => "betsy_selfie.jpg",
        generate: async () => "data:image/png;base64,AA==",
      };
      const tool = new SelfieTool({ falApiKey: "", referencePhotoUrl: ref, comfy: comfy as never, localOnly: true });
      const result = await tool.execute({ context: "на пляже" });

      expect(result.success).toBe(true);
      expect(result.output).toContain("в чат этим же ответом");
      expect(result.output).toContain("send_file");
    } finally {
      fs.unlinkSync(ref);
    }
  });

  it("does not reach for a paid provider when the local drawer is down", async () => {
    const ref = path.join(os.tmpdir(), `betsy-selfie-ref3-${process.pid}.jpg`);
    fs.writeFileSync(ref, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const comfy = {
        upload: async () => "betsy_selfie.jpg",
        generate: async () => { throw new Error("fetch failed"); },
      };
      const tool = new SelfieTool({
        falApiKey: "",
        openrouterApiKey: "sk-or-test",
        provider: "openrouter",
        referencePhotoUrl: ref,
        comfy: comfy as never,
        localOnly: true,
      });
      const result = await tool.execute({ context: "на пляже" });

      expect(result.success).toBe(false);
      expect(result.output).toContain("ComfyUI");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      fs.unlinkSync(ref);
    }
  });
});
