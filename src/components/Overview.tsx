import { useMemo, useState } from 'react'
import type { AccountSnapshot, Txn } from '../types'
import { buildInsights } from '../core/insights'
import { monthlyFlows, totals } from '../core/stats'
import { replaceSnapshots } from '../core/session'
import { groupOfAccount } from '../core/classify'
import { Badge, Button, Card, CardHeader, Stat } from './ui'
import { fmtMoney, fmtYm, pct } from '../utils/format'

type Draft = Omit<AccountSnapshot, 'id'> & { key: string }

function toDraft(s: AccountSnapshot): Draft {
  return {
    key: String(s.id ?? `${s.name}-${s.date}`),
    date: s.date,
    name: s.name,
    balance: s.balance,
    group: s.group,
    includeInNet: s.includeInNet,
  }
}

function emptyDraft(): Draft {
  const today = new Date().toISOString().slice(0, 10)
  return {
    key: `new-${Math.random().toString(36).slice(2, 9)}`,
    date: today,
    name: '',
    balance: 0,
    group: '资金',
    includeInNet: true,
  }
}

export function Overview({
  txns,
  snapshots,
  onGoData,
}: {
  txns: Txn[]
  snapshots: AccountSnapshot[]
  onGoData: () => void
}) {
  const agg = useMemo(() => totals(txns), [txns])
  const months = useMemo(() => monthlyFlows(txns), [txns])
  const insights = useMemo(() => buildInsights(txns), [txns])

  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [saving, setSaving] = useState(false)

  const nowYm = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
  const complete = months.filter((m) => m.inWindow && m.ym < nowYm)
  const last = complete[complete.length - 1]
  const prev = complete[complete.length - 2]

  const counted = snapshots.filter((s) => s.includeInNet)
  const totalAssets = counted.filter((s) => s.balance > 0).reduce((a, s) => a + s.balance, 0)
  const totalDebts = counted.filter((s) => s.balance < 0).reduce((a, s) => a + s.balance, 0)
  const netWorth = totalAssets + totalDebts
  const excluded = snapshots.filter((s) => !s.includeInNet).reduce((a, s) => a + s.balance, 0)

  function startEdit() {
    setDrafts(snapshots.length > 0 ? snapshots.map(toDraft) : [emptyDraft()])
    setEditing(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const cleaned = drafts
        .filter((d) => d.name.trim() !== '')
        .map((d) => ({
          date: d.date,
          name: d.name.trim(),
          balance: Number.isFinite(d.balance) ? d.balance : 0,
          group: groupOfAccount(d.name),
          includeInNet: d.includeInNet,
        }))
      await replaceSnapshots(cleaned)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="资产快照"
          desc="这里是手动录入的当前余额，不从流水推算——钱迹导出没有期初余额，基金账户也不跟随净值波动，推算出来的数一定是错的。"
          right={
            !editing ? (
              <Button onClick={startEdit}>{snapshots.length > 0 ? '更新余额' : '录入余额'}</Button>
            ) : (
              <div className="flex gap-2">
                <Button onClick={() => setEditing(false)}>取消</Button>
                <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? '保存中…' : '保存'}
                </Button>
              </div>
            )
          }
        />

        {editing ? (
          <div className="px-4 pb-4">
            <p className="text-2xs text-ink-400 mb-3 leading-relaxed">
              账户名照抄钱迹里的写。余额填**当前**数字，负债账户（比如车贷）填负数。
              标了「不计入」的账户（公积金、医保、饭卡、积点）不进净资产。
              <span className="text-expense">
                 「基金」这一行请填基金 App 里显示的真实总金额，不要填钱迹里的数字。
              </span>
            </p>
            <div className="space-y-2">
              {drafts.map((d, i) => (
                <div key={d.key} className="flex flex-wrap items-center gap-2">
                  <input
                    value={d.name}
                    onChange={(e) => {
                      const next = [...drafts]
                      next[i] = { ...d, name: e.target.value }
                      setDrafts(next)
                    }}
                    placeholder="账户名，如 微众银行"
                    className="flex-1 min-w-[140px] rounded-lg border border-ink-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:border-ink-400"
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={d.balance}
                    onChange={(e) => {
                      const next = [...drafts]
                      next[i] = { ...d, balance: Number(e.target.value) }
                      setDrafts(next)
                    }}
                    className="w-32 rounded-lg border border-ink-200 px-2.5 py-1.5 text-[13px] tnum focus:outline-none focus:border-ink-400"
                  />
                  <label className="flex items-center gap-1.5 text-2xs text-ink-500 whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={d.includeInNet}
                      onChange={(e) => {
                        const next = [...drafts]
                        next[i] = { ...d, includeInNet: e.target.checked }
                        setDrafts(next)
                      }}
                    />
                    计入净资产
                  </label>
                  <Button
                    variant="ghost"
                    onClick={() => setDrafts(drafts.filter((x) => x.key !== d.key))}
                  >
                    删除
                  </Button>
                </div>
              ))}
            </div>
            <div className="mt-3">
              <Button onClick={() => setDrafts([...drafts, emptyDraft()])}>+ 添加账户</Button>
            </div>
          </div>
        ) : snapshots.length === 0 ? (
          <div className="px-4 pb-4">
            <div className="rounded-lg bg-ink-50 px-4 py-6 text-center">
              <div className="text-[13px] text-ink-500">还没录入账户余额</div>
              <div className="text-2xs text-ink-400 mt-1.5">
                打开钱迹的「资产」页，把每个账户的余额照抄进来，一分钟的事。
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 divide-x divide-ink-100 border-b border-ink-100">
              <Stat label="净资产" value={fmtMoney(netWorth)} sub={snapshots[0] ? `更新于 ${snapshots[0].date}` : ''} />
              <Stat label="资产合计" value={fmtMoney(totalAssets)} tone="income" />
              <Stat
                label="负债合计"
                value={fmtMoney(totalDebts)}
                tone={totalDebts < 0 ? 'expense' : 'neutral'}
              />
            </div>
            <div className="px-4 py-3">
              <table className="w-full text-[13px]">
                <tbody>
                  {snapshots.map((s) => (
                    <tr key={`${s.name}-${s.id}`} className="border-b border-ink-50 last:border-0">
                      <td className="py-2">
                        <span className={s.includeInNet ? '' : 'text-ink-400'}>{s.name}</span>
                        <span className="ml-2 text-2xs text-ink-300">{s.group}</span>
                        {!s.includeInNet && (
                          <span className="ml-1">
                            <Badge>不计入</Badge>
                          </span>
                        )}
                      </td>
                      <td
                        className={`py-2 text-right tnum ${
                          s.balance < 0 ? 'text-expense' : 'text-ink-900'
                        }`}
                      >
                        {fmtMoney(s.balance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {excluded > 0 && (
                <p className="text-2xs text-ink-400 mt-3">
                  另有 {fmtMoney(excluded)} 属于不计入净资产的账户（公积金、医保、饭卡、积点等），
                  已单列不参与计算。
                </p>
              )}
            </div>
          </>
        )}
      </Card>

      {last && (
        <Card>
          <CardHeader
            title={`${fmtYm(last.ym)} 现金流`}
            desc={last.ym === nowYm ? '' : '最近一个完整月份。当月数据还没结束，不参与对比。'}
          />
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-ink-100 border-b border-ink-100 sm:divide-x">
            <Stat label="收入" value={fmtMoney(last.income)} tone="income" sub={prev ? `上月 ${fmtMoney(prev.income)}` : ''} />
            <Stat label="支出" value={fmtMoney(last.expense)} tone="expense" sub={prev ? `上月 ${fmtMoney(prev.expense)}` : ''} />
            <Stat label="结余" value={fmtMoney(last.net)} />
            <Stat
              label="储蓄率"
              value={last.savingsRate === null ? '—' : pct(last.savingsRate)}
              sub="（收入 − 支出）÷ 收入"
            />
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="值得看一眼的"
          desc="每条都能点开核对原始记录。给不出来依据的洞察宁可不写。"
        />
        <div className="px-4 pb-4">
          {insights.length === 0 ? (
            <div className="rounded-lg bg-ink-50 px-4 py-5 text-center text-2xs text-ink-400">
              数据还不够形成可靠结论。多记几个月再来看。
            </div>
          ) : (
            <ul className="space-y-3">
              {insights.map((ins) => (
                <li key={ins.id} className="rounded-lg border border-ink-100 px-3.5 py-3">
                  <div className="flex items-start gap-2">
                    <Badge tone={ins.tone === 'alert' ? 'alert' : ins.tone === 'good' ? 'good' : 'notice'}>
                      {ins.tone === 'alert' ? '注意' : ins.tone === 'good' ? '不错' : '看看'}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">{ins.title}</div>
                      <p className="text-2xs text-ink-500 mt-1 leading-relaxed">{ins.detail}</p>
                      <p className="text-2xs text-ink-300 mt-1.5">依据：{ins.formula}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {txns.length === 0 && (
        <Card>
          <div className="px-4 py-8 text-center">
            <div className="text-[13px] text-ink-500">还没有流水数据</div>
            <div className="mt-3">
              <Button variant="primary" onClick={onGoData}>
                去导入账单
              </Button>
            </div>
          </div>
        </Card>
      )}

      {txns.length > 0 && (
        <Card>
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-ink-100 sm:divide-x">
            <Stat label="累计收入" value={fmtMoney(agg.income)} tone="income" sub={`${agg.realFlowCount} 笔真实收支`} />
            <Stat label="累计支出" value={fmtMoney(agg.expense)} tone="expense" />
            <Stat label="累计结余" value={fmtMoney(agg.net)} />
            <Stat
              label="流水时间跨度"
              value={agg.dateMin && agg.dateMax ? `${agg.dateMin.slice(0, 7)} 起` : '—'}
              sub={agg.dateMax ? `至 ${agg.dateMax.slice(0, 7)}` : ''}
            />
          </div>
        </Card>
      )}
    </div>
  )
}
