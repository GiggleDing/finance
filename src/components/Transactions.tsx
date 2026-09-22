import { useMemo, useState } from 'react'
import type { Txn, TxnKind } from '../types'
import { accountList } from '../core/stats'
import { Button, Card, CardHeader } from './ui'
import { amountToneClass, fmtNum, kindLabel, signedAmount } from '../utils/format'

const KINDS: TxnKind[] = [
  'expense',
  'income',
  'transfer',
  'debt_repay',
  'debt_borrow',
  'debt_lend',
  'debt_collect',
  'refund',
  'reimburse',
  'unknown',
]

const PAGE_SIZE = 100

export function Transactions({ txns }: { txns: Txn[] }) {
  const [kind, setKind] = useState<TxnKind | 'all'>('all')
  const [category, setCategory] = useState('all')
  const [account, setAccount] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(0)

  const categories = useMemo(() => {
    const set = new Set(txns.map((t) => t.category).filter(Boolean))
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }, [txns])

  const accounts = useMemo(() => accountList(txns), [txns])

  const filtered = useMemo(() => {
    const k = keyword.trim()
    return txns
      .filter((t) => {
        if (kind !== 'all' && t.kind !== kind) return false
        if (category !== 'all' && t.category !== category) return false
        if (account !== 'all' && t.accountFrom !== account && t.accountTo !== account) return false
        if (k) {
          const hay = `${t.category} ${t.subCategory} ${t.note} ${t.accountFrom} ${t.accountTo}`
          if (!hay.includes(k)) return false
        }
        return true
      })
      .sort((a, b) => b.time.localeCompare(a.time))
  }, [txns, kind, category, account, keyword])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  const sum = filtered.reduce((a, t) => {
    if (t.kind === 'expense') return a - t.amount
    if (t.kind === 'income') return a + t.amount
    if (t.kind === 'refund' || t.kind === 'reimburse') return a + t.amount
    return a
  }, 0)

  function reset() {
    setKind('all')
    setCategory('all')
    setAccount('all')
    setKeyword('')
    setPage(0)
  }

  const selectCls =
    'rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-[13px] text-ink-700 focus:outline-none focus:border-ink-400'

  return (
    <Card>
      <CardHeader
        title="全部流水"
        desc={`共 ${txns.length} 笔。这里展示的是钱迹里的原始记录，转账、还贷、退款、报销都保留原样，方便你回溯。`}
      />

      <div className="px-4 pb-3 flex flex-wrap gap-2 items-center">
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as TxnKind | 'all')
            setPage(0)
          }}
          className={selectCls}
        >
          <option value="all">全部类型</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>

        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value)
            setPage(0)
          }}
          className={selectCls}
        >
          <option value="all">全部分类</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <select
          value={account}
          onChange={(e) => {
            setAccount(e.target.value)
            setPage(0)
          }}
          className={selectCls}
        >
          <option value="all">全部账户</option>
          {accounts.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>

        <input
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value)
            setPage(0)
          }}
          placeholder="搜备注 / 分类 / 账户"
          className={`${selectCls} flex-1 min-w-[160px]`}
        />

        <Button variant="ghost" onClick={reset}>
          重置
        </Button>
      </div>

      <div className="px-4 pb-2 flex items-center gap-3 text-2xs text-ink-400">
        <span>筛出 {filtered.length} 笔</span>
        <span>
          收支净额 <span className={`tnum ${sum < 0 ? 'text-expense' : 'text-income'}`}>{fmtNum(sum)}</span>
        </span>
        {pageCount > 1 && (
          <span className="ml-auto">
            第 {safePage + 1} / {pageCount} 页
          </span>
        )}
      </div>

      <div className="px-4 pb-4 overflow-x-auto">
        <table className="w-full text-[13px] min-w-[640px]">
          <thead>
            <tr className="text-2xs text-ink-400 border-b border-ink-100">
              <th className="text-left font-normal py-2 w-32">时间</th>
              <th className="text-left font-normal py-2 w-16">类型</th>
              <th className="text-left font-normal py-2">分类</th>
              <th className="text-right font-normal py-2 w-24">金额</th>
              <th className="text-left font-normal py-2 w-32 pl-3">账户</th>
              <th className="text-left font-normal py-2 pl-3">备注</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-b border-ink-50 last:border-0 hover:bg-ink-50">
                <td className="py-1.5 tnum text-ink-500 whitespace-nowrap">{t.time.slice(0, 16)}</td>
                <td className="py-1.5 text-ink-500 whitespace-nowrap">{kindLabel(t.kind)}</td>
                <td className="py-1.5">
                  <span>{t.category || '—'}</span>
                  {t.subCategory && <span className="text-ink-400 text-2xs"> / {t.subCategory}</span>}
                </td>
                <td className={`py-1.5 text-right tnum ${amountToneClass(t.kind, t.amount)}`}>
                  {signedAmount(t.kind, t.amount)}
                </td>
                <td className="py-1.5 pl-3 text-ink-500 whitespace-nowrap">
                  {t.accountFrom}
                  {t.accountTo && <span className="text-ink-300"> → {t.accountTo}</span>}
                </td>
                <td className="py-1.5 pl-3 text-ink-400 max-w-[220px] truncate" title={t.note}>
                  {t.note || ''}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-10 text-center text-2xs text-ink-400">
                  没有符合条件的记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="px-4 pb-4 flex items-center justify-center gap-2">
          <Button onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0}>
            上一页
          </Button>
          <span className="text-2xs text-ink-400 tnum">
            {safePage + 1} / {pageCount}
          </span>
          <Button
            onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
            disabled={safePage >= pageCount - 1}
          >
            下一页
          </Button>
        </div>
      )}
    </Card>
  )
}
