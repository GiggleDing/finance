import type { AccountGroup, Txn, TxnKind } from '../types'
import { FUND_ACCOUNT } from '../types'

/**
 * 钱迹「类型」→ 归一化类型。
 * 这是**全系统统计口径的唯一真相来源**，任何聚合都必须经它判定。
 */
export function normalizeKind(rawType: string): TxnKind {
  switch (rawType.trim()) {
    case '支出':
      return 'expense'
    case '收入':
      return 'income'
    case '转账':
      return 'transfer'
    case '债务-还款':
      return 'debt_repay'
    case '债务-借入':
      return 'debt_borrow'
    case '债务-借出':
      return 'debt_lend'
    case '债务-收款':
      return 'debt_collect'
    case '退款':
      return 'refund'
    case '报销':
    case '报销记录':
      return 'reimburse'
    default:
      return 'unknown'
  }
}

/** 是否属于「真实收支」——只有这两类进收入/支出统计（用户数据里共 1324 条） */
export function isRealFlow(kind: TxnKind): boolean {
  return kind === 'expense' || kind === 'income'
}

/**
 * 该笔对「真实支出」的贡献额。
 * 支出 → +amount；退款 / 报销 → −amount（作支出冲减，**绝不能当收入**）。
 */
export function expenseContribution(t: Txn): number {
  switch (t.kind) {
    case 'expense':
      return t.amount
    case 'refund':
    case 'reimburse':
      return -t.amount
    default:
      return 0
  }
}

/** 该笔对「真实收入」的贡献额。只有 income 贡献正收入。 */
export function incomeContribution(t: Txn): number {
  return t.kind === 'income' ? t.amount : 0
}

/** 投资投入：转账，且资金流入「基金」账户（用户数据里 111 条） */
export function isFundInvestment(t: Txn): boolean {
  return t.kind === 'transfer' && t.accountTo.trim() === FUND_ACCOUNT
}

/** 投资收益：用户每月在钱迹记的一笔「收入」，账户1 = 基金 */
export function isFundReturn(t: Txn): boolean {
  return t.kind === 'income' && t.accountFrom.trim() === FUND_ACCOUNT
}

/**
 * 货币基金利息（余额宝/零钱通的几分几毛，用户数据里 484 条）。
 * 必须与基金投资收益分开，否则收入统计会被噪声主导。
 */
export function isCashInterest(t: Txn): boolean {
  return t.kind === 'income' && !isFundReturn(t) && t.subCategory.trim() === '利息'
}

/** 工资类收入，用于储蓄率分母（用户确认工资基本每月都记） */
export function isSalary(t: Txn): boolean {
  return t.kind === 'income' && (t.category.trim() === '工资' || t.subCategory.includes('工资'))
}

/**
 * 账户分组。名称取自钱迹资产页的真实账户。
 * 未登记的账户名按「其他权益」兜底，不默认计入净资产——宁可少算也不能多算。
 */
const ACCOUNT_GROUP: Record<string, AccountGroup> = {
  现金: '资金',
  微众银行: '资金',
  微信零钱通: '资金',
  余额宝: '资金',
  中国石油加油卡: '充值',
  [FUND_ACCOUNT]: '投资',
  '比亚迪-车贷': '负债',
  公积金: '其他权益',
  医保个人余额: '其他权益',
  饭卡: '其他权益',
  联通积点: '其他权益',
  京东锦礼积点: '其他权益',
  人工智能培训费: '其他权益',
}

export function groupOfAccount(name: string): AccountGroup {
  return ACCOUNT_GROUP[name.trim()] ?? '其他权益'
}

/** 钱迹资产页明确标注「不计入」总资产的账户 */
export function isNonCountedAccount(name: string): boolean {
  return groupOfAccount(name) === '其他权益'
}
