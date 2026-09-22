import { describe, expect, it } from 'vitest'
import { expenseByCategory, investmentMonthly, monthlyFlows, totals } from '../src/core/stats'
import { mkTxn } from './helpers'

describe('monthlyFlows', () => {
  it('按月聚合收入与支出，转账不计入', () => {
    const txns = [
      mkTxn({ time: '2026-03-01 09:00:00', rawType: '支出', amount: 100, category: '餐饮' }),
      mkTxn({ time: '2026-03-02 09:00:00', rawType: '支出', amount: 50, category: '餐饮' }),
      mkTxn({ time: '2026-03-05 09:00:00', rawType: '收入', amount: 8000, category: '工资' }),
      mkTxn({ time: '2026-03-06 09:00:00', rawType: '转账', amount: 5000, accountFrom: '微众银行', accountTo: '基金' }),
    ]
    const [m] = monthlyFlows(txns)
    expect(m.ym).toBe('2026-03')
    expect(m.income).toBe(8000)
    expect(m.expense).toBe(150)
    expect(m.net).toBe(7850)
    expect(m.txnCount).toBe(4)
  })

  it('退款与报销作为支出冲减', () => {
    const txns = [
      mkTxn({ time: '2026-03-01 09:00:00', rawType: '支出', amount: 300, category: '学习' }),
      mkTxn({ time: '2026-03-08 09:00:00', rawType: '退款', amount: 80 }),
      mkTxn({ time: '2026-03-09 09:00:00', rawType: '报销', amount: 20 }),
    ]
    const [m] = monthlyFlows(txns)
    expect(m.expense).toBe(200)
    expect(m.income).toBe(0)
  })

  it('无收入时储蓄率为 null，不显示 0', () => {
    const txns = [mkTxn({ time: '2026-03-01 09:00:00', rawType: '支出', amount: 30, category: '餐饮' })]
    const [m] = monthlyFlows(txns)
    expect(m.savingsRate).toBeNull()
  })

  it('2026-02 之前的月份标记为不在有效窗口内', () => {
    const txns = [
      mkTxn({ time: '2025-06-15 09:00:00', rawType: '债务-还款', amount: 1944.44 }),
      mkTxn({ time: '2026-02-15 09:00:00', rawType: '支出', amount: 30, category: '餐饮' }),
    ]
    const ms = monthlyFlows(txns)
    expect(ms[0].inWindow).toBe(false)
    expect(ms[1].inWindow).toBe(true)
  })

  it('月份按时间升序返回', () => {
    const txns = [
      mkTxn({ time: '2026-05-01 09:00:00', rawType: '支出', amount: 1 }),
      mkTxn({ time: '2026-02-01 09:00:00', rawType: '支出', amount: 1 }),
      mkTxn({ time: '2026-03-01 09:00:00', rawType: '支出', amount: 1 }),
    ]
    expect(monthlyFlows(txns).map((m) => m.ym)).toEqual(['2026-02', '2026-03', '2026-05'])
  })
})

describe('expenseByCategory', () => {
  it('只统计支出，并按金额降序，占比合计为 1', () => {
    const txns = [
      mkTxn({ time: '2026-03-01 09:00:00', rawType: '支出', amount: 300, category: '餐饮' }),
      mkTxn({ time: '2026-03-02 09:00:00', rawType: '支出', amount: 100, category: '日常' }),
      mkTxn({ time: '2026-03-03 09:00:00', rawType: '收入', amount: 9999, category: '工资' }),
      mkTxn({ time: '2026-03-04 09:00:00', rawType: '转账', amount: 500, accountTo: '基金' }),
    ]
    const cats = expenseByCategory(txns)
    expect(cats.map((c) => c.category)).toEqual(['餐饮', '日常'])
    expect(cats[0].amount).toBe(300)
    expect(cats.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1, 10)
  })

  it('可以按月份区间过滤', () => {
    const txns = [
      mkTxn({ time: '2026-02-10 09:00:00', rawType: '支出', amount: 100, category: '餐饮' }),
      mkTxn({ time: '2026-04-10 09:00:00', rawType: '支出', amount: 999, category: '餐饮' }),
    ]
    const cats = expenseByCategory(txns, { from: '2026-04', to: '2026-04' })
    expect(cats).toHaveLength(1)
    expect(cats[0].amount).toBe(999)
  })
})

