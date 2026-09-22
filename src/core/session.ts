import { useSyncExternalStore } from 'react'
import type { AccountSnapshot, ImportRecord, Txn } from '../types'
import {
  AAD_DEK,
  AAD_VAULT,
  checkVerifier,
  deriveKek,
  exportDekRaw,
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
  openPaddedJson,
  seal,
  sealJson,
  sealPaddedJson,
  toB64,
  type Bytes,
} from './crypto'
import {
  clearLegacyPlaintext,
  commitEnvelopeAndBlob,
  destroyVault,
  discardVaultRecords,
  emptyPayload,
  normalizePayload,
  readEnvelope,
  readLegacyPlaintext,
  readVaultBlob,
  writeEnvelope,
  writeVaultBlob,
  type VaultEnvelope,
  type VaultPayload,
} from './db'
import { assessPassword } from './password'

/**
 * 保险箱会话。
 *
 * 状态机：loading → setup（还没设密码）/ locked（有密码但没解锁）/ unlocked
 *                 ↘ broken（密文存在但解不开，需要备份文件救援）
 *
 * 密钥策略（这是本文件最需要理解的一段）：
 *  - 解锁后，DEK 存在内存变量里，同时把**裸 DEK** 以 base64 写进 sessionStorage。
 *    因为用户选了「关闭标签页才锁」，刷新页面不能要求重输密码，所以密钥必须
 *    在会话存储里活过一次刷新。关掉标签页 sessionStorage 即蒸发。
 *  - 存 DEK 而不是存密码：DEK 只能解开本机这个保险箱，而密码还能解开所有历史
 *    备份文件。泄露面明显更小，所以宁可存前者。
 *  - 主密码本身从头到尾不落任何存储 —— 它只活在表单控件的输入值和这一次
 *    PBKDF2 调用里。
 */

const SESSION_KEY = 'qianji-lens:dek'

/** 密码最短长度与强度规则见 core/password.ts —— 这里只做转发，避免两份定义漂移 */
export { MIN_PASSWORD_LENGTH } from './password'

export const WRONG_PASSWORD_MESSAGE = '密码不对。'

export type VaultStatus = 'loading' | 'setup' | 'locked' | 'unlocked' | 'broken'

export interface VaultState {
  status: VaultStatus
  /** 已解锁时为全部数据；未解锁时为 null（内存里不留副本） */
  data: VaultPayload | null
  /** 首次设置密码时，本机已有的未加密数据规模 */
  pending: { txnCount: number; snapshotCount: number } | null
  /** 刚刚生成、只应展示一次的恢复码（原始码，不含连字符） */
  freshRecoveryCode: string | null
  /** 页面级错误提示 */
  error: string | null
}

export interface RestoreOutcome {
  txnsInserted: number
  txnsDuplicated: number
  /** 备份文件里带来的快照条数 */
  snapshotsRestored: number
  /**
   * 快照最终怎么处理的。必须回传给 UI 并说出来 ——
   * 「备份里没快照、于是保留了本机快照」这种事一旦不说，用户就会以为
   * 自己看到的余额来自刚恢复的那份备份。
   */
  snapshotsAction: 'replaced' | 'kept-local' | 'none'
  /** snapshotsAction === 'kept-local' 时，本机被保留下来的快照条数 */
  localSnapshotsKept: number
  importsAdded: number
}

const INITIAL: VaultState = {
  status: 'loading',
  data: null,
  pending: null,
  freshRecoveryCode: null,
  error: null,
}

let state: VaultState = INITIAL
let dekKey: CryptoKey | null = null

const listeners = new Set<() => void>()

