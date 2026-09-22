import { useVault } from '../core/session'
import type { AccountSnapshot, Txn } from '../types'

export interface LensData {
  txns: Txn[]
  snapshots: AccountSnapshot[]
  loading: boolean
}

/**
 * 全量数据加载。
 *
 * 实现方式是直接从保险箱会话里取内存副本 —— 不再单独查一次 IndexedDB。
 * 这是加密改造后顺带得到的好处：数据只有「内存里的明文」和「磁盘上的密文」
 * 两种形态，界面永远读前者，所以不存在「界面读到的还是旧明文」这类不一致。
 * 也因此这个 hook 不再需要 reload()：写入方（core/session）改完就会通知订阅者。
 *
 * 账单量级（万条以内）一次性读入内存，所有聚合都在内存里算。
 */
export function useLensData(): LensData {
  const { status, data } = useVault()
  return {
    txns: data?.txns ?? [],
    snapshots: data?.snapshots ?? [],
    loading: status === 'loading',
  }
}
