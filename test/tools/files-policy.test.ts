import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { FilesTool } from "../../src/core/tools/files.js";

/**
 * Where she is allowed to put a file, and what she is not allowed to look at.
 *
 * The tool had no boundary at all: any path, read or write, as root. On this install that
 * includes her own config — every API key in plain text — and the database where the
 * conversation lives. The owner's line (04.11): she must not edit code and must not
 * delete. Writing is confined to the vault; config, keys and DB are refused even for
 * reading, because "she probably won't look" is not a policy.
 */
describe("files policy", () => {
  const tool = new FilesTool();
  const vault = path.join(os.homedir(), ".betsy", "files");
  const probe = path.join(vault, "policy-test.txt");

  it("refuses to read the config with the keys in it", async () => {
    const res = await tool.execute({ action: "read", path: path.join(os.homedir(), ".betsy", "config.yaml") });
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("закрыт");
  });

  it("refuses to read the database", async () => {
    const res = await tool.execute({ action: "read", path: path.join(os.homedir(), ".betsy", "betsy.db") });
    expect(res.success).toBe(false);
  });

  it("refuses to write outside the vault", async () => {
    const outside = path.join(os.tmpdir(), `betsy-should-not-exist-${Date.now()}.txt`);
    const res = await tool.execute({ action: "write", path: outside, content: "x" });
    expect(res.success).toBe(false);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("allows a write inside the vault", async () => {
    try {
      const res = await tool.execute({ action: "write", path: probe, content: "ok" });
      expect(res.success).toBe(true);
      expect(fs.readFileSync(probe, "utf8")).toBe("ok");
    } finally {
      try { fs.unlinkSync(probe); } catch { /* ignore */ }
    }
  });
});
