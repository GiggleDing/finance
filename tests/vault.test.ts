import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { mkTxn } from './helpers'
import {
  AAD_VAULT,
  fromB64,
  openPaddedJson,
  importDekRaw,
} from '../src/core/crypto'
import {
  buildEncryptedBackup,
  openBackupFile,
  probeBackupFile,
  type EncryptedBackup,
} from '../src/core/backup'
import { db, readEnvelope, readVaultBlob, discardVaultRecords, type VaultPayload } from '../src/core/db'
import {
  WRONG_PASSWORD_MESSAGE,
  appendTxns,
  boot,
  changePassword,
  currentPayload,
  destroyEverything,
  hasRecoveryCode,
  hasSessionKey,
  lock,
  mergeFromBackup,
  reissueRecoveryCode,
  replaceSnapshots,
  resetPasswordWithRecoveryCode,
  setupVault,
  unlock,
  vaultFacts,
  verifyPassword,
  getVaultState,
  wipeVaultData,
} from '../src/core/session'

/**
 * 保险箱全流程集成测试。
 *
 * 跑在 fake-indexeddb 上，走的是**真实的生产代码路径**：真的跑 60 万次 PBKDF2、
 * 真的写 IndexedDB、真的经过 boot 状态机。Node 里 60 万次 PBKDF2 约 46ms，
 * 所以整套跑下来是秒级，不需要为了测试去调低迭代数。
 *
 * 这里覆盖的是单元测试覆盖不到的那一层：状态迁移、跨刷新的会话续期、
 * 明文迁移、备份端到端、以及「磁盘上到底能不能看到明文」。
 */

/**
 * Node 默认不带 Web Storage（localStorage/sessionStorage 还在实验开关后面）。
 * 生产代码把它们包在 try/catch 里，所以缺了也不会崩，但「刷新页面不重输密码」
 * 这条路径**唯一**依赖会话存储，缺了就等于没测。这里补一个内存实现。
 */
if (typeof globalThis.sessionStorage === 'undefined') {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size
      },
    },
  })
}

/** 读内存里的状态快照。组件走 useVault()（需要 React），测试走这个非 hook 的读取口。 */
function status(): string {
  return getVaultState().status
}

beforeEach(async () => {
  // 每个用例从「全新安装」开始：清会话存储 + 拆掉保险箱
  try {
    sessionStorage.clear()
  } catch {
    /* 环境没有 sessionStorage 也无所谓，下面的断言会体现出来 */
  }
  await destroyEverything()
})

describe('首次设置保险箱', () => {
  it('空设备启动时进入 setup 状态，且没有待迁移数据', async () => {
    await boot()
    const s = getVaultState()
    expect(s.status).toBe('setup')
    expect(s.pending).toBeNull()
    expect(s.data).toBeNull()
  })

  it('设置密码后进入解锁态，并返回一条 24 位恢复码', async () => {
    await boot()
    const code = await setupVault('Trombone7Melon')
    expect(code).toHaveLength(24)
    expect(getVaultState().status).toBe('unlocked')
    expect(getVaultState().freshRecoveryCode).toBe(code)
    expect(hasSessionKey()).toBe(true)
  })

  it('信封里同时存了密码包装和恢复码包装，且都不含明文密钥', async () => {
    const code = await setupVault('Trombone7Melon')
    const env = await readEnvelope()
    expect(env).not.toBeNull()
    expect(env!.pw.kdf.iterations).toBe(600_000)
    expect(env!.pw.kdf.salt).toBeTruthy()
    expect(env!.rc).toBeTruthy()
    // 信封里绝对不能出现恢复码本身
    expect(JSON.stringify(env)).not.toContain(code)
  })

  it('弱密码被挡住，且不会留下半个保险箱', async () => {
    await expect(setupVault('password')).rejects.toThrow()
    await expect(setupVault('1234567890')).rejects.toThrow()
    await expect(setupVault('qwertyuiop')).rejects.toThrow()
    expect(await readEnvelope()).toBeNull()
  })

  it('不会重复建箱：已存在时再建会报错', async () => {
    await setupVault('Trombone7Melon')
    await expect(setupVault('Another7Melon')).rejects.toThrow(/已经有一个保险箱/)
  })
})

