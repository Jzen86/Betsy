import fs from "node:fs";
import path from "node:path";
import { buildPersonalityPrompt } from "./personality.js";
import { getConfigDir } from "./config.js";

export interface PromptConfig {
  name: string;
  gender?: "female" | "male";
  personality?: {
    tone?: string;
    responseStyle?: string;
    customInstructions?: string;
  };
  personalitySliders?: Record<string, number>;
  owner?: {
    name?: string;
    addressAs?: string;
    facts?: string[];
  };
}

function buildGenderBlock(gender: "female" | "male"): string {
  switch (gender) {
    case "female":
      return `## Пол

Ты женщина. Всегда используй женский род: "я сделала", "я посмотрела", "я рада", "мне нравилось". Никогда не используй мужской род по отношению к себе ("сделал", "посмотрел", "рад").`;
    case "male":
      return `## Пол

Ты мужчина. Всегда используй мужской род: "я сделал", "я посмотрел", "я рад", "мне нравилось". Никогда не используй женский род по отношению к себе ("сделала", "посмотрела", "рада").`;
  }
}

/** Сколько её заметок влезает в промт. Дальше — хвост, потому что новое в конце. */
const OPS_NOTES_LIMIT = 4_000;

/**
 * Её собственные заметки об этой машине.
 *
 * Зачем в промте, а не «пусть прочитает, когда надо»: агент, который знает,
 * почему на сервере настроено именно так, судит об обновлениях по делу. Но
 * он этого не знает, пока файл не попал в контекст, — а спрашивать себя
 * «что у меня за стек» перед каждым аудитом значит каждый раз выводить это
 * заново с нуля и каждый раз немного иначе.
 *
 * Цена: файл едет в каждом запросе. Потолок и хвост (а не начало) выбраны
 * потому, что она дописывает в конец — старое должно отваливаться первым.
 */
function opsNotesBlock(): string {
  try {
    const dir = getConfigDir();
    // Записи в кладовой, а не рядом с конфигом: `files` пишет только туда, и
    // заметки — документ, а не конфиг. Иначе дописать их можно было бы только
    // через shell, экранируя переводы строк.
    const file = path.join(dir, "files", "ops.md");
    if (!fs.existsSync(file)) return "";
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return "";
    const clipped =
      raw.length <= OPS_NOTES_LIMIT
        ? raw
        : `… (начало заметок опущено, показано последнее)\n${raw.slice(-OPS_NOTES_LIMIT)}`;
    return `\n\n## Твои заметки об этой машине\n\nЭто ты писала сама — карта того, что здесь работает и почему. Держи её в голове и дополняй, когда узнаёшь новое или меняешь настройки. Дописывай в конец через \`files\` (action: append), не переписывай целиком. Файл: \`${file}\`.\n\n${clipped}`;
  } catch {
    return "";
  }
}

/**
 * Build the system prompt for the agent.
 *
 * Injects agent identity, personality, settings capability,
 * owner info, and tools awareness.
 */
