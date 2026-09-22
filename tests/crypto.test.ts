import { describe, expect, it } from 'vitest'
import {
  AAD_BACKUP,
  AAD_DEK,
  AAD_VAULT,
  AAD_VERIFIER,
  PBKDF2_ITERATIONS,
  RECOVERY_ALPHABET,
  RECOVERY_LENGTH,
  checkVerifier,
  deriveKek,
  exportDekRaw,
  formatRecoveryCode,
  fromB64,
  importDekRaw,
  isValidRecoveryCodeShape,
  makeVerifier,
  newDek,
  newKdfParams,
  newRecoveryCode,
  normalizeRecoveryCode,
  open,
  openJson,
  randomBytes,
  seal,
  sealJson,
  toB64,
} from '../src/core/crypto'

/**
 * 测试里刻意用低的迭代数。
 *
 * 60 万次 PBKDF2 单次约 200~400ms，如果每个用例都跑真实参数，这套测试会变成
 * 几十秒 —— 而它需要跑在每次提交前的 CI 里。所以除了一个专门「锁住参数」的用例，
 * 其余全部把 iterations 调到 1000。这样测的是**逻辑正确性**，
 * 而参数本身由一个独立的断言兜住，谁把 60 万改成 1000 都会立刻红。
 */
function fastParams() {
  return { ...newKdfParams(), iterations: 1_000 }
}

describe('密钥派生参数', () => {
  it('迭代次数锁在 OWASP 建议的 60 万，不允许被悄悄调低', () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000)
    expect(newKdfParams().iterations).toBe(600_000)
  })

  it('每次都生成新的随机盐 —— 复用盐等于让彩虹表重新生效', () => {
    const salts = new Set(Array.from({ length: 50 }, () => newKdfParams().salt))
    expect(salts.size).toBe(50)
  })

  it('盐是 16 字节', () => {
    expect(fromB64(newKdfParams().salt)).toHaveLength(16)
  })
})

describe('base64 编解码', () => {
  it('全字节范围往返无损', () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    expect(Array.from(fromB64(toB64(bytes)))).toEqual(Array.from(bytes))
  })

  it('超过单次 String.fromCharCode 上限的大输入也不会爆栈', () => {
    // 300KB：如果实现里没有分块，这一条会直接 RangeError: Maximum call stack size exceeded
    const big = randomBytes(300_000)
    const round = fromB64(toB64(big))
    expect(round.length).toBe(big.length)
    expect(Array.from(round.subarray(0, 8))).toEqual(Array.from(big.subarray(0, 8)))
    expect(Array.from(round.subarray(-8))).toEqual(Array.from(big.subarray(-8)))
  })

  it('空输入不炸', () => {
    expect(fromB64(toB64(new Uint8Array(0)))).toHaveLength(0)
  })

  it('randomBytes 能填满超过 getRandomValues 单次上限的长度', () => {
    // getRandomValues 单次上限 65536 字节。生产路径只用 12/15/16 字节踩不到，
    // 但通用工具函数留这个坑迟早会被踩到 —— 这条测试盯着分块逻辑
    const big = randomBytes(200_000)
    expect(big).toHaveLength(200_000)
    // 分块若无脑复用同一个 offset，尾部会留一片全零
    expect(big.subarray(-64).some((b) => b !== 0)).toBe(true)
    expect(big.subarray(0, 64).some((b) => b !== 0)).toBe(true)
  })
})