describe('解锁与锁定', () => {
  it('密码错了报统一文案，且不进入解锁态', async () => {
    await setupVault('Trombone7Melon')
    lock()
    await expect(unlock('Trombone7Melonn')).rejects.toThrow(WRONG_PASSWORD_MESSAGE)
    expect(getVaultState().status).toBe('locked')
    expect(hasSessionKey()).toBe(false)
  })

  it('密码对了能解开，数据一条不少', async () => {
    await setupVault('Trombone7Melon')
    await appendTxns([
      mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 12.5, note: '早餐' }),
      mkTxn({ id: 'b', time: '2026-03-02 11:00:00', rawType: '收入', amount: 8000, note: '工资' }),
    ])
    lock()

    await unlock('Trombone7Melon')
    expect(getVaultState().status).toBe('unlocked')
    expect(currentPayload().txns.map((t) => t.id)).toEqual(['a', 'b'])
    expect(currentPayload().txns[0].note).toBe('早餐')
  })

  it('刷新页面不用重输密码；关掉标签页就必须重输', async () => {
    await setupVault('Trombone7Melon')
    await appendTxns([mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 1 })])

    // 模拟「按 F5」：不清会话存储，直接重跑启动流程
    await boot()
    expect(getVaultState().status).toBe('unlocked')
    expect(currentPayload().txns).toHaveLength(1)

    // 模拟「关掉标签页」：sessionStorage 随标签页蒸发
    sessionStorage.clear()
    await boot()
    expect(getVaultState().status).toBe('locked')
    expect(getVaultState().data).toBeNull()
    expect(hasSessionKey()).toBe(false)
  })

  it('锁定会立刻清掉会话里的钥匙，也会清掉内存副本', async () => {
    await setupVault('Trombone7Melon')
    expect(sessionStorage.getItem('qianji-lens:dek')).toBeTruthy()
    lock()
    expect(sessionStorage.getItem('qianji-lens:dek')).toBeNull()
    expect(hasSessionKey()).toBe(false)
    expect(getVaultState().data).toBeNull()
    expect(getVaultState().status).toBe('locked')
  })
})

describe('磁盘上不留明文', () => {
  it('数据体密文里搜不到任何账单原文', async () => {
    const secret = '楼下便利店酸奶-不可泄漏的备注'
    await setupVault('Trombone7Melon')
    await appendTxns([
      mkTxn({ id: 'x1', time: '2026-03-01 10:00:00', rawType: '支出', amount: 33.33, note: secret }),
    ])

    const blob = await readVaultBlob()
    expect(blob).not.toBeNull()

    // 密文按字节搜原文的 UTF-8 序列。搜得到就说明根本没加密。
    const cipherBytes = fromB64(blob!.sealed.ct)
    const needle = new TextEncoder().encode(secret)
    expect(indexOfBytes(cipherBytes, needle)).toBe(-1)

    // 整个信封 JSON 里也不该出现账单原文
    expect(JSON.stringify(await readEnvelope())).not.toContain(secret)
  })

  it('旧明文表在设置密码后被清空', async () => {
    await db.txns.bulkPut([
      mkTxn({ id: 'legacy-1', time: '2026-01-05 09:00:00', rawType: '支出', amount: 20, note: '旧明文' }),
    ])
    expect(await db.txns.count()).toBe(1)

    await boot()
    await setupVault('Trombone7Melon')

    expect(await db.txns.count()).toBe(0)
    expect(currentPayload().txns.map((t) => t.id)).toEqual(['legacy-1'])
  })
})

describe('迁移旧明文数据', () => {
  it('启动时识别出未加密数据，并在设置密码时一并搬进保险箱', async () => {
    await db.txns.bulkPut([
      mkTxn({ id: 'l1', time: '2026-01-05 09:00:00', rawType: '支出', amount: 20 }),
      mkTxn({ id: 'l2', time: '2026-01-06 09:00:00', rawType: '收入', amount: 500 }),
    ])
    await db.snapshots.bulkAdd([
      { date: '2026-01-31', name: '招行', balance: 12345, group: '资金', includeInNet: true },
    ])

    await boot()
    expect(getVaultState().status).toBe('setup')
    expect(getVaultState().pending).toEqual({ txnCount: 2, snapshotCount: 1 })

    await setupVault('Trombone7Melon')
    expect(currentPayload().txns).toHaveLength(2)
    expect(currentPayload().snapshots).toHaveLength(1)

    // 明文必须已经在磁盘上消失
    expect(await db.txns.count()).toBe(0)
    expect(await db.snapshots.count()).toBe(0)
  })

  it('自愈：信封已存在时，残留的明文表在解锁后被补清', async () => {
    await setupVault('Trombone7Melon')
    // 伪造「上次迁移在写密文和清明文之间被打断」的残留
    await db.txns.bulkPut([
      mkTxn({ id: 'leftover', time: '2026-01-05 09:00:00', rawType: '支出', amount: 20 }),
    ])
    expect(await db.txns.count()).toBe(1)

    sessionStorage.clear()
    await boot() // 此时是 locked
    expect(await db.txns.count()).toBe(1) // 还没解锁，先不动它

    await unlock('Trombone7Melon')
    // loadWithKey 里的 clearLegacyPlaintext 是异步 fire-and-forget，给它一拍
    await new Promise((r) => setTimeout(r, 50))
    expect(await db.txns.count()).toBe(0)
  })
})