describe('investmentMonthly', () => {
  it('投入取「账户2 = 基金」的转账，收益取「账户1 = 基金」的收入', () => {
    const txns = [
      mkTxn({ time: '2026-03-06 09:00:00', rawType: '转账', amount: 2000, accountFrom: '微众银行', accountTo: '基金' }),
      mkTxn({ time: '2026-03-20 09:00:00', rawType: '转账', amount: 1000, accountFrom: '余额宝', accountTo: '基金' }),
      mkTxn({ time: '2026-03-31 09:00:00', rawType: '收入', amount: 386.2, accountFrom: '基金', category: '其它' }),
    ]
    const [m] = investmentMonthly(txns)
    expect(m.ym).toBe('2026-03')
    expect(m.invested).toBe(3000)
    expect(m.netInvested).toBe(3000)
    expect(m.gain).toBeCloseTo(386.2, 6)
    expect(m.hasGainRecord).toBe(true)
  })

  it('从基金转出算赎回，净投入要扣掉', () => {
    const txns = [
      mkTxn({ time: '2026-03-06 09:00:00', rawType: '转账', amount: 3000, accountFrom: '微众银行', accountTo: '基金' }),
      mkTxn({ time: '2026-03-25 09:00:00', rawType: '转账', amount: 1200, accountFrom: '基金', accountTo: '微众银行' }),
    ]
    const [m] = investmentMonthly(txns)
    expect(m.invested).toBe(3000)
    expect(m.redeemed).toBe(1200)
    expect(m.netInvested).toBe(1800)
  })

  it('当月没记收益时 hasGainRecord 为 false，而不是收益 0', () => {
    const txns = [
      mkTxn({ time: '2026-04-06 09:00:00', rawType: '转账', amount: 2000, accountFrom: '微众银行', accountTo: '基金' }),
    ]
    const [m] = investmentMonthly(txns)
    expect(m.hasGainRecord).toBe(false)
    expect(m.gain).toBe(0)
  })

  it('余额宝利息不会被算成基金收益', () => {
    const txns = [
      mkTxn({
        time: '2026-03-31 09:00:00',
        rawType: '收入',
        amount: 0.11,
        accountFrom: '微信零钱通',
        category: '其它',
        subCategory: '利息',
      }),
    ]
    expect(investmentMonthly(txns)).toHaveLength(0)
  })
})

describe('totals', () => {
  it('真实收支笔数不含转账与债务', () => {
    const txns = [
      mkTxn({ time: '2026-03-01 09:00:00', rawType: '支出', amount: 10 }),
      mkTxn({ time: '2026-03-02 09:00:00', rawType: '收入', amount: 20 }),
      mkTxn({ time: '2026-03-03 09:00:00', rawType: '转账', amount: 30, accountTo: '基金' }),
      mkTxn({ time: '2026-03-04 09:00:00', rawType: '债务-还款', amount: 40 }),
    ]
    const t = totals(txns)
    expect(t.txnCount).toBe(4)
    expect(t.realFlowCount).toBe(2)
    expect(t.income).toBe(20)
    expect(t.expense).toBe(10)
    expect(t.net).toBe(10)
  })

  it('记录最早与最晚时间', () => {
    const txns = [
      mkTxn({ time: '2026-03-01 09:00:00', rawType: '支出', amount: 10 }),
      mkTxn({ time: '2026-06-20 21:00:00', rawType: '支出', amount: 10 }),
    ]
    const t = totals(txns)
    expect(t.dateMin).toBe('2026-03-01 09:00:00')
    expect(t.dateMax).toBe('2026-06-20 21:00:00')
  })
})