function set(patch: Partial<VaultState>): void {
  // 每次 set 都换对象引用，useSyncExternalStore 才能感知到变化
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useVault(): VaultState {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

/**
 * 非 React 环境读取当前状态。
 * 只给测试和诊断用 —— 组件一律走 useVault()，否则不会在状态变化时重新渲染。
 * 之所以需要它，是因为 useVault 依赖 React 的 hook 调度，在测试进程里调用会直接报
 * 「Invalid hook call」，那就没法对状态机本身做断言了。
 */
export function getVaultState(): VaultState {
  return state
}

export function setVaultError(message: string | null): void {
  set({ error: message })
}

export function dismissRecoveryCode(): void {
  set({ freshRecoveryCode: null })
}

/* ─────────────────── 会话存储（跨刷新保活） ─────────────────── */

function rememberInSession(raw: Bytes): void {
  try {
    sessionStorage.setItem(SESSION_KEY, toB64(raw))
  } catch {
    // 隐私模式 / 禁用存储：降级为「仅内存」，代价是刷新要重输密码，不影响安全性
  }
}

function forgetSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* 同上，忽略 */
  }
}

async function readSessionKey(): Promise<CryptoKey | null> {
  try {
    const b64 = sessionStorage.getItem(SESSION_KEY)
    if (!b64) return null
    return await importDekRaw(fromB64(b64))
  } catch {
    return null
  }
}

/* ───────────────────────── 启动 ───────────────────────── */

export async function boot(): Promise<void> {
  set({ status: 'loading', error: null, data: null, pending: null, freshRecoveryCode: null })
  try {
    const env = await readEnvelope()

    if (!env) {
      const legacy = await readLegacyPlaintext()
      set({
        status: 'setup',
        pending: legacy
          ? { txnCount: legacy.txns.length, snapshotCount: legacy.snapshots.length }
          : null,
      })
      return
    }

    // 有信封。先看会话里还留着钥匙没有 —— 有就直接进，不重跑 PBKDF2。
    const sessionKey = await readSessionKey()
    if (sessionKey) {
      try {
        await loadWithKey(sessionKey)
        return
      } catch {
        // 钥匙过期/数据被改，退回输密码
        forgetSession()
      }
    }

    dekKey = null
    set({ status: 'locked' })
  } catch (e) {
    set({ status: 'broken', error: describeUnknown(e, '读取本地保险箱失败。') })
  }
}

/** 用一把已知的 DEK 打开数据体，成功则进入解锁态。 */
async function loadWithKey(key: CryptoKey): Promise<void> {
  const blob = await readVaultBlob()
  if (!blob) {
    throw new Error(
      '保险箱信封在，但数据体不见了。这可能是因为外部程序改动过浏览器数据。请用最近一次导出的备份文件恢复。',
    )
  }
  let data: VaultPayload
  try {
    // 带填充解封：数据体加密时填到了 2 的幂，这样 IndexedDB 里那块密文的大小
    // 不会直接暴露「你有多少条账单」
    data = await openPaddedJson<VaultPayload>(key, blob.sealed, AAD_VAULT)
  } catch {
    throw new Error('数据体解密失败。如果你手工改过浏览器数据，请用备份文件恢复。')
  }
  dekKey = key
  set({ status: 'unlocked', data: normalizePayload(data), pending: null, error: null })
  // 密文已经确认可用，明文表没有理由继续留在磁盘上
  void clearLegacyPlaintext().catch(() => undefined)
}

/* ─────────────────────── 首次设置密码 ─────────────────────── */

/**
 * 建立保险箱。若本机已有旧版明文数据，会一并搬进来加密，并清掉明文。
 *
 * 写入顺序（数据安全的关键，不要改）：
 *   1. 先把明文读进内存
 *   2. 在内存里算好密文和信封（所有慢速密码学都在这一步，不占用任何 IDB 事务）
 *   3. **单事务**提交数据体 + 信封，要么都成要么都不成
 *   4. 重新从库里读回来、用内存里的密钥解一遍，确认密文真的能打开
 *   5. 确认无误之后，才去清掉明文表
 *
 * 第 4 步是刻意的冗余。写进去的东西能不能读出来，只有读一次才知道 ——
 * 而第 5 步一旦执行就不可逆。顺序颠倒过来（先清明文再自检）就意味着
 * 「万一密文有问题，明文已经没了」，那是唯一真正不可挽回的失败模式。
 *
 * 返回新生成的恢复码（原始码，不含连字符），调用方必须展示给用户且只展示一次。
 */
