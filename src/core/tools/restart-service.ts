import { execFile } from "node:child_process"
import type { Tool, ToolParam, ToolResult } from "./types.js"
import type { CommandOutcome, CommandRunner } from "./server-status.js"

/**
 * Перезапуск сервиса — единственное действие, которое ей разрешено делать
 * самой на сервере. Поэтому границ три, и все три в коде, а не в промте:
 *
 * 1. Имя сервиса сверяется с коротким списком по точному совпадению и уходит
 *    отдельным аргументом в `execFile` — без shell, значит `;`, `|` и `$()`
 *    остаются просто текстом и никуда не попадут.
 * 2. Параметр `confirm: true` обязателен: инструмент меняет состояние машины,
 *    и это должно быть решением, а не побочным эффектом.
 * 3. Между двумя перезапусками ждём `MIN_INTERVAL_MS`. Без этого модель,
 *    увидев «сервис не поднялся», может крутить перезапуск в цикле — и
 *    положить то, что ещё живо.
 *
 * Чего здесь нет намеренно: `stop`, `start`, `disable`, произвольного юнита.
 * Остановить telemt нечем — это и есть «не может быть вредной».
 */

/** Что ей разрешено перезапускать. Список — в коде, не в конфиге. */
export const RESTARTABLE = ["telemt", "nginx"] as const

/** Два перезапуска подряд — это флаппинг, а не обслуживание. */
export const MIN_INTERVAL_MS = 10 * 60 * 1000

export class RestartServiceTool implements Tool {
  name = "restart_service"
  description =
    "Перезапустить сервис telemt или nginx. Только эти два, только с confirm: true, и не чаще " +
    "раза в 10 минут. Сначала посмотри `server_status`: если сервис жив, перезапуск не нужен."
  parameters: ToolParam[] = [
    {
      name: "name",
      type: "string",
      description: "Имя сервиса: telemt или nginx",
      required: true,
    },
    {
      name: "confirm",
      type: "boolean",
      description: "Должно быть true — действие меняет состояние сервера",
      required: true,
    },
  ]

  private lastRestartAt = 0

  constructor(
    private readonly runner: CommandRunner = defaultRunner,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const name = typeof params.name === "string" ? params.name.trim() : ""
    if (!(RESTARTABLE as readonly string[]).includes(name)) {
      return {
        success: false,
        output: "",
        error: `Сервис «${name}» не разрешён. Разрешены: ${RESTARTABLE.join(", ")}.`,
      }
    }

    if (params.confirm !== true) {
      return { success: false, output: "", error: "Нужен confirm: true — это меняет состояние сервера." }
    }

    const now = this.now()
    const left = this.lastRestartAt + MIN_INTERVAL_MS - now
    if (this.lastRestartAt > 0 && left > 0) {
      return {
        success: false,
        output: "",
        error: `Перезапуск уже был — подожди ещё ${Math.ceil(left / 60_000)} мин.`,
      }
    }

    const restart = await this.runner("systemctl", ["restart", name])
    this.lastRestartAt = now

    const state = await this.runner("systemctl", ["is-active", name])
    const active = state.out.trim()
    const ok = active === "active"

    return {
      success: ok,
      output: `systemctl restart ${name}: exit ${restart.code}. is-active: ${active || "нет ответа"}.`,
      ...(ok ? {} : { error: `${name} не поднялся — смотри журнал: journalctl -u ${name} -n 50` }),
    }
  }
}

const defaultRunner: CommandRunner = (file, args) =>
  new Promise<CommandOutcome>((resolve) => {
    execFile(file, args, { timeout: 20_000 }, (err, stdout, stderr) => {
      const raw = String(stdout ?? "")
      const errText = String(stderr ?? "")
      const out = errText ? (raw ? `${raw}\n${errText}` : errText) : raw
      const code =
        err && typeof (err as { code?: unknown }).code === "number"
          ? ((err as { code: number }).code as number)
          : err
            ? 1
            : 0
      resolve({ out, code })
    })
  })

export const restartServiceTool = new RestartServiceTool()
