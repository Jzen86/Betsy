import { describe, it, expect } from "vitest"
import { RestartServiceTool, MIN_INTERVAL_MS } from "../../../src/core/tools/restart-service.js"
import type { CommandRunner } from "../../../src/core/tools/server-status.js"

function fakeSystemd(activeAfterRestart = "active") {
  const calls: string[] = []
  const runner: CommandRunner = async (file, args) => {
    calls.push(`${file} ${args.join(" ")}`.trim())
    if (args[0] === "is-active") return { out: `${activeAfterRestart}\n`, code: 0 }
    return { out: "", code: 0 }
  }
  return { calls, runner }
}

describe("restart_service", () => {
  it("отказывает всему, чего нет в списке — включая попытки подсунуть команду", async () => {
    const { calls, runner } = fakeSystemd()
    const tool = new RestartServiceTool(runner)

    for (const name of ["telemt; reboot", "telemt && rm -rf /", "$(reboot)", "sshd", "", "TELEMT"]) {
      const result = await tool.execute({ name, confirm: true })
      expect(result.success).toBe(false)
      expect(result.error).toContain("не разрешён")
    }

    expect(calls).toEqual([])
  })

  it("без confirm: true ничего не запускает", async () => {
    const { calls, runner } = fakeSystemd()
    const tool = new RestartServiceTool(runner)

    const result = await tool.execute({ name: "telemt" })

    expect(result.success).toBe(false)
    expect(result.error).toContain("confirm")
    expect(calls).toEqual([])
  })

  it("перезапускает ровно один разрешённый сервис и проверяет, что он поднялся", async () => {
    const { calls, runner } = fakeSystemd("active")
    const tool = new RestartServiceTool(runner)

    const result = await tool.execute({ name: "telemt", confirm: true })

    expect(calls).toEqual(["systemctl restart telemt", "systemctl is-active telemt"])
    expect(result.success).toBe(true)
    expect(result.output).toContain("is-active: active")
  })

  it("второй перезапуск в пределах десяти минут отбивает", async () => {
    let now = 1_000_000
    const { calls, runner } = fakeSystemd()
    const tool = new RestartServiceTool(runner, () => now)

    const first = await tool.execute({ name: "telemt", confirm: true })
    expect(first.success).toBe(true)

    now += 60_000
    const second = await tool.execute({ name: "telemt", confirm: true })
    expect(second.success).toBe(false)
    expect(second.error).toContain("подожди")

    // До sleep не дошло: перезапуск был вызван ровно один раз.
    expect(calls.filter((c) => c.startsWith("systemctl restart")).length).toBe(1)

    now += MIN_INTERVAL_MS
    const third = await tool.execute({ name: "telemt", confirm: true })
    expect(third.success).toBe(true)
  })

  it("если сервис не поднялся — это провал с подсказкой, где смотреть", async () => {
    const { runner } = fakeSystemd("failed")
    const tool = new RestartServiceTool(runner)

    const result = await tool.execute({ name: "nginx", confirm: true })

    expect(result.success).toBe(false)
    expect(result.error).toContain("journalctl -u nginx")
  })
})
