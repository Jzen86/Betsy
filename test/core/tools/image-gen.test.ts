import { describe, it, expect, vi } from "vitest";
import { ImageGenTool } from "../../../src/core/tools/image-gen.js";

describe("ImageGenTool", () => {
  it("has a prompt and a frame parameter", () => {
    const tool = new ImageGenTool({ apiKey: "test" });
    expect(tool.name).toBe("image_gen");
    expect(tool.parameters.map((p) => p.name)).toEqual(["prompt", "format"]);
    expect(tool.parameters[0].required).toBe(true);
    expect(tool.parameters[1].required).toBe(false);
  });

  it("draws the frame the model named, and 3:4 when it named none", async () => {
    const graphs: Array<Record<string, { inputs: Record<string, unknown> }>> = [];
    const comfy = {
      generate: async (graph: Record<string, { inputs: Record<string, unknown> }>) => {
        graphs.push(graph);
        return "data:image/png;base64,AA==";
      },
    };
    const tool = new ImageGenTool({ apiKey: "test", comfy: comfy as never });

    const story = await tool.execute({ prompt: "a lighthouse at dusk", format: "9:16" });
    expect(story.success).toBe(true);
    expect(graphs[0]["9"].inputs).toMatchObject({ width: 576, height: 1024 });

    const square = await tool.execute({ prompt: "a lighthouse at dusk", format: "1:1" });
    expect(square.success).toBe(true);
    expect(graphs[1]["9"].inputs).toMatchObject({ width: 896, height: 896 });

    const plain = await tool.execute({ prompt: "a lighthouse at dusk" });
    expect(plain.success).toBe(true);
    expect(graphs[2]["9"].inputs).toMatchObject({ width: 672, height: 896 });

    const typo = await tool.execute({ prompt: "a lighthouse at dusk", format: "story" });
    expect(typo.success).toBe(true);
    expect(graphs[3]["9"].inputs).toMatchObject({ width: 672, height: 896 });
  });

  it("never attaches her reference photo to a plain picture", async () => {    let graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> | null = null;
    const comfy = {
      generate: async (g: Record<string, { class_type: string; inputs: Record<string, unknown> }>) => {
        graph = g;
        return "data:image/png;base64,AA==";
      },
    };
    const tool = new ImageGenTool({ apiKey: "test", comfy: comfy as never });
    await tool.execute({ prompt: "a lighthouse at dusk" });

    expect(graph!["5"].class_type).toBe("TextEncodeQwenImage21");
    expect(graph!["5"].inputs).not.toHaveProperty("image1");
  });

  it("tells her the frame is already in the chat, so she stops hunting for it", async () => {
    const comfy = { generate: async () => "data:image/png;base64,AA==" };
    const tool = new ImageGenTool({ apiKey: "", comfy: comfy as never, localOnly: true });
    const result = await tool.execute({ prompt: "a lighthouse at dusk" });

    expect(result.success).toBe(true);
    // "Image generated successfully" was the whole reason she ran `find`, copied
    // the PNG to /tmp and sent it again through send_file — as a document.
    expect(result.output).toContain("в чат этим же ответом");
    expect(result.output).toContain("Файла на диске нет");
    expect(result.output).toContain("send_file");
  });

  it("says the generator is down instead of paying for a cloud frame", async () => {
    const comfy = { generate: async () => { throw new Error("fetch failed"); } };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const tool = new ImageGenTool({ apiKey: "sk-or-test", comfy: comfy as never, localOnly: true });
      const result = await tool.execute({ prompt: "a lighthouse at dusk" });

      expect(result.success).toBe(false);
      expect(result.output).toContain("ComfyUI");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
