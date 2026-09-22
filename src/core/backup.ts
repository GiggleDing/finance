import type { AccountSnapshot, Txn } from '../types'
import { db, importTxns, saveSnapshots } from './db'

/**
 * 本地全量备份。
 *
 * 为什么这是必需品而不是加分项：GitHub Pages 是纯静态托管，数据只存在浏览器
 * IndexedDB 里。用户清一次浏览器数据、换一台电脑，账就全没了。钱迹那边也拿不回来
 * 已经导入的分析配置。所以导入完立刻备份这个动作，要在 UI 上主动提示。
 */
export interface BackupFile {
  app: 'qianji-lens'
  version: 1
  exportedAt: string
  txnCount: number
  snapshotCount: number
  txns: Txn[]
  snapshots: AccountSnapshot[]
}

export async function buildBackup(): Promise<BackupFile> {
  const [txns, snapshots] = await Promise.all([db.txns.toArray(), db.snapshots.toArray()])
  return {
    app: 'qianji-lens',
    version: 1,
    exportedAt: new Date().toISOString(),
    txnCount: txns.length,
    snapshotCount: snapshots.length,
    txns,
    snapshots,
  }
}

export function downloadBackup(backup: BackupFile): string {
  const stamp = new Date().toISOString().slice(0, 10)
  const fileName = `qianji-lens-backup-${stamp}.json`
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  return fileName
}

export interface RestoreResult {
  txnsInserted: number
  txnsDuplicated: number
  snapshotsRestored: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * 从备份恢复。采用**合并**而非覆盖：按 ID 去重后补齐，避免"恢复旧备份把新账冲掉"。
 * 快照是整表覆盖（它本来就是一份当前状态，没有历史版本语义）。
 */
export async function restoreBackup(file: File): Promise<RestoreResult> {
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('文件不是合法的 JSON，请确认选的是本系统导出的备份文件')
  }
  if (!isRecord(parsed) || parsed.app !== 'qianji-lens') {
    throw new Error('这不是「账本透视」的备份文件')
  }

  const txns = Array.isArray(parsed.txns) ? (parsed.txns as Txn[]) : []
  const snapshots = Array.isArray(parsed.snapshots) ? (parsed.snapshots as AccountSnapshot[]) : []

  const outcome = await importTxns(txns)
  if (snapshots.length > 0) {
    await saveSnapshots(snapshots.map((s) => ({ ...s, id: undefined })))
  }

  return {
    txnsInserted: outcome.inserted,
    txnsDuplicated: outcome.duplicated,
    snapshotsRestored: snapshots.length,
  }
}
