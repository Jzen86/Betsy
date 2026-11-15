import { describe, it, expect } from "vitest"
import {
  ServerStatusTool,
  SERVER_STATUS_COMMANDS,
  type CommandRunner,
} from "../../../src/core/tools/server-status.js"

function recordingRunner(out = "ok", code = 0) {
  const calls: string[] = []
  const runner: CommandRunner = async (file, args) => {
    calls.push(`${file} ${args.join(" ")}`.trim())
    return { out, code }
  }
  return { calls, runner }
}

describe("server_status", () => {
  it("принимает не параметры, а только свои фиксированные команды", async () => {
    const tool = new ServerStatusTool()
    expect(tool.parameters).toEqual([])
  })

  it("не даёт вызвать ничего, чего нет в списке", async () => {
    const { calls, runner } = recordingRunner()
    const tool = new ServerStatusTool(runner)

    // Инструмент объявлен без параметров, но модель всё равно может прислать
    // лишние поля — проверяем, что они не доходят до запуска.
    await tool.execute({ command: "rm -rf /", name: "telemt; reboot" } as never)

    expect(calls).toEqual(SERVER_STATUS_COMMANDS)
    expect(calls.join(" ")).not.toContain("rm -rf")
    expect(calls.join(" ")).not.toContain("reboot")
  })

  it("ненулевой код возврата — это ответ команды, а не сбой инструмента", async () => {
    const { runner } = recordingRunner("inactive", 3)
    const tool = new ServerStatusTool(runner)

    const result = await tool.execute()

    expect(result.success).toBe(true)
    expect(result.output).toContain("(exit 3)")
    expect(result.output).toContain("inactive")
  })

  it("режет слишком длинный вывод и говорит, что обрезал", async () => {
    const { runner } = recordingRunner("x".repeat(5_000), 0)
    const tool = new ServerStatusTool(runner)

    const result = await tool.execute()

    expect(result.success).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(9_500)
    expect(result.output).toContain("обрезано")
  })

  it("показывает пустую секцию как «(пусто)», а не пропадает", async () => {
    const { runner } = recordingRunner("", 0)
    const tool = new ServerStatusTool(runner)

    const result = await tool.execute()

    expect(result.output).toContain("(пусто)")
  })
})