export async function setupVault(password: string): Promise<string> {
  assertPasswordShape(password)
  if (await readEnvelope()) throw new Error('这台设备上已经有一个保险箱了。')

  const legacy = await readLegacyPlaintext()
  const payload = legacy ?? emptyPayload()

  const dek = await newDek()
  const rawDek = await exportDekRaw(dek)

  const pwKdf = newKdfParams()
  const pwKek = await deriveKek(password, pwKdf)
  const pwWrapped = await seal(pwKek, rawDek, AAD_DEK)
  const verifier = await makeVerifier(pwKek)

  const recoveryCode = newRecoveryCode()
  const rcKdf = newKdfParams()
  const rcKek = await deriveKek(recoveryCode, rcKdf)
  const rcWrapped = await seal(rcKek, rawDek, AAD_DEK)

  const blob = {
    id: 'main' as const,
    updatedAt: Date.now(),
    sealed: await sealPaddedJson(dek, payload, AAD_VAULT),
  }
  const env: VaultEnvelope = {
    id: 'main',
    version: 2,
    // 本地信封的时间戳刻意保留到毫秒：它只存在于你自己的浏览器里，
    // 没有任何第三方会读到它，对排查问题却有实在价值。
    // 备份文件里的 exportedOn 反过来只精确到日 —— 那个文件是要出门的。
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pw: { kdf: pwKdf, wrapped: pwWrapped, verifier },
    rc: { kdf: rcKdf, wrapped: rcWrapped },
  }

  await commitEnvelopeAndBlob(env, blob)

  // 自检：读回来解一遍，确认刚写下的密文真的能用这把钥匙打开
  const readBack = await readVaultBlob()
  if (!readBack) {
    await discardVaultRecords()
    throw new Error('加密数据写入后读不回来，已经回滚。本机数据没有被删除，请再试一次。')
  }
  try {
    await openPaddedJson<VaultPayload>(dek, readBack.sealed, AAD_VAULT)
  } catch {
    await discardVaultRecords()
    throw new Error('加密数据写入后无法解开，已经回滚。本机数据没有被删除，请再试一次。')
  }

  dekKey = dek
  rememberInSession(rawDek)
  set({ status: 'unlocked', data: payload, pending: null, freshRecoveryCode: recoveryCode, error: null })

  // 到这一步密文才算真的成立，此时清明文不是「赌它还活着」，而是「确认它已经安全」
  await clearLegacyPlaintext()
  return recoveryCode
}

/* ───────────────────────── 解锁 ───────────────────────── */

export async function unlock(password: string): Promise<void> {
  const env = await readEnvelope()
  if (!env) throw new Error('这台设备上还没有保险箱。')

  const kek = await deriveKek(password, env.pw.kdf)
  if (!(await checkVerifier(kek, env.pw.verifier))) throw new Error(WRONG_PASSWORD_MESSAGE)

  let rawDek: Bytes
  try {
    rawDek = new Uint8Array(await open(kek, env.pw.wrapped, AAD_DEK))
  } catch {
    throw new Error('密码校验通过了，但主密钥解不开，说明本地数据被改动过。请用备份文件恢复。')
  }

  const key = await importDekRaw(rawDek)
  await loadWithKey(key)
  rememberInSession(rawDek)
}

export function lock(): void {
  dekKey = null
  forgetSession()
  set({ status: 'locked', data: null, freshRecoveryCode: null, error: null })
}

/** 供「导出备份前确认身份」之类的场景使用。 */
export async function verifyPassword(password: string): Promise<boolean> {
  const env = await readEnvelope()
  if (!env) return false
  return checkVerifier(await deriveKek(password, env.pw.kdf), env.pw.verifier)
}

/* ─────────────────── 修改密码 / 恢复码 ─────────────────── */

/**
 * 改密码 = 用旧密码解出 DEK，再用新密码重新包一次。
 * 数据体一个字节都不用重写，所以是毫秒级的，也不存在「改到一半两边都不对」。
 * 历史备份文件不受影响 —— 每个备份自带独立的 salt 和迭代数，用当时的密码照旧能开。
 */