describe('改密码', () => {
  it('改完新密码能开、旧密码不能开，数据不动', async () => {
    await setupVault('Trombone7Melon')
    await appendTxns([mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 9 })])

    await changePassword('Trombone7Melon', 'Quartz5Harbor')
    lock()

    await expect(unlock('Trombone7Melon')).rejects.toThrow(WRONG_PASSWORD_MESSAGE)
    await unlock('Quartz5Harbor')
    expect(currentPayload().txns).toHaveLength(1)
  })

  it('当前密码不对时拒绝改动', async () => {
    await setupVault('Trombone7Melon')
    const before = await readEnvelope()
    await expect(changePassword('不对的密码', 'Quartz5Harbor')).rejects.toThrow(/当前密码不对/)
    expect((await readEnvelope())!.pw.wrapped.ct).toBe(before!.pw.wrapped.ct)
  })

  it('新密码同样要过强度门槛', async () => {
    await setupVault('Trombone7Melon')
    await expect(changePassword('Trombone7Melon', 'password')).rejects.toThrow()
  })
})

describe('恢复码重置', () => {
  it('用恢复码能重置密码，并换发一条新的；旧码立刻作废', async () => {
    const oldCode = await setupVault('Trombone7Melon')
    await appendTxns([mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 9 })])
    lock()

    const newCode = await resetPasswordWithRecoveryCode(oldCode, 'Nettle3Pebble')
    expect(newCode).not.toBe(oldCode)
    expect(getVaultState().status).toBe('unlocked')
    expect(currentPayload().txns).toHaveLength(1)

    lock()
    await unlock('Nettle3Pebble')
    lock()

    // 旧恢复码必须已经烧掉
    await expect(resetPasswordWithRecoveryCode(oldCode, 'Raven8Timber')).rejects.toThrow(/对不上/)
    // 新恢复码可用
    await expect(resetPasswordWithRecoveryCode(newCode, 'Raven8Timber')).resolves.toHaveLength(24)
  })

  it('恢复码可以用带连字符、带小写、带空格的形态输入', async () => {
    const code = await setupVault('Trombone7Melon')
    const pretty = code.replace(/(.{4})(?=.)/g, '$1-')
    lock()
    await expect(resetPasswordWithRecoveryCode(pretty.toLowerCase(), 'Nettle3Pebble')).resolves.toHaveLength(24)
  })

  it('格式不对的恢复码报格式错，不浪费一次 PBKDF2 也不改任何东西', async () => {
    await setupVault('Trombone7Melon')
    const before = await readEnvelope()
    lock()
    await expect(resetPasswordWithRecoveryCode('ABC', 'Nettle3Pebble')).rejects.toThrow(/格式不对/)
    await expect(resetPasswordWithRecoveryCode('O'.repeat(24), 'Nettle3Pebble')).rejects.toThrow(/格式不对/)
    expect((await readEnvelope())!.pw.wrapped.ct).toBe(before!.pw.wrapped.ct)
  })
})

