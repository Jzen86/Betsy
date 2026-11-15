import { exec } from "node:child_process"
import type { Tool, ToolResult } from "./types.js"
import { checkCommand } from "./command-guard.js"

/**
 * Свободный shell. Подтверждения у него нет и не было: флаг
 * `requiresConfirmation` объявлен в интерфейсе, но движок его не читает
 * (`engine.ts` вызывает `tool.execute()` напрямую), поэтому старый
 * `requiresConfirmation = true` здесь был обещанием, которого никто не
 * выполнял. Флаг убран, чтобы не врать; защита — в `command-guard.ts`,
 * и она про необратимое, а не про «всё опасное».
 */
export class ShellTool implements Tool {
  name = "shell"
  description =
    "Выполнить команду в shell на сервере. Обратимое можно делать сама; необратимое (снос системы, " +
    "разметка диска, перезагрузка, сброс фаервола) инструмент отклонит."
  parameters = [
    { name: "command", type: "string", description: "Команда", required: true },
  ]

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command
    if (typeof command !== "string" || !command.trim()) {
      return { success: false, output: "", error: "Missing required parameter: command" }
    }

    const verdict = checkCommand(command)
    if (!verdict.allowed) {
      return { success: false, output: "", error: `Команда отклонена: ${verdict.why}` }
    }

    return new Promise((resolve) => {
      exec(command, { timeout: 120_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, output: stderr || stdout || "", error: err.message })
        } else {
          resolve({ success: true, output: stdout, error: stderr || undefined })
        }
      })
    })
  }
}