describe('密钥派生', () => {
  it('同密码同参数派生出同一把钥匙', async () => {
    const params = fastParams()
    const a = await deriveKek('同一个密码-abc', params)
    const b = await deriveKek('同一个密码-abc', params)
    const sealed = await seal(a, new TextEncoder().encode('hello'), AAD_VAULT)
    expect(await open(b, sealed, AAD_VAULT)).toBeTruthy()
  })

  it('不同密码派生出的钥匙互不开', async () => {
    const params = fastParams()
    const a = await deriveKek('密码甲', params)
    const b = await deriveKek('密码乙', params)
    const sealed = await seal(a, new TextEncoder().encode('hello'), AAD_VAULT)
    await expect(open(b, sealed, AAD_VAULT)).rejects.toThrow()
  })

  it('同密码但不同盐，派生出的钥匙也不同', async () => {
    const a = await deriveKek('同样的密码', fastParams())
    const b = await deriveKek('同样的密码', fastParams())
    const sealed = await seal(a, new TextEncoder().encode('hello'), AAD_VAULT)
    await expect(open(b, sealed, AAD_VAULT)).rejects.toThrow()
  })

  it('派生出的 KEK 不可导出 —— 拿不到裸字节就没有二次泄漏面', async () => {
    const kek = await deriveKek('abc', fastParams())
    expect(kek.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', kek)).rejects.toThrow()
  })

  it('DEK 可导出，且导出再导入得到等价的钥匙', async () => {
    const dek = await newDek()
    const raw = await exportDekRaw(dek)
    expect(raw).toHaveLength(32)
    const round = await importDekRaw(raw)
    const sealed = await seal(dek, new TextEncoder().encode('roundtrip'), AAD_VAULT)
    expect(new TextDecoder().decode(await open(round, sealed, AAD_VAULT))).toBe('roundtrip')
  })
})

describe('AES-GCM 封装', () => {
  it('同一明文每次加密产生不同密文（IV 不复用）', async () => {
    const dek = await newDek()
    const plain = new TextEncoder().encode('同一段明文')
    const a = await seal(dek, plain, AAD_VAULT)
    const b = await seal(dek, plain, AAD_VAULT)
    // IV 复用会直接泄漏密钥流，是 GCM 下最致命的一种错误。
    // 这里断言两次加密的 IV 必然不同，等于把「IV 由 seal() 内部生成」这条规则钉死。
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('IV 是 12 字节（GCM 的推荐长度）', async () => {
    const dek = await newDek()
    expect(fromB64((await seal(dek, new Uint8Array(1), AAD_VAULT)).iv)).toHaveLength(12)
  })

  it('密文被改一个字节就解不开（认证标签生效）', async () => {
    const dek = await newDek()
    const sealed = await seal(dek, new TextEncoder().encode('不能被改'), AAD_VAULT)

    const tampered = fromB64(sealed.ct)
    tampered[0] ^= 0x01
    await expect(open(dek, { iv: sealed.iv, ct: toB64(tampered) }, AAD_VAULT)).rejects.toThrow()
  })

  it('IV 被改也解不开', async () => {
    const dek = await newDek()
    const sealed = await seal(dek, new TextEncoder().encode('不能被改'), AAD_VAULT)
    const iv = fromB64(sealed.iv)
    iv[0] ^= 0x01
    await expect(open(dek, { iv: toB64(iv), ct: sealed.ct }, AAD_VAULT)).rejects.toThrow()
  })

  it('AAD 不匹配就解不开 —— 密文无法被挪到别的用途上', async () => {
    const dek = await newDek()
    const sealed = await seal(dek, new TextEncoder().encode('数据体'), AAD_VAULT)
    // 把「数据体」的密文当成「备份体」来解，必须失败。
    // 没有 AAD 的话这里会成功，攻击者就能把短密文互换位置做混淆。
    await expect(open(dek, sealed, AAD_BACKUP)).rejects.toThrow()

    const wrapped = await seal(dek, new Uint8Array(32), AAD_DEK)
    await expect(open(dek, wrapped, AAD_VERIFIER)).rejects.toThrow()
  })

  it('JSON 往返，中文与嵌套结构都不损坏', async () => {
    const dek = await newDek()
    const value = {
      备注: '楼下便利店 · 酸奶',
      金额: 12.5,
      嵌套: { 数组: [1, 2, 3], 空值: null, 布尔: true },
      emoji: '🧾',
    }
    const sealed = await sealJson(dek, value, AAD_BACKUP)
    expect(await openJson(dek, sealed, AAD_BACKUP)).toEqual(value)
  })

  it('大对象往返（模拟整库打包）', async () => {
    const dek = await newDek()
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      id: `id-${i}`,
      note: `备注-${i}-${'字'.repeat(20)}`,
      amount: i * 1.37,
    }))
    const sealed = await sealJson(dek, { rows }, AAD_VAULT)
    const back = await openJson<{ rows: typeof rows }>(dek, sealed, AAD_VAULT)
    expect(back.rows).toHaveLength(2000)
    expect(back.rows[1999].id).toBe('id-1999')
  })
})

describe('密码校验探针', () => {
  it('对的密码通过、错的密码不通过', async () => {
    const params = fastParams()
    const right = await deriveKek('正确密码', params)
    const wrong = await deriveKek('错误密码', params)
    const verifier = await makeVerifier(right)
    expect(await checkVerifier(right, verifier)).toBe(true)
    expect(await checkVerifier(wrong, verifier)).toBe(false)
  })

  it('探针被改坏时返回 false 而不是抛异常', async () => {
    const kek = await deriveKek('abc', fastParams())
    const verifier = await makeVerifier(kek)
    const broken = fromB64(verifier.ct)
    broken[0] ^= 0xff
    await expect(checkVerifier(kek, { iv: verifier.iv, ct: toB64(broken) })).resolves.toBe(false)
  })
})