describe('写入与合并', () => {
  it('重复导入同一批流水不会产生重复', async () => {
    await setupVault('Trombone7Melon')
    const rows = [
      mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 1 }),
      mkTxn({ id: 'b', time: '2026-03-02 10:00:00', rawType: '支出', amount: 2 }),
    ]
    expect(await appendTxns(rows)).toEqual({ inserted: 2, duplicated: 0 })
    expect(await appendTxns(rows)).toEqual({ inserted: 0, duplicated: 2 })
    expect(currentPayload().txns).toHaveLength(2)
  })

  it('从备份合并：流水按 ID 补齐，快照整表覆盖', async () => {
    await setupVault('Trombone7Melon')
    await appendTxns([mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 1 })])
    await replaceSnapshots([{ date: '2026-03-31', name: '招行', balance: 100, group: '资金', includeInNet: true }])

    const outcome = await mergeFromBackup({
      txns: [
        mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 1 }),
        mkTxn({ id: 'c', time: '2026-04-01 10:00:00', rawType: '支出', amount: 3 }),
      ],
      snapshots: [{ date: '2026-04-30', name: '招行', balance: 999, group: '资金', includeInNet: true }],
      imports: [],
    })

    expect(outcome.txnsInserted).toBe(1)
    expect(outcome.txnsDuplicated).toBe(1)
    expect(currentPayload().txns.map((t) => t.id).sort()).toEqual(['a', 'c'])
    // 快照是覆盖语义：只剩备份里那一份，不会两台机器各留一半
    expect(currentPayload().snapshots).toHaveLength(1)
    expect(currentPayload().snapshots[0].balance).toBe(999)
  })

  it('清空账面数据保留保险箱，密码仍然有效', async () => {
    await setupVault('Trombone7Melon')
    await appendTxns([mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 1 })])

    await wipeVaultData()
    expect(currentPayload().txns).toHaveLength(0)
    expect(getVaultState().status).toBe('unlocked')

    lock()
    await expect(unlock('Trombone7Melon')).resolves.toBeUndefined()
  })

  it('拆掉保险箱后回到 setup，且密钥已被清掉', async () => {
    await setupVault('Trombone7Melon')
    await destroyEverything()
    expect(getVaultState().status).toBe('setup')
    expect(hasSessionKey()).toBe(false)
    expect(await readEnvelope()).toBeNull()
    expect(await readVaultBlob()).toBeNull()
  })
})

