import type { Txn } from '../types'
import { EFFECTIVE_WINDOW_START } from '../types'
import { expenseByCategory, expenseBySubCategory, monthlyFlows, type MonthStat } from './stats'

/**
 * 建议引擎。硬约束（经产品评审确认）：
 *  - **最多 3 条**。宁可不说，也不灌水。
 *  - **每条必须能从原始记录复算**，evidenceIds 指向真实流水，formula 写清算式。
 *  - 明确不做的伪洞察：收益率/年化、2026-02 之前的趋势、"跑赢基准"、择时建议、
 *    未来现金流预测、"理财收益能力"。
 */
export interface Insight {
  id: string
  tone: 'alert' | 'notice' | 'good'
  title: string
  detail: string
  /** 支撑结论的原始流水 ID，UI 可展开逐条核对 */
  evidenceIds: string[]
  /** 一句话写清算法，让用户能自己验证 */
  formula: string
}

/** 完整月份的判定：窗口内最后一个月份若未过完，不拿它做环比 */
function completeMonths(months: MonthStat[]): MonthStat[] {
  const inWin = months.filter((m) => m.inWindow)
  if (inWin.length === 0) return []
  const now = new Date()
  const nowYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return inWin.filter((m) => m.ym < nowYm)
}

/** 环比突变：某分类较上月翻倍且绝对额可观 */
function detectCategoryShift(txns: Txn[], months: MonthStat[]): Insight | null {
  const complete = completeMonths(months)
  if (complete.length < 2) return null
  const cur = complete[complete.length - 1]
  const prev = complete[complete.length - 2]

  const curCats = expenseByCategory(txns, { from: cur.ym, to: cur.ym })
  const prevCats = expenseByCategory(txns, { from: prev.ym, to: prev.ym })
  const prevMap = new Map(prevCats.map((c) => [c.category, c.amount]))

  let best: { category: string; cur: number; prev: number; delta: number } | null = null
  for (const c of curCats) {
    const pb = prevMap.get(c.category) ?? 0
    // 上月基数太小（<100）时比值没意义，直接跳过
    if (pb < 100) continue
    if (c.amount > pb * 2) {
      const delta = c.amount - pb
      if (!best || delta > best.delta) best = { category: c.category, cur: c.amount, prev: pb, delta }
    }
  }
  if (!best) return null

  const ids = txns
    .filter((t) => t.ym === cur.ym && t.category === best!.category && t.kind === 'expense')
    .map((t) => t.id)
  if (ids.length === 0) return null

  return {
    id: 'category-shift',
    tone: 'alert',
    title: `${best.category}这个月比上月多花了 ¥${best.delta.toFixed(2)}`,
    detail: `${cur.ym} 花了 ¥${best.cur.toFixed(2)}，${prev.ym} 是 ¥${best.prev.toFixed(2)}，涨了 ${(
      (best.cur / best.prev - 1) * 100
    ).toFixed(0)}%。`,
    evidenceIds: ids,
    formula: `${cur.ym}「${best.category}」合计 ÷ ${prev.ym} 同分类合计 − 1`,
  }
}

/** 结构问题：单一分类占比过高（用户「其它」占支出 46%），下钻提示 */
function detectStructure(txns: Txn[], months: MonthStat[]): Insight | null {
  const complete = completeMonths(months)
  const range = complete.length > 0 ? { from: complete[0].ym, to: complete[complete.length - 1].ym } : undefined
  const cats = expenseByCategory(txns, range)
  if (cats.length === 0) return null
  const top = cats[0]
  if (top.share < 0.35) return null

  const subs = expenseBySubCategory(txns, range).filter((s) => s.category === top.category)
  const subSum = subs.reduce((a, s) => a + s.amount, 0)
  const ids = txns
    .filter((t) => t.kind === 'expense' && t.category === top.category)
    .map((t) => t.id)

  const topSubs = subs
    .slice(0, 3)
    .map((s) => `${s.subCategory} ¥${s.amount.toFixed(0)}`)
    .join('、')

  return {
    id: 'structure',
    tone: 'notice',
    title: `「${top.category}」占了支出的 ${(top.share * 100).toFixed(0)}%`,
    detail: `合计 ¥${top.amount.toFixed(2)}，${top.count} 笔。金额最大的几项是：${topSubs}。这个口袋里装的东西太杂，建议在钱迹里拆成更具体的二级分类，否则趋势看不出问题。`,
    evidenceIds: ids,
    formula: `「${top.category}」支出合计 ÷ 全部支出合计${range ? `（${range.from} ~ ${range.to}）` : ''}`,
  }
}

