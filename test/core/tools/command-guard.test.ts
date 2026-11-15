import { describe, it, expect } from "vitest"
import { checkCommand } from "../../../src/core/tools/command-guard.js"

describe("command-guard", () => {
  it("пропускает обычную работу: смотреть, искать, читать", () => {
    for (const cmd of [
      "systemctl status telemt",
      "journalctl -u telemt -n 50",
      "df -h",
      "grep -r error /var/log/telemt",
      "systemctl restart telemt",
      "rm -rf /tmp/build-cache",
      "free -m | head -3",
    ]) {
      expect(checkCommand(cmd)).toEqual({ allowed: true })
    }
  })

  it("ловит то, что не ловил старый чёрный список по подстрокам", () => {
    for (const cmd of [
      "rm -rf /*",
      "rm -rf /etc",
      "rm -R /var",
      "dd if=/dev/zero of=/dev/sda",
      "shutdown -r now",
      "systemctl disable ssh",
      "iptables -F",
      "mkfs.ext4 /dev/sda1",
      "chmod -R 000 /etc",
      "echo x; rm -rf /opt",
      "cat /etc/passwd | xargs rm -rf /etc",
    ]) {
      const verdict = checkCommand(cmd)
      expect(verdict.allowed, cmd).toBe(false)
      expect(verdict.why, cmd).toBeTruthy()
    }
  })

  it("не срабатывает на безобидное слово из старого списка", () => {
    // Раньше «format» в тексте команды блокировал её целиком.
    expect(checkCommand("grep -rn format src/ | head").allowed).toBe(true)
    expect(checkCommand("grep -c 'mkfs' /var/log/syslog").allowed).toBe(true)
  })

  it("отклоняет подстановку: её содержимое проверить нельзя", () => {
    for (const cmd of ["rm -rf $(cat paths.txt)", "echo `reboot`", "eval $X"]) {
      expect(checkCommand(cmd).allowed, cmd).toBe(false)
    }
  })

  it("режет по сегментам, а не по всей строке", () => {
    const verdict = checkCommand("df -h && rm -rf /etc")
    expect(verdict.allowed).toBe(false)
    expect(verdict.why).toContain("rm")
  })
})
