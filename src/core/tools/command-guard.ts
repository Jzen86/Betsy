/**
 * Защита от необратимого — вместо чёрного списка по подстрокам.
 *
 * Прежняя проверка в `shell.ts` искала в строке четыре подстроки
 * (`rm -rf /`, `mkfs`, `dd if=`, `format`). Она не ловила `rm -rf /*`,
 * `dd of=/dev/sda`, `sh -c "…"`, `find -delete`, `| xargs rm` — и в то же
 * время срабатывала на безобидное `grep "format" README.md`.
 *
 * Здесь команда разбирается на сегменты по `;`, `&&`, `||`, `|` и переводу
 * строки, и каждый сегмент проверяется по **бинарнику и аргументам**, а не
 * по тексту. Задача этой проверки — не «сделать агента безопасным» (умную
 * модель списком не ограничить), а не дать одной опечатке снести машину:
 * `rm -rf /etc`, `dd` на диск, `mkfs`, `shutdown`, `iptables -F`, отключение
 * собственного ssh. Всё остальное — на её усмотрение.
 *
 * Подстановки (`$(...)`, обратные кавычки, `eval`) не разбираются, поэтому
 * команда с ними отклоняется: проверить, что внутри, нельзя, а «наверное,
 * безопасно» — это не проверка.
 */

export interface Verdict {
  allowed: boolean
  why?: string
}

/** Куда `rm -r` и `chmod -R` не должны попадать никогда. */
const PROTECTED_PATHS = [
  "/",
  "/*",
  "/etc",
  "/etc/",
  "/usr",
  "/usr/",
  "/bin",
  "/sbin",
  "/lib",
  "/boot",
  "/var",
  "/var/",
  "/root",
  "/root/",
  "/opt",
  "/opt/",
  "/home",
  "/srv",
  "/dev",
  "/proc",
  "/sys",
]

const FORBIDDEN_BINARIES = new Set(["shutdown", "reboot", "poweroff", "halt", "init", "kexec"])

/** Сегменты команды: режем по управляющим операторам, кавычки не учитываем. */
function splitSegments(command: string): string[] {
  return command
    .split(/\|\||&&|;|\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function tokensOf(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean)
}

function isRecursive(flags: string[]): boolean {
  return flags.some(
    (f) => f === "--recursive" || (f.startsWith("-") && !f.startsWith("--") && /[rR]/.test(f)),
  )
}

function hitsProtected(target: string): boolean {
  const clean = target.replace(/\/+$/, "") || "/"
  return PROTECTED_PATHS.includes(target) || PROTECTED_PATHS.includes(clean)
}

/** Обёртки, за которыми может стоять настоящая команда. */
const WRAPPERS = new Set(["xargs", "sudo", "env", "nohup", "timeout", "nice", "command", "exec", "stdbuf"])
const SHELLS = new Set(["sh", "bash", "dash", "zsh"])

/**
 * Снимает обёртку и возвращает остаток как отдельную команду.
 * `xargs rm -rf /etc` — это `rm -rf /etc`, просто записанный иначе.
 */
function unwrap(tokens: string[]): string | null {
  const bin = (tokens[0].split("/").pop() ?? tokens[0]).toLowerCase()
  if (SHELLS.has(bin)) {
    const cIndex = tokens.indexOf("-c")
    if (cIndex >= 0 && tokens.length > cIndex + 1) {
      return tokens
        .slice(cIndex + 1)
        .join(" ")
        .replace(/^['"]|['"]$/g, "")
    }
    return null
  }
  if (WRAPPERS.has(bin)) {
    // флаги обёртки (`-n 1`) и их значения пропускаем: они не команда
    const rest = tokens.slice(1)
    const firstValue = rest.findIndex((t) => !t.startsWith("-") && !/^\d+$/.test(t))
    return firstValue >= 0 ? rest.slice(firstValue).join(" ") : null
  }
  return null
}

function checkSegment(segment: string): string | null {
  const tokens = tokensOf(segment)
  if (tokens.length === 0) return null

  const inner = unwrap(tokens)
  if (inner) {
    const verdict = checkCommand(inner)
    if (!verdict.allowed) return verdict.why ?? null
  }

  const bin = tokens[0].split("/").pop() ?? tokens[0]

  if (FORBIDDEN_BINARIES.has(bin)) {
    return `«${bin}» перезагружает или гасит машину — это делаю не я.`
  }

  if (bin.startsWith("mkfs") || bin === "fdisk" || bin === "parted" || bin === "wipefs") {
    return `«${bin}» работает с разметкой диска — это необратимо.`
  }

  if (bin === "dd") {
    const target = tokens.find((t) => t.startsWith("of="))
    if (target && /of=\/dev\//.test(target)) {
      return "dd на устройство затрёт диск целиком."
    }
  }

  if (bin === "rm") {
    const flags = tokens.slice(1).filter((t) => t.startsWith("-"))
    const targets = tokens.slice(1).filter((t) => !t.startsWith("-"))
    if (isRecursive(flags)) {
      const bad = targets.find(hitsProtected)
      if (bad) return `rm -r по «${bad}» снесёт систему, а не мусор.`
    }
    if (targets.some((t) => t === "/" || t === "/*")) {
      return "rm по корню — нет."
    }
  }

  if (bin === "chmod" || bin === "chown") {
    const flags = tokens.slice(1).filter((t) => t.startsWith("-"))
    const targets = tokens.slice(1).filter((t) => !t.startsWith("-"))
    if (isRecursive(flags) && targets.some(hitsProtected)) {
      return `${bin} -R по системному пути — права на машине после этого не восстановить.`
    }
  }

  if (bin === "systemctl") {
    const action = tokens[1]
    const units = tokens.slice(2)
    if (["disable", "mask"].includes(action) && units.some((u) => /^(ssh|sshd|telemt)/.test(u))) {
      return `«systemctl ${action} ${units.join(" ")}» отрежет меня от машины или от сервиса.`
    }
  }

  if (bin === "find") {
    if (tokens.includes("-delete")) {
      return "find -delete удаляет без перечисления и без подтверждения — нет."
    }
    if (tokens.includes("-exec") || tokens.includes("-execdir")) {
      return "find -exec запускает команду внутри себя — её содержимое здесь не проверить."
    }
  }

  if (["iptables", "nft", "ip6tables"].includes(bin)) {
    if (tokens.some((t) => t === "-F" || t === "--flush" || t === "flush")) {
      return "сброс фаервола в ноль — машина останется без сети."
    }
  }

  return null
}

/** Вердикт по команде: пускать или объяснить, почему нет. */
export function checkCommand(command: string): Verdict {
  if (/\$\(|`|\beval\b/.test(command)) {
    return {
      allowed: false,
      why: "В команде подстановка ($(...), обратные кавычки или eval) — её содержимое проверить нельзя. Перепиши без неё.",
    }
  }

  for (const segment of splitSegments(command)) {
    const why = checkSegment(segment)
    if (why) return { allowed: false, why }
  }

  return { allowed: true }
}