describe('加密备份端到端', () => {
  const payload: VaultPayload = {
    txns: [
      mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 12.5, note: '不允许出现在明文里的备注' }),
      mkTxn({ id: 'b', time: '2026-03-02 10:00:00', rawType: '收入', amount: 8000 }),
    ],
    snapshots: [{ date: '2026-03-31', name: '招行', balance: 4321, group: '资金', includeInNet: true }],
    imports: [],
  }

  function asFile(backup: EncryptedBackup): File {
    return new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' })
  }

  it('导出的备份文件里没有任何明文账单', async () => {
    const backup = await buildEncryptedBackup(payload, 'Backup9Password')
    const text = JSON.stringify(backup)
    expect(text).not.toContain('不允许出现在明文里的备注')
    expect(text).not.toContain('4321')
    // 也不该泄漏条数
    expect(text).not.toContain('"txnCount"')
    expect(backup.exportedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('正确的密码能完整还原数据', async () => {
    const backup = await buildEncryptedBackup(payload, 'Backup9Password')
    const opened = await openBackupFile(asFile(backup), 'Backup9Password')
    expect(opened.legacy).toBe(false)
    expect(opened.payload.txns.map((t) => t.id)).toEqual(['a', 'b'])
    expect(opened.payload.txns[0].note).toBe('不允许出现在明文里的备注')
    expect(opened.payload.snapshots[0].balance).toBe(4321)
  })

  it('密码错报密码错，文件被改坏报文件坏 —— 两者分开，用户才知道该重试还是换文件', async () => {
    const backup = await buildEncryptedBackup(payload, 'Backup9Password')
    await expect(openBackupFile(asFile(backup), 'WrongPassword')).rejects.toThrow(/密码不对/)

    const broken: EncryptedBackup = { ...backup, payload: { ...backup.payload, ct: flipFirstByte(backup.payload.ct) } }
    await expect(openBackupFile(asFile(broken), 'Backup9Password')).rejects.toThrow(/被改动过/)
  })

  it('每个备份自带独立的盐，两次导出互不影响', async () => {
    const a = await buildEncryptedBackup(payload, 'Backup9Password')
    const b = await buildEncryptedBackup(payload, 'Backup9Password')
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
    expect(a.payload.iv).not.toBe(b.payload.iv)
    expect(a.payload.ct).not.toBe(b.payload.ct)
  })

  it('改主密码不会让旧备份失效 —— 旧备份用它导出那一刻的密码照旧能开', async () => {
    const backup = await buildEncryptedBackup(payload, 'Trombone7Melon')
    await setupVault('Trombone7Melon')
    await changePassword('Trombone7Melon', 'Quartz5Harbor')
    await expect(openBackupFile(asFile(backup), 'Trombone7Melon')).resolves.toBeTruthy()
    await expect(openBackupFile(asFile(backup), 'Quartz5Harbor')).rejects.toThrow(/密码不对/)
  })

  it('探针能认出加密备份，且解密前不泄漏条数', async () => {
    const backup = await buildEncryptedBackup(payload, 'Backup9Password')
    const probe = await probeBackupFile(asFile(backup))
    expect(probe.kind).toBe('encrypted')
    expect(probe.legacyCounts).toBeNull()
    expect(probe.exportedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('旧版明文备份仍可导入，并被标记为 legacy', async () => {
    const legacy = { app: 'qianji-lens', version: 1, exportedAt: '2026-09-20T10:00:00.000Z', txns: payload.txns, snapshots: payload.snapshots }
    const file = new File([JSON.stringify(legacy)], 'old.json', { type: 'application/json' })

    const probe = await probeBackupFile(file)
    expect(probe.kind).toBe('legacy-plaintext')
    expect(probe.legacyCounts).toEqual({ txnCount: 2, snapshotCount: 1 })

    const opened = await openBackupFile(file, '任意密码')
    expect(opened.legacy).toBe(true)
    expect(opened.payload.txns).toHaveLength(2)
  })

  it('不是本系统的文件会给出明确报错', async () => {
    const file = new File(['{"hello":1}'], 'x.json', { type: 'application/json' })
    expect((await probeBackupFile(file)).kind).toBe('unknown')
    const bad = new File(['not json at all'], 'x.json', { type: 'application/json' })
    await expect(probeBackupFile(bad)).rejects.toThrow(/不是合法的 JSON/)
  })

  it('换设备全流程：导出 → 清空 → 重新导入 → 数据一致', async () => {
    await setupVault('Trombone7Melon')
    await appendTxns(payload.txns)
    await replaceSnapshots(payload.snapshots)
    const backup = await buildEncryptedBackup(currentPayload(), 'Trombone7Melon')

    // 模拟换到一台干净机器
    await destroyEverything()
    sessionStorage.clear()
    await boot()
    expect(getVaultState().status).toBe('setup')

    await setupVault('Different9Harbor')
    const opened = await openBackupFile(asFile(backup), 'Trombone7Melon')
    await mergeFromBackup(opened.payload)

    expect(currentPayload().txns.map((t) => t.id)).toEqual(['a', 'b'])
    expect(currentPayload().snapshots[0].balance).toBe(4321)
  })
})

describe('DEK 与信封的一致性', () => {
  it('数据体是用 DEK 加密的，用信封里的包装能还原出同一把 DEK', async () => {
    await setupVault('Trombone7Melon')
    await appendTxns([mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 7 })])

    const raw = await currentDekRawForTest()
    const dek = await importDekRaw(raw)
    const blob = await readVaultBlob()
    // 数据体是带填充封装的，必须用 openPaddedJson 解 —— 用 openJson 会先撞见
    // 4 字节长度前缀和尾部填充，报「不是合法 JSON」
    const decrypted = await openPaddedJson<VaultPayload>(dek, blob!.sealed, AAD_VAULT)
    expect(decrypted.txns.map((t) => t.id)).toEqual(['a'])
  })
})

/** 复刻会话存储里的裸 DEK：这是「刷新页面不用重输密码」的物理依据 */
async function currentDekRawForTest() {
  const b64 = sessionStorage.getItem('qianji-lens:dek')
  if (!b64) throw new Error('会话里没有 DEK')
  return fromB64(b64)
}

/** 翻转 base64 密文的第一个字节，模拟文件在传输/存放中被改动 */
function flipFirstByte(b64: string): string {
  const bytes = fromB64(b64)
  bytes[0] ^= 0xff
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** 子串查找（Uint8Array 没有内置的 indexOf 数组版本） */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/* ═══════════ 以下为独立验证发现的问题的回归测试 ═══════════ */

describe('写入串行化（防「导入了却显示没有」）', () => {
  it('两次导入同时发起，两份账单都要在', async () => {
    await setupVault('Trombone7Melon')

    const a = [mkTxn({ id: 'a1', time: '2026-03-01 10:00:00', rawType: '支出', amount: 1 })]
    const b = [mkTxn({ id: 'b1', time: '2026-03-02 10:00:00', rawType: '支出', amount: 2 })]

    // 不 await 第一次就发起第二次 —— 相当于用户连着往页面里拖两份文件。
    // 不做串行化的话，两次都会基于「空库」加密，后写的把先写的整个覆盖掉，
    // 表现就是「导入成功、界面也刷新了，但只剩一份账单」。
    const [ra, rb] = await Promise.all([appendTxns(a), appendTxns(b)])

    expect(ra.inserted + rb.inserted).toBe(2)
    expect(currentPayload().txns.map((t) => t.id).sort()).toEqual(['a1', 'b1'])
  })

  it('三次并发写入的结果是可累加的，不会互相吞', async () => {
    await setupVault('Trombone7Melon')
    await Promise.all([
      appendTxns([mkTxn({ id: 'x', time: '2026-03-01 10:00:00', rawType: '支出', amount: 1 })]),
      replaceSnapshots([{ date: '2026-03-31', name: '招行', balance: 7, group: '资金', includeInNet: true }]),
      appendTxns([mkTxn({ id: 'y', time: '2026-03-03 10:00:00', rawType: '支出', amount: 3 })]),
    ])
    expect(currentPayload().txns.map((t) => t.id).sort()).toEqual(['x', 'y'])
    expect(currentPayload().snapshots).toHaveLength(1)
  })
})

describe('恢复备份时的快照语义', () => {
  const localSnap = { date: '2026-03-31', name: '招行', balance: 100, group: '资金' as const, includeInNet: true }

  it('备份里有快照 → 整表替换，并回报 replaced', async () => {
    await setupVault('Trombone7Melon')
    await replaceSnapshots([localSnap, { ...localSnap, name: '工行' }])

    const r = await mergeFromBackup({
      txns: [],
      snapshots: [{ date: '2026-04-30', name: '招行', balance: 999, group: '资金', includeInNet: true }],
      imports: [],
    })

    expect(r.snapshotsAction).toBe('replaced')
    expect(r.snapshotsRestored).toBe(1)
    expect(currentPayload().snapshots).toHaveLength(1)
    expect(currentPayload().snapshots[0].balance).toBe(999)
  })

  it('备份里没有快照 → 本机快照原样不动，但必须如实回报', async () => {
    await setupVault('Trombone7Melon')
    await replaceSnapshots([localSnap, { ...localSnap, name: '工行' }])

    const r = await mergeFromBackup({ txns: [], snapshots: [], imports: [] })

    // 这是本次修的关键：结果不能是「悄悄保留」。
    // 不说的话，用户会以为看到的余额来自刚恢复的那份备份。
    expect(r.snapshotsAction).toBe('kept-local')
    expect(r.localSnapshotsKept).toBe(2)
    expect(r.snapshotsRestored).toBe(0)
    expect(currentPayload().snapshots).toHaveLength(2)
  })

  it('两边都没有快照 → 回报 none', async () => {
    await setupVault('Trombone7Melon')
    const r = await mergeFromBackup({ txns: [], snapshots: [], imports: [] })
    expect(r.snapshotsAction).toBe('none')
    expect(r.localSnapshotsKept).toBe(0)
  })

  it('流水仍然只合并不覆盖，重复 ID 不会翻倍', async () => {
    await setupVault('Trombone7Melon')
    await appendTxns([mkTxn({ id: 'keep', time: '2026-03-01 10:00:00', rawType: '支出', amount: 1 })])

    const r = await mergeFromBackup({
      txns: [
        mkTxn({ id: 'keep', time: '2026-03-01 10:00:00', rawType: '支出', amount: 1 }),
        mkTxn({ id: 'new', time: '2026-03-05 10:00:00', rawType: '支出', amount: 5 }),
      ],
      snapshots: [],
      imports: [],
    })
    expect(r.txnsInserted).toBe(1)
    expect(r.txnsDuplicated).toBe(1)
    expect(currentPayload().txns).toHaveLength(2)
  })
})

describe('长度不泄漏条数', () => {
  it('1 笔和 50 笔的库，密文长度完全相同', async () => {
    await setupVault('Trombone7Melon')
    await appendTxns([mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 1, note: '备注' })])
    const one = (await readVaultBlob())!.sealed.ct.length

    await appendTxns(
      Array.from({ length: 50 }, (_, i) =>
        mkTxn({ id: `m${i}`, time: '2026-03-01 10:00:00', rawType: '支出', amount: 1 + i, note: '备注' }),
      ),
    )
    const many = (await readVaultBlob())!.sealed.ct.length

    // 不做填充的话这里会差几十倍，裸看 IndexedDB 就知道你记了多少笔账
    expect(many).toBe(one)
  })

  it('1 笔和 50 笔导出的备份文件，大小也完全相同', async () => {
    await setupVault('Trombone7Melon')
    const t = (id: string) => mkTxn({ id, time: '2026-03-01 10:00:00', rawType: '支出', amount: 1, note: '备注' })

    await appendTxns([t('a')])
    const small = JSON.stringify(await buildEncryptedBackup(currentPayload(), 'Backup9Password'))

    await appendTxns(Array.from({ length: 50 }, (_, i) => t(`m${i}`)))
    const large = JSON.stringify(await buildEncryptedBackup(currentPayload(), 'Backup9Password'))

    expect(large.length).toBe(small.length)
  })
})

describe('回滚安全：setup 失败后必须还能重试', () => {
  it('回滚只清信封与数据体，明文表原样保留', async () => {
    await db.txns.bulkPut([mkTxn({ id: 'legacy-x', time: '2026-01-05 09:00:00', rawType: '支出', amount: 20 })])

    await discardVaultRecords()

    expect(await readEnvelope()).toBeNull()
    expect(await readVaultBlob()).toBeNull()
    // 关键：明文一条没少。加密还没被验证成功的时候清掉明文，
    // 是这套设计里唯一真正不可挽回的失败模式。
    expect(await db.txns.count()).toBe(1)
  })

  it('回滚之后重试是一条真能走通的路', async () => {
    await db.txns.bulkPut([mkTxn({ id: 'legacy-x', time: '2026-01-05 09:00:00', rawType: '支出', amount: 20 })])
    await discardVaultRecords()

    await boot()
    expect(getVaultState().status).toBe('setup')
    expect(getVaultState().pending).toEqual({ txnCount: 1, snapshotCount: 0 })

    await setupVault('Trombone7Melon')
    expect(currentPayload().txns.map((t) => t.id)).toEqual(['legacy-x'])
  })
})

describe('此前未被覆盖的公开接口', () => {
  it('verifyPassword 能区分对错密码', async () => {
    await setupVault('Trombone7Melon')
    expect(await verifyPassword('Trombone7Melon')).toBe(true)
    expect(await verifyPassword('Trombone7Melonn')).toBe(false)
  })

  it('vaultFacts 与 hasRecoveryCode 如实反映信封状态', async () => {
    expect(await vaultFacts()).toEqual({ exists: false, hasRecoveryCode: false, createdAt: null })

    await setupVault('Trombone7Melon')
    const facts = await vaultFacts()
    expect(facts.exists).toBe(true)
    expect(facts.hasRecoveryCode).toBe(true)
    expect(typeof facts.createdAt).toBe('number')
    expect(await hasRecoveryCode()).toBe(true)
  })

  it('重新生成恢复码：新码可用，旧码作废', async () => {
    const oldCode = await setupVault('Trombone7Melon')
    await appendTxns([mkTxn({ id: 'a', time: '2026-03-01 10:00:00', rawType: '支出', amount: 9 })])

    const newCode = await reissueRecoveryCode('Trombone7Melon')
    expect(newCode).not.toBe(oldCode)

    lock()
    await expect(resetPasswordWithRecoveryCode(oldCode, 'Nettle3Pebble')).rejects.toThrow(/对不上/)

    lock()
    const thirdCode = await resetPasswordWithRecoveryCode(newCode, 'Nettle3Pebble')
    expect(thirdCode).toHaveLength(24)
    expect(currentPayload().txns).toHaveLength(1)
  })

  it('重新生成恢复码需要验证当前密码 —— 否则走到电脑前的人能自己留后门', async () => {
    const oldCode = await setupVault('Trombone7Melon')
    await expect(reissueRecoveryCode('不对的密码')).rejects.toThrow(/密码不对/)

    // 密码错了就什么都没变，旧码仍然有效
    lock()
    await expect(resetPasswordWithRecoveryCode(oldCode, 'Nettle3Pebble')).resolves.toHaveLength(24)
  })
})
