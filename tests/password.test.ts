import { describe, expect, it } from 'vitest'
import { MIN_ACCEPTABLE_BITS, MIN_PASSWORD_LENGTH, assessPassword, suggestPassword } from '../src/core/password'

function codes(password: string): string[] {
  return assessPassword(password).issues.map((i) => i.code)
}

describe('密码强度评估', () => {
  it('门槛常量本身是有意义的（长度 ≥10，熵 ≥50 bit）', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10)
    expect(MIN_ACCEPTABLE_BITS).toBe(50)
  })

  it('挡掉最常见的那批弱密码', () => {
    for (const bad of ['password', 'Password', 'PASSWORD', 'qwerty', 'admin', 'iloveyou', 'woaini1314']) {
      expect(assessPassword(bad).acceptable, bad).toBe(false)
    }
  })

  it('挡掉「常见词 + 数字尾缀」——加个年份不叫加固', () => {
    expect(codes('iloveyou2026')).toContain('contains-common-word')
    expect(assessPassword('iloveyou2026').acceptable).toBe(false)
    expect(assessPassword('password2026!').acceptable).toBe(false)
  })

  it('挡掉纯数字与整串日期', () => {
    expect(codes('1234567890')).toContain('all-digits')
    expect(assessPassword('1234567890').acceptable).toBe(false)
    // 8 位日期看着比 6 位长，实际搜索空间只有几万个日期
    expect(codes('20260922')).toContain('date-like')
    expect(assessPassword('20260922').acceptable).toBe(false)
    expect(assessPassword('19980922').acceptable).toBe(false)
  })

  it('挡掉键盘相邻序列冒充的长度', () => {
    // 10 位纯小写本来算「够长」，但 qwertyuiop 的熵接近于零
    expect(assessPassword('qwertyuiop').acceptable).toBe(false)
    expect(codes('qwertyuiop')).toContain('keyboard-run')
    expect(assessPassword('abcdefghij').acceptable).toBe(false)
  })

  it('挡掉长度不够的', () => {
    expect(codes('Xy9#mQ2')).toContain('too-short')
    expect(assessPassword('Xy9#mQ2').acceptable).toBe(false)
  })

  it('挡掉字符过于重复的', () => {
    expect(assessPassword('aaaaaaaaaaaa').acceptable).toBe(false)
    expect(codes('aaaa-aaaa-aaaa')).toContain('low-variety')
  })

  it('放行真正的强密码', () => {
    for (const good of ['correct-horse-battery', 'Zx9#mQ2$pL7@k', 'frost-otter-9maple-velvet', '我家的猫叫橘子2025']) {
      const a = assessPassword(good)
      expect(a.acceptable, `${good} 应通过（bits=${a.bits}）`).toBe(true)
    }
  })

  it('含年份但其余部分够强，仍然放行 —— 惩罚是打折不是判死', () => {
    const a = assessPassword('Giggle@2026!x')
    expect(a.acceptable).toBe(true)
    expect(a.issues.map((i) => i.code)).toContain('year-token')
  })

  it('年份与键盘序列会把估算熵打折，而不是只给个提示', () => {
    const withYear = assessPassword('Trombone9Melon')!.bits
    const withoutYear = assessPassword('Trombone7Melon')!.bits
    // 只差一个数字，但含 4 位连续数字的那一个应当被识别为年份并被打折
    expect(assessPassword('Trombone2026Melon').bits).toBeLessThan(withYear)
    expect(withoutYear).toBe(withYear)
  })

  it('等级映射与是否放行一致', () => {
    expect(assessPassword('abc').level).toBe('too-short')
    // 'password' 既短又常见，按「长度不够」归类；'qwertyuiop' 长度够了但熵不够
    expect(assessPassword('password').level).toBe('too-short')
    expect(assessPassword('qwertyuiop').level).toBe('weak')
    expect(assessPassword('correct-horse-battery').level).toBe('strong')
  })

  it('建议密码永远能通过自己的校验 —— 否则「给我生成一个」就是个陷阱', () => {
    for (let i = 0; i < 300; i++) {
      const s = suggestPassword()
      const a = assessPassword(s)
      expect(a.acceptable, `生成的 ${s} 竟然不达标（bits=${a.bits}）`).toBe(true)
    }
  })

  it('建议密码不重复', () => {
    const seen = new Set(Array.from({ length: 200 }, () => suggestPassword()))
    expect(seen.size).toBeGreaterThan(190)
  })
})
