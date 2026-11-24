import type { ToolUseRequest } from "./types.js"

/**
 * Вызов инструмента, написанный обычным текстом — в квадратных скобках.
 *
 * Живой случай (24.11, 14:02 и 14:04): болталка (Гемини) инструментов не
 * получает, но персонаж всё равно «отправляет» кадр — модель пишет
 * `*[selfie: тёплый вечерний свет…]*` и бодро добавляет «готово, лови».
 * Маркер — просто текст: его никто не исполнял, генератор не звали, фото не
 * было. Владелец дважды не получил кадр и дважды прочитал, что он отправлен.
 *
 * Решение владельца (24.11): «если она хочет отправить селфи/картинку, никаких
 * препятствий быть не должно — хоть сама хочет, хоть я требую». Поэтому маркер
 * переводится в настоящий вызов инструмента, а сцена из него становится
 * аргументом. Это не «починка модели», а исполнение того, что она уже сказала.
 *
 * Диалект намеренно узкий: только кадры (selfie / image_gen). Всё остальное,
 * что похоже на команду, остаётся текстом — иначе чужая фраза в скобках
 * начнёт двигать сервер.
 *
 * Правка: агент (DeepSeek V4.1 Flash), 24.11.2026.
 */

/** Имена маркеров, которые считаем кадром, и куда класть сцену. */
const MARKERS: Record<string, { tool: string; arg: string }> = {
  selfie: { tool: "selfie", arg: "context" },
  "селфи": { tool: "selfie", arg: "context" },
  photo: { tool: "selfie", arg: "context" },
  "фото": { tool: "selfie", arg: "context" },
  image_gen: { tool: "image_gen", arg: "prompt" },
  image: { tool: "image_gen", arg: "prompt" },
  "картинка": { tool: "image_gen", arg: "prompt" },
}

/** Источник регулярки: свежий экземпляр на каждый проход, чтобы `lastIndex` не тёк. */
const SOURCE = "[*_]{0,2}\\[\\s*(selfie|image_gen|image|photo|селфи|фото|картинка)\\s*:\\s*([^\\]\\n]{3,600})\\][*_]{0,2}"

function fresh(): RegExp {
  return new RegExp(SOURCE, "gi")
}

/** Есть ли в тексте маркер кадра. */
export function hasInlineToolCalls(text: string | undefined | null): boolean {
  if (typeof text !== "string" || !text) return false
  return new RegExp(SOURCE, "i").test(text)
}

/**
 * Разбирает маркеры в вызовы инструментов.
 *
 * Сцена обрезается по краям, звёздочки разметки (`*[selfie: …]*`) в аргумент
 * не попадают — модель ставит их вокруг маркера для «действия в скобках».
 */
export function parseInlineToolCalls(text: string | undefined | null): ToolUseRequest[] {
  if (typeof text !== "string" || !text) return []
  const calls: ToolUseRequest[] = []
  const re = fresh()
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const marker = MARKERS[match[1].toLowerCase()]
    const scene = match[2].replace(/\s+/g, " ").trim()
    if (!marker || !scene) continue
    calls.push({
      id: `inline_${calls.length + 1}`,
      name: marker.tool,
      arguments: { [marker.arg]: scene },
    })
  }
  return calls
}

/**
 * Вырезает маркеры кадра и мусор размышлений из текста, который уйдёт человеку.
 *
 * `</think>` — отдельная грязь того же дня: Гемини оставила закрывающий тег в
 * ответе, и он уехал в чат. Кадр при этом остаётся: вызов уже исполнен, а
 * приложит его движок.
 */
export function stripInlineToolCalls(text: string): string {
  if (typeof text !== "string" || !text) return ""
  return text
    .replace(fresh(), " ")
    .replace(/<\/?think\b[^>]*>/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
