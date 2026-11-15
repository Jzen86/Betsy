import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Заметки агента об этой машине попадают в промт.
 *
 * Проверяем поведение: во временном каталоге конфига создаём files/ops.md и
 * смотрим, что он оказался в системном промте. Иначе «карта в голове» зависит
 * от того, догадается ли агент прочитать файл, — а он не догадается.
 */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "betsy-ops-"))
const prevHome = process.env.HOME
const prevProfile = process.env.USERPROFILE
const notesDir = path.join(tmpHome, ".betsy", "files")
const notesFile = path.join(notesDir, "ops.md")

beforeAll(() => {
  // os.homedir() на Windows читает USERPROFILE, на Linux — HOME.
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
  fs.mkdirSync(notesDir, { recursive: true })
})

afterAll(() => {
  process.env.HOME = prevHome
  process.env.USERPROFILE = prevProfile
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

const { buildSystemPrompt } = await import("../../../src/core/prompt.js")

const base = { name: "Betsy", gender: "female" as const }

describe("ops notes in prompt", () => {
  it("без файла промт не ломается и секции нет", () => {
    const prompt = buildSystemPrompt(base)
    expect(prompt).not.toContain("заметки об этой машине")
  })

  it("заметки попадают в промт, когда файл есть", () => {
    fs.writeFileSync(
      notesFile,
      "telemt — MTProto-прокси, конфиг в /etc/telemt. Ребут не делаю сама.",
    )

    const prompt = buildSystemPrompt(base)

    expect(prompt).toContain("заметки об этой машине")
    expect(prompt).toContain("MTProto-прокси")
    // Файл лежит в кладовой, потому что `files` пишет только туда.
    expect(prompt).toContain(notesFile)
  })

  it("длинные заметки режутся с конца: свежее важнее старого", () => {
    const head = "СТАРОЕ_НАЧАЛО "
    const filler = "x".repeat(8_000)
    fs.writeFileSync(notesFile, `${head}${filler}СВЕЖЕЕ_КОНЕЦ`)

    const prompt = buildSystemPrompt(base)

    expect(prompt).toContain("СВЕЖЕЕ_КОНЕЦ")
    expect(prompt).not.toContain("СТАРОЕ_НАЧАЛО")
    expect(prompt).toContain("начало заметок опущено")
  })
})
