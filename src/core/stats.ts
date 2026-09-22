import type { Txn, TxnKind } from '../types'
import { EFFECTIVE_WINDOW_START, FUND_ACCOUNT } from '../types'
import {
  expenseContribution,
  incomeContribution,
  isFundInvestment,
  isFundReturn,
  isSalary,
} from './classify'

export interface MonthStat {
  ym: string
  /** 真实收入（只有「收入」类型贡献） */
  income: number
  /** 真实支出（「支出」为正，退款/报销为负冲减） */
  expense: number
  net: number
  /** 当月储蓄率；无收入时为 null，不显示 0 以免误导 */
  savingsRate: number | null
  /** 该月全部流水条数（含转账/债务，反映记账活跃度） */
  txnCount: number
  /** 是否落在有效记账窗口内 */
  inWindow: boolean
}

/**
 * 按月现金流。
 * 注意：2026-02 之前每个月只有 1 条（车贷补齐），不属于真实消费节奏，
 * 用 inWindow 标记出来，UI 上必须区别对待，否则会画出"常年为零突然暴涨"的假趋势。
 */
export function monthlyFlows(txns: Txn[]): MonthStat[] {
  const map = new Map<string, MonthStat>()
  for (const t of txns) {
    let m = map.get(t.ym)
    if (!m) {
      m = {
        ym: t.ym,
        income: 0,
        expense: 0,
        net: 0,
        savingsRate: null,
        txnCount: 0,
        inWindow: t.ym >= EFFECTIVE_WINDOW_START,
      }
      map.set(t.ym, m)
    }
    m.income += incomeContribution(t)
    m.expense += expenseContribution(t)
    m.txnCount += 1
  }
  const list = [...map.values()].sort((a, b) => a.ym.localeCompare(b.ym))
  for (const m of list) {
    m.net = m.income - m.expense
    m.savingsRate = m.income > 0 ? m.net / m.income : null
  }
  return list
}

export interface CategoryStat {
  category: string
  /** 二级视图时才有值 */
  subCategory?: string
  amount: number
  count: number
  /** 占总支出的比例 0~1 */
  share: number
}

export interface YMRange {
  from?: string
  to?: string
}

function inRange(ym: string, range?: YMRange): boolean {
  if (!range) return true
  if (range.from && ym < range.from) return false
  if (range.to && ym > range.to) return false
  return true
}

/** 一级分类支出占比 */
export function expenseByCategory(txns: Txn[], range?: YMRange): CategoryStat[] {
  const acc = new Map<string, { amount: number; count: number }>()
  let total = 0
  for (const t of txns) {
    if (!inRange(t.ym, range)) continue
    const c = expenseContribution(t)
    if (c === 0) continue
    const key = t.category || '未分类'
    const e = acc.get(key) ?? { amount: 0, count: 0 }
    e.amount += c
    e.count += 1
    acc.set(key, e)
    total += c
  }
  return [...acc.entries()]
    .map(([category, v]) => ({
      category,
      amount: v.amount,
      count: v.count,
      share: total > 0 ? v.amount / total : 0,
    }))
    .sort((a, b) => b.amount - a.amount)
}

/** 一级 + 二级明细支出占比。用户「其它」类占比高达 46%，必须下钻到二级才看得清 */
export function expenseBySubCategory(txns: Txn[], range?: YMRange): CategoryStat[] {
  const acc = new Map<string, { amount: number; count: number }>()
  let total = 0
  for (const t of txns) {
    if (!inRange(t.ym, range)) continue
    const c = expenseContribution(t)
    if (c === 0) continue
    const key = `${t.category || '未分类'}\u0001${t.subCategory || '（未细分）'}`
    const e = acc.get(key) ?? { amount: 0, count: 0 }
    e.amount += c
    e.count += 1
    acc.set(key, e)
    total += c
  }
  return [...acc.entries()]
    .map(([key, v]) => {
      const [category, subCategory] = key.split('\u0001')
      return {
        category,
        subCategory,
        amount: v.amount,
        count: v.count,
        share: total > 0 ? v.amount / total : 0,
      }
    })
    .sort((a, b) => b.amount - a.amount)
}

