import Dexie, { type Table } from 'dexie'
import type { AccountSnapshot, ImportRecord, Txn } from '../types'
import type { KdfParams, Sealed } from './crypto'

/**
 * 加密保险箱的持久层。
 *
 * GitHub Pages 是纯静态托管，没有后端，数据只存在浏览器 IndexedDB 里。
 * 所以这一层的职责很明确：**IndexedDB 里不允许出现任何明文账单**。
 *
 * 库结构只有两张表：
 *   meta  —— 信封。存 salt、迭代数、被密码包住的 DEK、被恢复码包住的 DEK、校验探针。
 *            这些字段全都不保密（salt/iv 本来就不保密），真正的钥匙是用户的密码。
 *   vault —— 数据体。一个整库打包加密后的密文块 {iv, ct}。
 *
 * 为什么整库打成一个密文块，而不是逐条记录加密：
 *   1. 逐条加密必然要在表上留 id 之外的索引（时间、月份、分类），裸库一看就知道
 *      你哪个月花了多少 —— 加密字段而索引明文，等于没加。
 *   2. 单条记录 put 是一个原子操作。整库打包后，「写入」只有一个原子写，
 *      不存在「改到一半断电、一半新一半旧」的中间态。
 *   3. 1500 笔流水序列化出来不到 1MB，整体加解密是毫秒级，没有任何性能理由拆开。
 */

export interface VaultEnvelope {
  id: 'main'
  version: 2
  createdAt: number
  updatedAt: number
  /** 主密码包住的 DEK */
  pw: {
    kdf: KdfParams
    wrapped: Sealed
    /** 已知明文的加密封装，用来区分「密码错」和「数据坏」 */
    verifier: Sealed
  }
  /** 恢复码包住的 DEK。没有恢复码的旧保险箱会缺这一项 */
  rc?: {
    kdf: KdfParams
    wrapped: Sealed
  }
}

export interface VaultBlob {
  id: 'main'
  updatedAt: number
  sealed: Sealed
}

/** 保险箱解开后的全部内容 */
export interface VaultPayload {
  txns: Txn[]
  snapshots: AccountSnapshot[]
  imports: ImportRecord[]
}

export function emptyPayload(): VaultPayload {
  return { txns: [], snapshots: [], imports: [] }
}

/** 补齐缺字段。备份文件可能来自更早的版本，不能让 undefined 漏进统计代码。 */
export function normalizePayload(input: Partial<VaultPayload> | null | undefined): VaultPayload {
  return {
    txns: Array.isArray(input?.txns) ? input.txns : [],
    snapshots: Array.isArray(input?.snapshots) ? input.snapshots : [],
    imports: Array.isArray(input?.imports) ? input.imports : [],
  }
}

class VaultDB extends Dexie {
  meta!: Table<VaultEnvelope, string>
  vault!: Table<VaultBlob, string>

  /**
   * @deprecated v1 的明文表，仅供迁移时读取一次。
   *
   * 为什么迁移完还留着声明，而不是在 version(2) 里写 `txns: null` 把它删掉：
   * Dexie 的 `stores({ key: null })` 会在升级事务里**直接删除整个对象仓库**，
   * 而升级事务里没法安全地跑 60 万次 PBKDF2（异步耗时会让 IDB 事务自动关闭）。
   * 那就意味着「删表」和「读数据加密」不能在同一处完成，一旦顺序没排好，
   * 用户的历史账单会在加密之前就被抹掉。留成空表零成本，风险却是实打实的。
   */
  txns!: Table<Txn, string>
  /** @deprecated 同上 */
  snapshots!: Table<AccountSnapshot, number>
  /** @deprecated 同上 */
  imports!: Table<ImportRecord, number>

  constructor() {
    super('qianji-lens')
    this.version(1).stores({
      txns: 'id, time, date, ym, kind, category, subCategory, accountFrom, accountTo',
      snapshots: '++id, date, name, group',
      imports: '++id, importedAt',
    })
    // v2 只新增 meta / vault，刻意不动旧表结构
    this.version(2).stores({
      txns: 'id, time, date, ym, kind, category, subCategory, accountFrom, accountTo',
      snapshots: '++id, date, name, group',
      imports: '++id, importedAt',
      meta: 'id',
      vault: 'id',
    })
  }
}

