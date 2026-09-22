import type { Txn } from '../src/types'
import { normalizeKind } from '../src/core/classify'

let seq = 0

/**
 * 构造一条账单。默认值模仿钱迹导出的真实形态：
 * 金额恒正、时间 'YYYY-MM-DD HH:mm:ss'、账户1 必有值、账户2 通常为空。
 */
export function mkTxn(over: Partial<Txn> & Pick<Txn, 'time' | 'rawType' | 'amount'>): Txn {
  seq += 1
  const date = over.time.slice(0, 10)
  return {
    id: over.id ?? `t${seq}`,
    time: over.time,
    date: over.date ?? date,
    ym: over.ym ?? date.slice(0, 7),
    ledger: over.ledger ?? '日常账本',
    category: over.category ?? '',
    subCategory: over.subCategory ?? '',
    rawType: over.rawType,
    kind: over.kind ?? normalizeKind(over.rawType),
    amount: over.amount,
    currency: over.currency ?? 'CNY',
    accountFrom: over.accountFrom ?? '',
    accountTo: over.accountTo ?? '',
    note: over.note ?? '',
    reimbursed: over.reimbursed ?? '',
    relatedId: over.relatedId ?? '',
    importedAt: over.importedAt ?? 0,
  }
}