/** 储蓄率。用户确认工资基本每月都记，所以这个指标可用 */
function detectSavings(months: MonthStat[]): Insight | null {
  const complete = completeMonths(months)
  if (complete.length === 0) return null
  const last = complete[complete.length - 1]
  if (last.savingsRate === null || last.income <= 0) return null

  const rate = last.savingsRate
  if (rate >= 0.3) {
    return {
      id: 'savings-good',
      tone: 'good',
      title: `${last.ym} 存下了收入的 ${(rate * 100).toFixed(0)}%`,
      detail: `收入 ¥${last.income.toFixed(2)}，支出 ¥${last.expense.toFixed(2)}，结余 ¥${last.net.toFixed(2)}。`,
      evidenceIds: [],
      formula: `（收入 − 支出）÷ 收入，取 ${last.ym}`,
    }
  }
  if (rate < 0.1) {
    return {
      id: 'savings-low',
      tone: rate < 0 ? 'alert' : 'notice',
      title:
        rate < 0
          ? `${last.ym} 支出超过了收入`
          : `${last.ym} 只存下收入的 ${(rate * 100).toFixed(0)}%`,
      detail: `收入 ¥${last.income.toFixed(2)}，支出 ¥${last.expense.toFixed(2)}，结余 ¥${last.net.toFixed(2)}。`,
      evidenceIds: [],
      formula: `（收入 − 支出）÷ 收入，取 ${last.ym}`,
    }
  }
  return null
}

/** 高频小额：笔数多、单笔小，累计起来不小 */
function detectSmallFrequent(txns: Txn[], months: MonthStat[]): Insight | null {
  const complete = completeMonths(months)
  const range = complete.length > 0 ? { from: complete[0].ym, to: complete[complete.length - 1].ym } : undefined
  const subs = expenseBySubCategory(txns, range).filter((s) => s.amount > 0)
  const cand = subs.filter((s) => s.count >= 40 && s.amount / s.count < 20)
  if (cand.length === 0) return null
  const top = cand.sort((a, b) => b.amount - a.amount)[0]
  const avg = top.amount / top.count

  const ids = txns
    .filter(
      (t) =>
        t.kind === 'expense' &&
        t.category === top.category &&
        t.subCategory === top.subCategory &&
        (!range || (t.ym >= (range.from ?? '') && t.ym <= (range.to ?? '9999-99'))),
    )
    .map((t) => t.id)

  return {
    id: 'small-frequent',
    tone: 'notice',
    title: `「${top.subCategory}」${top.count} 笔，平均每笔 ¥${avg.toFixed(2)}`,
    detail: `合计 ¥${top.amount.toFixed(2)}。单笔不起眼，但笔数堆起来是笔不小的开销。`,
    evidenceIds: ids,
    formula: `「${top.category}／${top.subCategory}」的笔数与金额合计`,
  }
}

/** 固定支出：同一分类每月出现相近金额 */
function detectFixedCost(txns: Txn[], months: MonthStat[]): Insight | null {
  const complete = completeMonths(months)
  if (complete.length < 2) return null
  const windowed = txns.filter((t) => complete.some((m) => m.ym === t.ym) && t.kind === 'expense')

  const byMonth = new Map<string, Map<string, number>>()
  for (const t of windowed) {
    const key = `${t.category}／${t.subCategory || t.category}`
    const inner = byMonth.get(t.ym) ?? new Map<string, number>()
    inner.set(key, (inner.get(key) ?? 0) + t.amount)
    byMonth.set(t.ym, inner)
  }

  const counts = new Map<string, { months: number; total: number }>()
  for (const inner of byMonth.values()) {
    for (const [key, amt] of inner) {
      const e = counts.get(key) ?? { months: 0, total: 0 }
      e.months += 1
      e.total += amt
      counts.set(key, e)
    }
  }

  const fixed = [...counts.entries()]
    .filter(([, v]) => v.months >= complete.length * 0.8)
    .sort((a, b) => b[1].total / b[1].months - a[1].total / a[1].months)
  if (fixed.length === 0) return null

  const [key, v] = fixed[0]
  const perMonth = v.total / v.months
  return {
    id: 'fixed-cost',
    tone: 'notice',
    title: `「${key}」每月固定支出约 ¥${perMonth.toFixed(2)}`,
    detail: `在统计窗口的 ${v.months} 个月里每月都出现，合计 ¥${v.total.toFixed(2)}。这笔钱在你能省的范围之外，做预算时应先扣掉。`,
    evidenceIds: [],
    formula: `该分类在窗口内每个月的合计，取每月都出现的项`,
  }
}

export function buildInsights(txns: Txn[]): Insight[] {
  const windowed = txns.filter((t) => t.ym >= EFFECTIVE_WINDOW_START)
  if (windowed.length === 0) return []
  const months = monthlyFlows(windowed)

  const candidates: (Insight | null)[] = [
    detectCategoryShift(windowed, months),
    detectStructure(windowed, months),
    detectSavings(months),
    detectSmallFrequent(windowed, months),
    detectFixedCost(windowed, months),
  ]

  return candidates.filter((x): x is Insight => x !== null).slice(0, 3)
}
