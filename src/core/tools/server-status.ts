import { execFile } from "node:child_process"
import type { Tool, ToolParam, ToolResult } from "./types.js"

/**
 * Проверка сервера — без свободного shell.
 *
 * Почему именно так. Свободная строка команды означает, что выполнить можно
 * что угодно, а единственной защитой остаётся чёрный список — и он обходится
 * одной конструкцией (`sh -c`, `find -delete`, `| xargs rm`, `curl -T`).
 * Поэтому здесь команда не приходит от модели вообще: набор собран в коде,
 * каждая строка — фиксированные argv, которые уходят в `execFile` без shell.
 * Сделать что-то, чего нет в списке, этим инструментом нельзя, поэтому ему
 * не нужно подтверждение: он ничего не меняет.
 *
 * Цена решения: новый пункт проверки — это правка этого файла и перезапуск,
 * а не новая строка в конфиге. Это осознанно: конфиг правит и модель
 * (`self_config`), а список команд, которые она умеет запускать, — нет.
 */

interface Check {
  title: string
  file: string
  args: string[]
}

/** Фиксированный набор проверок. Ничего из этого не пишет на диск. */
const CHECKS: Check[] = [
  { title: "Юниты", file: "systemctl", args: ["is-active", "telemt", "nginx", "ssh", "cron"] },
  { title: "Упавшие юниты", file: "systemctl", args: ["--failed", "--no-pager", "--no-legend"] },
  { title: "Диск", file: "df", args: ["-h", "/"] },
  { title: "Память", file: "free", args: ["-m"] },
  { title: "Аптайм и нагрузка", file: "uptime", args: [] },
  { title: "Слушающие порты", file: "ss", args: ["-ltn"] },
  {
    title: "Ошибки telemt за сутки",
    file: "journalctl",
    args: ["-u", "telemt", "-p", "warning", "--since", "1 day ago", "--no-pager", "-n", "60"],
  },
  { title: "Обновления", file: "apt", args: ["list", "--upgradable"] },
]

const PER_COMMAND_TIMEOUT_MS = 10_000
const MAX_SECTION_CHARS = 1_800
const MAX_TOTAL_CHARS = 9_000

export interface CommandOutcome {
  out: string
  code: number
}

/** Запуск одной команды без shell. Вынесено, чтобы тест мог подменить запуск. */
export type CommandRunner = (file: string, args: string[]) => Promise<CommandOutcome>

const execFileRunner: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: PER_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
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
      },
    )
  })

function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n… (обрезано, всего ${trimmed.length} символов)`
}

export class ServerStatusTool implements Tool {
  name = "server_status"
  description =
    "Проверить сервер: состояние юнитов, упавшие сервисы, диск, память, нагрузку, слушающие порты, " +
    "ошибки telemt за сутки и доступные обновления. Ничего не меняет и параметров не принимает — " +
    "набор проверок фиксирован. Используй для планового осмотра и когда нужно понять, что с машиной."
  parameters: ToolParam[] = []

  constructor(private readonly runner: CommandRunner = execFileRunner) {}

  /** Аргументы не читаются вообще: инструмент не даёт модели влиять на команды. */
  async execute(): Promise<ToolResult> {
    const sections: string[] = []

    for (const check of CHECKS) {
      const { out, code } = await this.runner(check.file, check.args)
      const body = clip(out, MAX_SECTION_CHARS)
      const mark = code === 0 ? "" : ` (exit ${code})`
      sections.push(`### ${check.title}${mark}\n${body || "(пусто)"}`)
    }

    return { success: true, output: clip(sections.join("\n\n"), MAX_TOTAL_CHARS) }
  }
}

export const serverStatusTool = new ServerStatusTool()

/** Только для тестов: список команд, которые инструмент вправе запускать. */
export const SERVER_STATUS_COMMANDS = CHECKS.map((c) => `${c.file} ${c.args.join(" ")}`.trim())