export interface MonthInvestment {
  ym: string
  /** 当月转入基金合计 */
  invested: number
  /** 当月从基金转出合计 */
  redeemed: number
  /** 净投入 = 转入 − 转出 */
  netInvested: number
  /** 当月记录在钱迹里的基金收益（收入，账户1=基金） */
  gain: number
  /** 该月是否记录过收益。false 时 UI 要提示「本月未记收益」而不是显示 0 */
  hasGainRecord: boolean
}

/**
 * 投资月度视图。
 * 口径（用户拍板「只看每月投入和收益」）：
 *   投入 = 转账且账户2 = 基金（自动从流水提取，零手工）
 *   收益 = 用户每月在钱迹里记一笔「收入」，账户1 = 基金（随账单导入）
 * 不碰持仓明细、不算收益率。
 */
export function investmentMonthly(txns: Txn[]): MonthInvestment[] {
  const map = new Map<string, MonthInvestment>()
  const ensure = (ym: string): MonthInvestment => {
    let m = map.get(ym)
    if (!m) {
      m = { ym, invested: 0, redeemed: 0, netInvested: 0, gain: 0, hasGainRecord: false }
      map.set(ym, m)
    }
    return m
  }

  for (const t of txns) {
    if (isFundInvestment(t)) {
      ensure(t.ym).invested += t.amount
    } else if (t.kind === 'transfer' && t.accountFrom.trim() === FUND_ACCOUNT) {
      ensure(t.ym).redeemed += t.amount
    } else if (isFundReturn(t)) {
      const m = ensure(t.ym)
      m.gain += t.amount
      m.hasGainRecord = true
    }
  }

  const list = [...map.values()].sort((a, b) => a.ym.localeCompare(b.ym))
  for (const m of list) m.netInvested = m.invested - m.redeemed
  return list
}

export interface KindStat {
  kind: TxnKind
  count: number
  amount: number
}

export interface Totals {
  income: number
  expense: number
  net: number
  txnCount: number
  realFlowCount: number
  salaryIncome: number
  cashInterest: number
  kindStats: KindStat[]
  dateMin: string | null
  dateMax: string | null
}

/** 全量汇总。kindStats 同时是导入校验的锚点（支出应 776、收入 548、转账 137） */
export function totals(txns: Txn[]): Totals {
  const kindMap = new Map<TxnKind, { count: number; amount: number }>()
  let income = 0
  let expense = 0
  let salaryIncome = 0
  let cashInterest = 0
  let dateMin: string | null = null
  let dateMax: string | null = null

  for (const t of txns) {
    const e = kindMap.get(t.kind) ?? { count: 0, amount: 0 }
    e.count += 1
    e.amount += t.amount
    kindMap.set(t.kind, e)

    income += incomeContribution(t)
    expense += expenseContribution(t)
    if (isSalary(t)) salaryIncome += t.amount
    if (t.kind === 'income' && !isFundReturn(t) && t.subCategory.trim() === '利息') cashInterest += t.amount

    if (dateMin === null || t.time < dateMin) dateMin = t.time
    if (dateMax === null || t.time > dateMax) dateMax = t.time
  }

  const order: TxnKind[] = [
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

  return {
    income,
    expense,
    net: income - expense,
    txnCount: txns.length,
    realFlowCount: (kindMap.get('expense')?.count ?? 0) + (kindMap.get('income')?.count ?? 0),
    salaryIncome,
    cashInterest,
    kindStats: order
      .filter((k) => kindMap.has(k))
      .map((k) => ({ kind: k, count: kindMap.get(k)!.count, amount: kindMap.get(k)!.amount })),
    dateMin,
    dateMax,
  }
}

/** 流水里出现过的全部账户名（账户1 + 账户2），用于资产快照的默认清单 */
export function accountList(txns: Txn[]): string[] {
  const set = new Set<string>()
  for (const t of txns) {
    if (t.accountFrom.trim()) set.add(t.accountFrom.trim())
    if (t.accountTo.trim()) set.add(t.accountTo.trim())
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}