export async function changePassword(currentPassword: string, nextPassword: string): Promise<void> {
  assertPasswordShape(nextPassword)
  const env = await readEnvelope()
  if (!env) throw new Error('这台设备上还没有保险箱。')

  const oldKek = await deriveKek(currentPassword, env.pw.kdf)
  if (!(await checkVerifier(oldKek, env.pw.verifier))) throw new Error('当前密码不对，没有改动任何东西。')

  let rawDek: Bytes
  try {
    rawDek = new Uint8Array(await open(oldKek, env.pw.wrapped, AAD_DEK))
  } catch {
    throw new Error('主密钥解不开，本地数据可能被改动过。密码未改动。')
  }

  const nextKdf = newKdfParams()
  const nextKek = await deriveKek(nextPassword, nextKdf)
  const nextWrapped = await seal(nextKek, rawDek, AAD_DEK)
  const nextVerifier = await makeVerifier(nextKek)

  await writeEnvelope({
    ...env,
    updatedAt: Date.now(),
    pw: { kdf: nextKdf, wrapped: nextWrapped, verifier: nextVerifier },
  })
}

/**
 * 用恢复码重置主密码，并**同时作废旧恢复码**。
 *
 * 为什么要换新的：旧恢复码一旦被使用过，就应当视为已经暴露（它可能是在
 * 一份泄露的截图、一份被同步到云端的笔记里被找出来的）。继续留着它，
 * 等于在数据上留一把已经亮过相的备份钥匙。
 *
 * 返回新恢复码（原始码），调用方必须展示一次。
 */
export async function resetPasswordWithRecoveryCode(
  recoveryCode: string,
  nextPassword: string,
): Promise<string> {
  assertPasswordShape(nextPassword)
  const env = await readEnvelope()
  if (!env) throw new Error('这台设备上还没有保险箱。')
  if (!env.rc) throw new Error('这个保险箱没有设置恢复码，只能用主密码打开。')

  const normalized = normalizeRecoveryCode(recoveryCode)
  if (!isValidRecoveryCodeShape(normalized)) {
    throw new Error('恢复码格式不对：应该是 24 位，只含字母和数字，且不含 0、1、O、I。')
  }

  const rcKek = await deriveKek(normalized, env.rc.kdf)
  let rawDek: Bytes
  try {
    rawDek = new Uint8Array(await open(rcKek, env.rc.wrapped, AAD_DEK))
  } catch {
    throw new Error('这个恢复码对不上。')
  }

  const nextKdf = newKdfParams()
  const nextKek = await deriveKek(nextPassword, nextKdf)
  const pwWrapped = await seal(nextKek, rawDek, AAD_DEK)
  const verifier = await makeVerifier(nextKek)

  const freshCode = newRecoveryCode()
  const rcKdf = newKdfParams()
  const rcKekNew = await deriveKek(freshCode, rcKdf)
  const rcWrapped = await seal(rcKekNew, rawDek, AAD_DEK)

  await writeEnvelope({
    ...env,
    updatedAt: Date.now(),
    pw: { kdf: nextKdf, wrapped: pwWrapped, verifier },
    rc: { kdf: rcKdf, wrapped: rcWrapped },
  })

  // 重置的终点必须是「人已经进去了」。只换信封不打开数据体的话，
  // 用户会在输完恢复码和新密码之后被弹回锁屏，以为自己弄错了。
  const key = await importDekRaw(rawDek)
  await loadWithKey(key)
  rememberInSession(rawDek)
  set({ freshRecoveryCode: freshCode, error: null })
  return freshCode
}

/** 记得密码、只是把恢复码丢了/想换一条。 */
export async function reissueRecoveryCode(currentPassword: string): Promise<string> {
  const env = await readEnvelope()
  if (!env) throw new Error('这台设备上还没有保险箱。')

  const kek = await deriveKek(currentPassword, env.pw.kdf)
  if (!(await checkVerifier(kek, env.pw.verifier))) throw new Error('密码不对，没有生成新的恢复码。')

  let rawDek: Bytes
  try {
    rawDek = new Uint8Array(await open(kek, env.pw.wrapped, AAD_DEK))
  } catch {
    throw new Error('主密钥解不开，本地数据可能被改动过。')
  }

  const freshCode = newRecoveryCode()
  const rcKdf = newKdfParams()
  const rcKek = await deriveKek(freshCode, rcKdf)
  const rcWrapped = await seal(rcKek, rawDek, AAD_DEK)

  await writeEnvelope({ ...env, updatedAt: Date.now(), rc: { kdf: rcKdf, wrapped: rcWrapped } })
  set({ freshRecoveryCode: freshCode, error: null })
  return freshCode
}