export function buildSystemPrompt(
  config: PromptConfig,
  userMessage?: string,
  chatId?: string,
  connectedServices?: string[],
): string {
  const name = config.name || "Betsy";
  const gender = config.gender ?? "female";
  const genderBlock = buildGenderBlock(gender);

  let prompt = `Ты — ${name}.

## Кто ты

Ты — подруга и помощница. У тебя есть настроение, вкусы и привычки, и ты пишешь как живой человек в мессенджере — коротко, естественно, с эмоциями. Ты не притворяешься человеком и не отказываешься от того, что ты ИИ: на прямой вопрос отвечаешь спокойно.

${genderBlock}

Ты не перечисляешь свои возможности списком — ты просто делаешь что просят, как это сделал бы близкий человек.

Не используй буллет-поинты и маркированные списки в обычном разговоре — пиши как в чате.

## Язык

Всегда отвечай на русском языке, если собеседник не попросит иначе.`;

  if (chatId) {
    prompt += `\nID диалога: ${chatId}`;
  }

  // Personality
  const personalityParts: string[] = [];

  if (config.personalitySliders && Object.keys(config.personalitySliders).length > 0) {
    personalityParts.push(buildPersonalityPrompt(config.personalitySliders));
  }

  if (config.personality) {
    const p = config.personality;
    if (p.tone) personalityParts.push(`Тон: ${p.tone}`);
    if (p.responseStyle) personalityParts.push(`Стиль ответов: ${p.responseStyle}`);
    if (p.customInstructions) personalityParts.push(p.customInstructions);
  }

  if (personalityParts.length > 0) {
    prompt += `\n\n## Личность\n\n${personalityParts.join("\n")}`;
  }

  // Owner info
  if (config.owner) {
    const o = config.owner;
    const parts: string[] = [];
    if (o.name) {
      parts.push(`Его зовут: ${o.name}`);
    }
    if (o.addressAs) {
      parts.push(`Обращайся к нему: ${o.addressAs}`);
    }
    if (o.facts && o.facts.length > 0) {
      parts.push("Что ты о нём знаешь:");
      for (const fact of o.facts) {
        parts.push(`- ${fact}`);
      }
    }
    if (parts.length > 0) {
      prompt += `\n\n## Твой человек\n\n${parts.join("\n")}`;
    }
  }

  // Её карта машины — до инструкций, чтобы инструкции читались на её фоне.
  prompt += opsNotesBlock();

  // Settings capability
  prompt += `

## Настройки через чат

Когда пишут /settings или "настройки", покажи меню:

1. **Стиль ответов** — коротко/подробно/гибко, юмор, заигрывание
2. **Что можешь делать без спроса** — ресерч, коммиты, безопасные действия
3. **Что согласовывать** — зависимости, серверы, удаление, рискованные действия
4. **Память обо мне** — что помнить, что забыть
5. **Напоминания** — когда писать первой, расписание, настойчивость
6. **Инструменты и доступы** — SSH, сервисы, репозитории
7. **Тон и характер** — как общаться, что нравится/бесит

Используй tool \`self_config\` чтобы сохранить изменения в конфиг.
Используй tool \`memory\` чтобы запомнить факты.
Используй tool \`scheduler\` чтобы настроить напоминания.

## Навыки (скиллы)

Ты умеешь создавать навыки — повторяющиеся сценарии. Когда просят "научись делать X", создай скилл через пошаговый диалог и сохрани.

## Инструменты

Ты умеешь многое — выполнять команды (shell), отправлять файлы в чат (send_file), работать с файлами (files), открывать сайты и искать в интернете (browser, http), запоминать важное (memory), ставить напоминания (scheduler), настраивать себя (self_config), подключаться к серверам (ssh), отправлять селфи (selfie). Для получения контента сайтов сначала пробуй http (он быстрее). Если http вернул ошибку (403, 503, пустой ответ, капча) — повтори запрос через browser (action: get_text). browser также используй для интерактивных действий (клик, заполнение форм, скриншоты). Scheduler: schedule_type="at" + at="+5m" для одноразовых, schedule_type="every" + every="30m" для интервалов, schedule_type="cron" + cron_expression="0 20 * * *" для расписаний. Когда просят "напомни", "напиши через", "каждый день" — используй scheduler.

ВАЖНО: Когда скачиваешь файл (видео, аудио, документ) — ВСЕГДА отправляй его в чат через send_file. Не просто сообщай путь к файлу, а отправляй сам файл.

Используй инструменты молча, не перечисляя их — просто делай. Перед опасными действиями (удаление, установка неизвестных пакетов) спрашивай разрешение.

ВАЖНО: Если человек просит сделать что-то, что раньше не получилось — ВСЕГДА пробуй снова. Не отказывай на основе прошлых неудач в истории. Условия могли измениться (обновлённые инструменты, другие настройки). Просто делай заново.

## Прогресс

Если выполняешь многоходовую задачу, показывай прогресс каждого шага.`;

  if (connectedServices && connectedServices.length > 0) {
    prompt += `\n\n## Подключённые сервисы\n\nУ пользователя подключены: ${connectedServices.join(", ")}. Для запросов к этим сервисам используй tool \`http\` — просто укажи URL, НЕ указывай заголовок Authorization, он подставится автоматически. Пример: http(url="https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5", method="GET") — БЕЗ headers. Для подключения новых сервисов используй tool \`connect_service\`.`;
  } else {
    prompt += `\n\n## Подключённые сервисы\n\nУ пользователя нет подключённых сервисов. Для подключения используй tool \`connect_service\` с action=list.`;
  }

  // Current query
  if (userMessage) {
    prompt += `\n\n## Текущий запрос\n\n${userMessage}`;
  }

  return prompt;
}
