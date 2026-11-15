import type { ToolUseRequest } from "./types.js"

/**
 * Нативный диалект вызова инструментов у некоторых моделей DeepSeek.
 *
 * Живой случай (15.11, два хода подряд): вместо `tool_calls` по спецификации
 * OpenAI модель отдаёт вызовы текстом, служебными блоками:
 *
 *     <|DSML| calls>
 *     <|DSML| invoke name="files">
 *     <|DSML| parameter name="action">append</|DSML| parameter>
 *     …
 *
 * Шлюз это не переводит, и для движка такой ответ выглядит обычным текстом:
 * работа не делается, а в чат уезжает простыня тегов. Чистить её мало — надо
 * понимать: формат известный и разбирается однозначно.
 *
 * Поэтому такие блоки превращаются в настоящие вызовы инструментов. Это не
 * «исправление модели», а перевод с её родного языка на тот, который движок
 * умеет исполнять.
 */

/** Черта в этом диалекте бывает обычная и полноширинная (｜, U+FF5C). */
function normalize(text: string): string {
  return text.replace(/｜/g, "|")
}

const INVOKE_OPEN = /<\|DSML\| invoke name="([^"]+)">/g
const INVOKE_CLOSE = "</|DSML| invoke>"
const PARAM =
  /<\|DSML\| parameter name="([^"]+)">([\s\S]*?)<\/\|DSML\| parameter>/g

/** Значение параметра: try JSON для чисел/булевых/массивов, иначе строка. */
function coerce(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed
    }
  }
  if (/^[[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed
    }
  }
  return trimmed
}

/** Есть ли в тексте хоть один вызов в этом диалекте. */
export function hasDsmlToolCalls(text: string | null | undefined): boolean {
  if (typeof text !== "string" || !text) return false
  const normalized = normalize(text)
  return /<\|DSML\| invoke name="/.test(normalized)
}

/** Разбирает текстовые вызовы в те, что движок умеет исполнять. */
export function parseDsmlToolCalls(text: string | null | undefined): ToolUseRequest[] {
  if (typeof text !== "string" || !text) return []
  const normalized = normalize(text)
  const calls: ToolUseRequest[] = []

  let match: RegExpExecArray | null
  INVOKE_OPEN.lastIndex = 0
  while ((match = INVOKE_OPEN.exec(normalized)) !== null) {
    const name = match[1]
    const bodyStart = match.index + match[0].length
    const bodyEnd = normalized.indexOf(INVOKE_CLOSE, bodyStart)
    const body = bodyEnd >= 0 ? normalized.slice(bodyStart, bodyEnd) : normalized.slice(bodyStart)

    const args: Record<string, unknown> = {}
    let param: RegExpExecArray | null
    PARAM.lastIndex = 0
    while ((param = PARAM.exec(body)) !== null) {
      args[param[1]] = coerce(param[2])
    }

    calls.push({ id: `dsml_${calls.length + 1}`, name, arguments: args })
    if (bodyEnd < 0) break
    INVOKE_OPEN.lastIndex = bodyEnd + INVOKE_CLOSE.length
  }

  return calls
}

/** Вырезает все служебные блоки, оставляя обычный текст. */
export function stripDsmlBlocks(text: string): string {
  const normalized = normalize(text)
  const start = normalized.search(/<\|DSML\| *(calls|invoke)/)
  if (start < 0) return text
  return normalized.slice(0, start).trim()
}