export async function hasRecoveryCode(): Promise<boolean> {
  const env = await readEnvelope()
  return Boolean(env?.rc)
}

/** 设置密码页要展示的「本机现状」，不含任何机密 */
export async function vaultFacts(): Promise<{ exists: boolean; hasRecoveryCode: boolean; createdAt: number | null }> {
  const env = await readEnvelope()
  return { exists: Boolean(env), hasRecoveryCode: Boolean(env?.rc), createdAt: env?.createdAt ?? null }
}

/* ───────────────────────── 写入 ───────────────────────── */

/**
 * 落盘顺序：先写密文，再更新内存状态。
 * 反过来的话，IndexedDB 写入失败时界面会显示「已导入」而磁盘上什么都没有 ——
 * 对财务数据来说，宁可报错让用户重试，也不能给一个成功假象。
 */
/**
 * 写入串行化。
 *
 * 每次落盘都是「读当前内存快照 → 加密整块 → 写回」。如果两个操作同时在飞
 * （用户快速连着导入两份文件就是这种情形），后启动的那个会基于**过期快照**加密，
 * 把先完成的那次写入整个覆盖掉 —— 现象是「进度条走完了、界面也刷新了，但数据没了」。
 *
 * 关键点：不能只把 persist 排队，必须把每个操作的**读-改-写整段**排进队列。
 * 快照如果是在队列外读的，排队也救不了它已经过期这个事实。
 */
let writeChain: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  // 队列本身不能被某一次失败掐断，否则后面所有写入都会静默不执行
  writeChain = run.catch(() => undefined)
  return run
}

/**
 * 真正落盘：先写密文，再更新内存状态。
 * 反过来的话，IndexedDB 写入失败时界面会显示「已导入」而磁盘上什么都没有 ——
 * 对财务数据来说，宁可报错让用户重试，也不能给一个成功假象。
 * 只能从队列内部调用（直接调会绕过串行化）。
 */
async function persistNow(next: VaultPayload): Promise<void> {
  if (!dekKey) throw new Error('保险箱未解锁。')
  const sealed = await sealPaddedJson(dekKey, next, AAD_VAULT)
  await writeVaultBlob({ id: 'main', updatedAt: Date.now(), sealed })
  set({ data: next })
}

/** 对外的落盘入口（排队执行）。 */
export function persist(next: VaultPayload): Promise<void> {
  return enqueue(() => persistNow(next))
}

function requireData(): VaultPayload {
  if (!dekKey || !state.data) throw new Error('保险箱未解锁。')
  return state.data
}

/** 供备份等只读场景使用。未解锁时抛错，调用方必须处理。 */
export function currentPayload(): VaultPayload {
  return requireData()
}

/**
 * 按 ID 去重后入库。与旧版一致：现有 ID 一次性读进内存比对，
 * 万条量级下这比逐条查库快得多。
 */
export function appendTxns(incoming: Txn[]): Promise<{ inserted: number; duplicated: number }> {
  return enqueue(async () => {
    const current = requireData()
    if (incoming.length === 0) return { inserted: 0, duplicated: 0 }

    const known = new Set(current.txns.map((t) => t.id))
    const fresh: Txn[] = []
    for (const t of incoming) {
      if (known.has(t.id)) continue
      known.add(t.id)
      fresh.push(t)
    }

    if (fresh.length > 0) {
      await persistNow({ ...current, txns: [...current.txns, ...fresh] })
    }
    return { inserted: fresh.length, duplicated: incoming.length - fresh.length }
  })
}

