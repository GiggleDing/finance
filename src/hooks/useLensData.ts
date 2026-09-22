import { useCallback, useEffect, useState } from 'react'
import { allTxns, latestSnapshots } from '../core/db'
import type { AccountSnapshot, Txn } from '../types'

export interface LensData {
  txns: Txn[]
  snapshots: AccountSnapshot[]
  loading: boolean
  reload: () => Promise<void>
}

/**
 * 全量数据加载。账单量级（万条以内）一次性读入内存即可，
 * 所有聚合都在内存里算，避免为每个视图做一次 IndexedDB 查询。
 */
export function useLensData(): LensData {
  const [txns, setTxns] = useState<Txn[]>([])
  const [snapshots, setSnapshots] = useState<AccountSnapshot[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [t, s] = await Promise.all([allTxns(), latestSnapshots()])
      setTxns(t)
      setSnapshots(s)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { txns, snapshots, loading, reload }
}