export const db = new VaultDB()

/* ───────────────────────── 信封 ───────────────────────── */

export async function readEnvelope(): Promise<VaultEnvelope | null> {
  return (await db.meta.get('main')) ?? null
}

export async function writeEnvelope(env: VaultEnvelope): Promise<void> {
  await db.meta.put(env)
}

export async function readVaultBlob(): Promise<VaultBlob | null> {
  return (await db.vault.get('main')) ?? null
}

export async function writeVaultBlob(blob: VaultBlob): Promise<void> {
  await db.vault.put(blob)
}

/**
 * 信封和数据体写进**同一个 IndexedDB 事务**。
 *
 * 这是迁移路径上最关键的一个约束：事务要么整体提交、要么整体回滚，
 * 不会留下「信封写了、数据体没写」这种解不开的死局。相比之下分两次写
 * 虽然也能靠「先数据体后信封」的顺序把风险限制在可重试的一侧，
 * 但既然 IndexedDB 本身就提供了原子性，没有理由不用。
 *
 * 事务体内**只做 put**，不夹任何 await crypto —— 密码学计算会让
 * IndexedDB 事务因为长时间没有新请求而自动提交/关闭，那是 Dexie 里最常见的翻车方式。
 */
export async function commitEnvelopeAndBlob(env: VaultEnvelope, blob: VaultBlob): Promise<void> {
  await db.transaction('rw', db.meta, db.vault, async () => {
    await db.vault.put(blob)
    await db.meta.put(env)
  })
}

/* ───────────────────────── 迁移 ───────────────────────── */

/**
 * 读旧版明文表。没有任何数据时返回 null，调用方据此区分
 * 「全新安装」和「有历史数据待加密」。
 */
export async function readLegacyPlaintext(): Promise<VaultPayload | null> {
  const [txns, snapshots, imports] = await Promise.all([
    db.txns.toArray(),
    db.snapshots.toArray(),
    db.imports.toArray(),
  ])
  if (txns.length === 0 && snapshots.length === 0 && imports.length === 0) return null
  return { txns, snapshots, imports }
}

/**
 * 抹掉明文表。加密副本一旦确认落盘，明文就没有继续躺在磁盘上的理由。
 * 启动流程里每次成功解锁都会调用一次，属于自愈 —— 万一上次迁移在
 * 「写好密文」和「清掉明文」之间被打断，这次会补上。
 */
export async function clearLegacyPlaintext(): Promise<void> {
  await db.transaction('rw', db.txns, db.snapshots, db.imports, async () => {
    await db.txns.clear()
    await db.snapshots.clear()
    await db.imports.clear()
  })
}

/** 连信封带数据体一并抹除，用于「彻底重置」。 */
export async function destroyVault(): Promise<void> {
  await db.transaction('rw', db.meta, db.vault, db.txns, db.snapshots, db.imports, async () => {
    await db.meta.clear()
    await db.vault.clear()
    await db.txns.clear()
    await db.snapshots.clear()
    await db.imports.clear()
  })
}

/**
 * 只丢掉信封和数据体，**保留旧版明文表**。
 *
 * 用于 setupVault 的自检失败回滚：那时密文已经提交进库了，如果直接抛错走人，
 * 用户会卡在「有信封但解不开」的状态，重试也只会被告知「已经有一个保险箱了」。
 * 回滚掉信封和数据体之后，重试就是一条真正能走通的路 —— 而且明文还在，
 * 最坏情况下数据一条没少。
 *
 * 刻意不用 destroyVault()：那个连明文表一起清，在「加密还没被验证成功」的时候
 * 清掉明文，正好是这套设计里唯一不可挽回的失败模式。
 */
export async function discardVaultRecords(): Promise<void> {
  await db.transaction('rw', db.meta, db.vault, async () => {
    await db.meta.clear()
    await db.vault.clear()
  })
}