export function addImportRecord(rec: ImportRecord): Promise<void> {
  return enqueue(async () => {
    const current = requireData()
    await persistNow({ ...current, imports: [...current.imports, rec] })
  })
}

/**
 * 快照是整表覆盖，不是追加。
 * 它代表「此刻各账户是多少钱」这一份状态，没有历史版本语义。
 */
export function replaceSnapshots(list: AccountSnapshot[]): Promise<void> {
  return enqueue(async () => {
    const current = requireData()
    await persistNow({ ...current, snapshots: list })
  })
}

/**
 * 从备份恢复。流水按 ID **合并**而不是覆盖 ——
 * 覆盖式恢复会让「恢复一份旧备份把新账冲掉」成为可能，这个坑不能踩。
 */
export function mergeFromBackup(payload: VaultPayload): Promise<RestoreOutcome> {
  return enqueue(async () => {
    const current = requireData()

    const known = new Set(current.txns.map((t) => t.id))
    const freshTxns: Txn[] = []
    for (const t of payload.txns) {
      if (known.has(t.id)) continue
      known.add(t.id)
      freshTxns.push(t)
    }

    const seenImports = new Set(current.imports.map((r) => `${r.fileName}|${r.importedAt}`))
    const freshImports = payload.imports.filter((r) => !seenImports.has(`${r.fileName}|${r.importedAt}`))

    /*
     * 快照只有两种干净语义：「备份里有 → 整表覆盖」和「备份里没有 → 本机原样不动」。
     * 危险的是第三种 —— 偷偷选一个还不告诉用户。那会造出一个很难发现的假象：
     * 你以为看到的是旧电脑上那份余额，其实是新电脑上的。这个项目在「资产总览」上
     * 最忌讳的就是这种自我欺骗，所以结果必须显式回传给 UI，让它说出来。
     */
    let snapshots = current.snapshots
    let snapshotsAction: RestoreOutcome['snapshotsAction'] = 'none'
    let localSnapshotsKept = 0
    if (payload.snapshots.length > 0) {
      snapshots = payload.snapshots.map((s) => ({ ...s, id: undefined }))
      snapshotsAction = 'replaced'
    } else if (current.snapshots.length > 0) {
      localSnapshotsKept = current.snapshots.length
      snapshotsAction = 'kept-local'
    }

    await persistNow({
      txns: [...current.txns, ...freshTxns],
      snapshots,
      imports: [...current.imports, ...freshImports],
    })

    return {
      txnsInserted: freshTxns.length,
      txnsDuplicated: payload.txns.length - freshTxns.length,
      snapshotsRestored: payload.snapshots.length,
      snapshotsAction,
      localSnapshotsKept,
      importsAdded: freshImports.length,
    }
  })
}

/** 清空账面数据，但保留保险箱、密码、恢复码 —— 目的是重新导入而非放弃加密。 */
export function wipeVaultData(): Promise<void> {
  return enqueue(() => persistNow(emptyPayload()))
}

/** 连保险箱一起拆掉，回到「首次设置密码」。不可撤销。 */
export function destroyEverything(): Promise<void> {
  // 走队列：不要和一个正在飞行的写入抢同一块数据
  return enqueue(async () => {
    await destroyVault()
    dekKey = null
    forgetSession()
    set({ ...INITIAL, status: 'setup' })
  })
}

/* ───────────────────────── 工具 ───────────────────────── */

/**
 * 只在**设置/修改**密码时调用，绝不在解锁时调用 ——
 * 门槛只能加在「新钥匙」上，不能因为规则变严就把用户自己锁在门外。
 */
function assertPasswordShape(password: string): void {
  const a = assessPassword(password)
  if (!a.acceptable) {
    const reasons = a.issues.map((i) => i.message)
    throw new Error(
      reasons.length > 0
        ? `这个密码不够用：\n· ${reasons.join('\n· ')}`
        : `这个密码强度不足（估算约 ${a.bits} bit，需要至少 50 bit）。`,
    )
  }
}

function describeUnknown(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

/** 仅测试与调试用：当前是否持有内存密钥 */
export function hasSessionKey(): boolean {
  return dekKey !== null
}