describe('恢复码', () => {
  it('长度固定 24，且只含字母表里的字符', () => {
    for (let i = 0; i < 200; i++) {
      const code = newRecoveryCode()
      expect(code).toHaveLength(RECOVERY_LENGTH)
      for (const ch of code) expect(RECOVERY_ALPHABET).toContain(ch)
    }
  })

  it('字母表恰好 32 个符号，且剔掉的是 0/1/O/I —— 手抄时最容易认错的那四个', () => {
    // 32 是硬约束：120 bit ÷ 5 bit = 24 位，一位不多一位不少。
    // 多剔一个符号（比如 L）就会塌成 31，5 bit 映射随之失效。
    expect(RECOVERY_ALPHABET).toHaveLength(32)
    for (const ch of ['0', '1', 'O', 'I']) {
      expect(RECOVERY_ALPHABET).not.toContain(ch)
    }
    // L 是保留的，任何「恢复码不含 L」的文案都是错的
    expect(RECOVERY_ALPHABET).toContain('L')
  })

  it('不重复：2000 次生成没有碰撞', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => newRecoveryCode()))
    expect(seen.size).toBe(2000)
  })

  it('32 个符号都被用到，编码没有恒定为某几位的偏置', () => {
    // 120 bit 切成 24 组 5 bit。若实现写成「每字节 %32」，高位符号会明显缺失。
    const counts = new Map<string, number>()
    const sample = Array.from({ length: 400 }, () => newRecoveryCode()).join('')
    for (const ch of sample) counts.set(ch, (counts.get(ch) ?? 0) + 1)

    expect(counts.size).toBe(32)
    const expected = sample.length / 32
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(expected * 0.6)
      expect(n).toBeLessThan(expected * 1.4)
    }
  })

  it('归一化：大小写、空格、连字符都被吸收', () => {
    const raw = newRecoveryCode()
    expect(normalizeRecoveryCode(formatRecoveryCode(raw))).toBe(raw)
    expect(normalizeRecoveryCode(raw.toLowerCase())).toBe(raw)
    expect(normalizeRecoveryCode(`  ${formatRecoveryCode(raw)}  `)).toBe(raw)
    expect(normalizeRecoveryCode(formatRecoveryCode(raw).replace(/-/g, ' '))).toBe(raw)
  })

  it('归一化会丢掉字母表外的字符，不做「O→0」式的猜测纠正', () => {
    // 猜着纠正只会把「输错了」伪装成「密码不对」，更难排查
    expect(normalizeRecoveryCode('OOII')).toBe('')
    expect(normalizeRecoveryCode('AB0C')).toBe('ABC')
  })

  it('生成的原始码本身就是归一化后的形态 —— 否则用户手上的码会静默失效', () => {
    // 生成时用原始码派生密钥，重置时用归一化后的输入派生。
    // 这两个字符串必须逐字符相等，否则「抄下来的码打不开自己的保险箱」。
    for (let i = 0; i < 500; i++) {
      const code = newRecoveryCode()
      expect(normalizeRecoveryCode(code)).toBe(code)
    }
  })

  it('格式检查只看长度，不对内容做强弱判断', () => {
    expect(isValidRecoveryCodeShape(newRecoveryCode())).toBe(true)
    expect(isValidRecoveryCodeShape(formatRecoveryCode(newRecoveryCode()))).toBe(true)
    expect(isValidRecoveryCodeShape('ABC')).toBe(false)
    expect(isValidRecoveryCodeShape('2'.repeat(25))).toBe(false)
  })

  it('展示形态每 4 位分组，且归一化后能还原', () => {
    const pretty = formatRecoveryCode(newRecoveryCode())
    expect(pretty).toMatch(/^[^-]{4}(-[^-]{4}){5}$/)
    expect(normalizeRecoveryCode(pretty)).toHaveLength(24)
  })

  it('恢复码派生出的钥匙能包住 DEK 并原样取回', async () => {
    const code = newRecoveryCode()
    const params = fastParams()
    const dek = await newDek()
    const rawDek = await exportDekRaw(dek)

    const kek = await deriveKek(code, params)
    const wrapped = await seal(kek, rawDek, AAD_DEK)

    // 用户抄下来的是带连字符的形态，输入时归一化后必须还能解开
    const fromPaper = await deriveKek(normalizeRecoveryCode(formatRecoveryCode(code)), params)
    const recovered = await open(fromPaper, wrapped, AAD_DEK)
    expect(Array.from(new Uint8Array(recovered))).toEqual(Array.from(rawDek))
  })

  it('恢复码归一化后再派生，与原始码派生出的钥匙完全一致', async () => {
    // 这一条比上一条更贴近生产路径：生成时用原始码，重置时用用户输入。
    // 两边只要有一个字符对不上，就会表现成「恢复码不对」，而且怎么试都试不出来。
    const code = newRecoveryCode()
    const params = fastParams()
    const dek = await newDek()
    const rawDek = await exportDekRaw(dek)

    const generated = await deriveKek(code, params)
    const wrapped = await seal(generated, rawDek, AAD_DEK)

    // 模拟用户在手机上手动输入：小写、随手加空格和连字符
    const typed = formatRecoveryCode(code).toLowerCase().replace(/-/g, ' ')
    const fromTyping = await deriveKek(normalizeRecoveryCode(typed), params)
    const recovered = await open(fromTyping, wrapped, AAD_DEK)
    expect(Array.from(new Uint8Array(recovered))).toEqual(Array.from(rawDek))
  })
})
