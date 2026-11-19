import { describe, it, expect } from "vitest";
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

  it("never attaches her reference photo to a plain picture", async () => {
    let graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> | null = null;
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
});
