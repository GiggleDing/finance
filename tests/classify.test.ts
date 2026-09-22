import { describe, expect, it } from 'vitest'
import {
  expenseContribution,
  groupOfAccount,
  incomeContribution,
  isCashInterest,
  isFundInvestment,
  isFundReturn,
  isNonCountedAccount,
  isRealFlow,
  normalizeKind,
} from '../src/core/classify'
import { mkTxn } from './helpers'

describe('normalizeKind：钱迹全部 10 种类型', () => {
  const cases: Array<[string, string]> = [
    ['支出', 'expense'],
    ['收入', 'income'],
    ['转账', 'transfer'],
    ['债务-还款', 'debt_repay'],
    ['债务-借入', 'debt_borrow'],
    ['债务-借出', 'debt_lend'],
    ['债务-收款', 'debt_collect'],
    ['退款', 'refund'],
    ['报销', 'reimburse'],
    ['报销记录', 'reimburse'],
  ]

  it.each(cases)('%s → %s', (raw, expected) => {
    expect(normalizeKind(raw)).toBe(expected)
  })

  it('未知类型归到 unknown，不静默丢弃', () => {
    expect(normalizeKind('钱迹新类型')).toBe('unknown')
  })

  it('容忍两侧空格', () => {
    expect(normalizeKind('  支出  ')).toBe('expense')
  })
})

describe('收支口径', () => {
  it('只有支出和收入算真实收支', () => {
    expect(isRealFlow('expense')).toBe(true)
    expect(isRealFlow('income')).toBe(true)
    expect(isRealFlow('transfer')).toBe(false)
    expect(isRealFlow('debt_repay')).toBe(false)
  })

  it('退款和报销是支出冲减，不是收入', () => {
    const refund = mkTxn({ time: '2026-03-05 10:00:00', rawType: '退款', amount: 30 })
    const reimb = mkTxn({ time: '2026-03-06 10:00:00', rawType: '报销', amount: 120 })
    expect(expenseContribution(refund)).toBe(-30)
    expect(expenseContribution(reimb)).toBe(-120)
    expect(incomeContribution(refund)).toBe(0)
    expect(incomeContribution(reimb)).toBe(0)
  })

  it('转账对收支零影响', () => {
    const t = mkTxn({ time: '2026-03-07 10:00:00', rawType: '转账', amount: 500, accountFrom: '余额宝', accountTo: '基金' })
    expect(expenseContribution(t)).toBe(0)
    expect(incomeContribution(t)).toBe(0)
  })
})

describe('投资识别', () => {
  it('转账进基金 = 投资投入', () => {
    const t = mkTxn({ time: '2026-03-07 10:00:00', rawType: '转账', amount: 500, accountFrom: '余额宝', accountTo: '基金' })
    expect(isFundInvestment(t)).toBe(true)
    expect(isFundReturn(t)).toBe(false)
  })

  it('从基金转出不算投入', () => {
    const t = mkTxn({ time: '2026-03-08 10:00:00', rawType: '转账', amount: 500, accountFrom: '基金', accountTo: '余额宝' })
    expect(isFundInvestment(t)).toBe(false)
  })

  it('收入且账户为基金 = 投资收益', () => {
    const t = mkTxn({ time: '2026-03-09 10:00:00', rawType: '收入', amount: 386.2, accountFrom: '基金', category: '其它' })
    expect(isFundReturn(t)).toBe(true)
    expect(isCashInterest(t)).toBe(false)
  })

  it('余额宝利息是货币基金收益，不算投资组合收益', () => {
    const t = mkTxn({
      time: '2026-03-10 10:00:00',
      rawType: '收入',
      amount: 0.11,
      accountFrom: '微信零钱通',
      category: '其它',
      subCategory: '利息',
    })
    expect(isCashInterest(t)).toBe(true)
    expect(isFundReturn(t)).toBe(false)
  })
})

describe('账户分组', () => {
  it('基金单独归到投资组', () => {
    expect(groupOfAccount('基金')).toBe('投资')
  })

  it('公积金/医保/饭卡/积点不计入净资产', () => {
    expect(isNonCountedAccount('公积金')).toBe(true)
    expect(isNonCountedAccount('医保个人余额')).toBe(true)
    expect(isNonCountedAccount('饭卡')).toBe(true)
    expect(isNonCountedAccount('联通积点')).toBe(true)
  })

  it('没登记过的账户名按其他权益兜底，不默认计入净资产', () => {
    expect(groupOfAccount('某个新账户')).toBe('其他权益')
    expect(isNonCountedAccount('某个新账户')).toBe(true)
  })

  it('车贷是负债组', () => {
    expect(groupOfAccount('比亚迪-车贷')).toBe('负债')
  })
})
