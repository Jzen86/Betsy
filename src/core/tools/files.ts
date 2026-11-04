import { readFile, writeFile, readdir, mkdir } from "node:fs/promises"
import nodePath from "node:path"
import os from "node:os"
import type { Tool, ToolResult } from "./types.js"

/**
 * What she may touch on disk.
 *
 * The tool shipped with no boundary at all: `read` and `write` took any path, which on
 * this install is root's home — including her own config with every API key in it and the
 * database where the conversation lives. The owner's line (04.11): she must not edit code
 * and must not delete. So writing is confined to a vault directory, and the config, the
 * keys and the database are closed for reading as well — not "discouraged", refused.
 *
 * Reading elsewhere stays open on purpose: looking at a log or a document is how she is
 * useful, and the things that must not leak are named here rather than the whole world
 * being fenced off.
 */
const VAULT = nodePath.join(os.homedir(), ".betsy", "files")

function expand(p: string): string {
  return p.startsWith("~/") ? nodePath.join(os.homedir(), p.slice(2)) : p
}

function isSecret(p: string): boolean {
  const abs = nodePath.resolve(expand(p))
  const base = nodePath.basename(abs).toLowerCase()
  if (base === "config.yaml" || base.startsWith("config.yaml.")) return true
  if (base === "auth.json" || base === ".env" || base.startsWith(".env.")) return true
  if (abs.endsWith(".db") || abs.endsWith(".db-wal") || abs.endsWith(".db-shm")) return true
  if (/^id_[a-z0-9]+$/.test(base) || base === "authorized_keys") return true
  if (base.endsWith(".pem") || base.endsWith(".key")) return true
  return false
}

function inVault(p: string): boolean {
  const abs = nodePath.resolve(expand(p))
  return abs === VAULT || abs.startsWith(VAULT + nodePath.sep)
}

export class FilesTool implements Tool {
  name = "files"
  description = "Read, write, or list files. Чтение — где угодно, кроме конфига, ключей и базы; запись — только в ~/.betsy/files."
  parameters = [
    { name: "action", type: "string", description: "Action to perform: read, write, or list", required: true },
    { name: "path", type: "string", description: "File or directory path", required: true },
    { name: "content", type: "string", description: "Content to write (required for write action)" },
  ]

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string | undefined
    const path = params.path as string | undefined

    if (!action || !path) {
      return { success: false, output: "", error: "Missing required parameters: action and path" }
    }

    switch (action) {
      case "read":
        return this.read(path)
      case "write":
        return this.write(path, params.content as string | undefined)
      case "list":
        return this.list(path)
      default:
        return { success: false, output: "", error: `Unknown action: ${action}. Use read, write, or list.` }
    }
  }

  private async read(path: string): Promise<ToolResult> {
    if (isSecret(path)) {
      return { success: false, output: "", error: "Этот файл закрыт: конфиг, ключи и база не читаются." }
    }
    try {
      const data = await readFile(path, "utf-8")
      return { success: true, output: data }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message }
    }
  }

  private async write(path: string, content: string | undefined): Promise<ToolResult> {
    if (content === undefined) {
      return { success: false, output: "", error: "Missing required parameter: content (for write action)" }
    }
    if (isSecret(path) || !inVault(path)) {
      return {
        success: false,
        output: "",
        error: `Писать можно только в ${VAULT}. Конфиг, ключи, база и код закрыты.`,
      }
    }
    await mkdir(nodePath.dirname(nodePath.resolve(expand(path))), { recursive: true }).catch(() => {})
    try {
      await writeFile(path, content, "utf-8")
      return { success: true, output: `Written to ${path}` }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message }
    }
  }

  private async list(path: string): Promise<ToolResult> {
    try {
      const entries = await readdir(path)
      return { success: true, output: entries.join("\n") }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message }
    }
  }
}
