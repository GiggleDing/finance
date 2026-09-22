import Dexie, { type Table } from 'dexie'
import type { AccountSnapshot, ImportRecord, Txn } from '../types'

/**
 * 本地库。GitHub Pages 是纯静态托管，没有后端，所有数据只存在浏览器 IndexedDB 里。
 * 因此「备份导出」不是可选项，是数据保命通道 —— 见 core/backup.ts。
 */
export class LensDB extends Dexie {
  txns!: Table<Txn, string>
  snapshots!: Table<AccountSnapshot, number>
  imports!: Table<ImportRecord, number>

  constructor() {
    super('qianji-lens')
    // 版本号只在表结构变化时递增，并向下降级兼容（Dexie 会保留旧字段）
    this.version(1).stores({
      txns: 'id, time, date, ym, kind, category, subCategory, accountFrom, accountTo',
      snapshots: '++id, date, name, group',
      imports: '++id, importedAt',
    })
  }
}

export const db = new LensDB()

export interface ImportOutcome {
  inserted: number
  duplicated: number
}

/**
 * 按 ID 去重后入库。
 * 现有 ID 一次性读入内存比对 —— 账单量级（万条以内）下这比逐条查询快得多。
 */
export async function importTxns(txns: Txn[]): Promise<ImportOutcome> {
  if (txns.length === 0) return { inserted: 0, duplicated: 0 }
  const existingIds = new Set(await db.txns.toCollection().primaryKeys())
  const fresh = txns.filter((t) => !existingIds.has(t.id))
  const duplicated = txns.length - fresh.length
  if (fresh.length > 0) await db.txns.bulkPut(fresh)
  return { inserted: fresh.length, duplicated }
}

export async function recordImport(rec: ImportRecord): Promise<void> {
  await db.imports.add(rec)
}

export async function allTxns(): Promise<Txn[]> {
  return db.txns.toArray()
}

export async function latestSnapshots(): Promise<AccountSnapshot[]> {
  return db.snapshots.toArray()
}

export async function saveSnapshots(list: AccountSnapshot[]): Promise<void> {
  await db.transaction('rw', db.snapshots, async () => {
    await db.snapshots.clear()
    await db.snapshots.bulkAdd(list)
  })
}

export async function wipeAll(): Promise<void> {
  await db.transaction('rw', db.txns, db.snapshots, db.imports, async () => {
    await db.txns.clear()
    await db.snapshots.clear()
    await db.imports.clear()
  })
}
