import type { TxnKind } from '../types'

/** 千分位整数 */
function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 金额，默认带 ¥ 与两位小数 */
export function fmtMoney(n: number, digits = 2): string {
  const neg = n < 0
  const s = Math.abs(n).toFixed(digits)
  const [int, dec] = s.split('.')
  return `${neg ? '-' : ''}¥${group(int)}${dec ? `.${dec}` : ''}`
}

/** 纯数字（不带货币符号），用于表格列 */
export function fmtNum(n: number, digits = 2): string {
  const neg = n < 0
  const s = Math.abs(n).toFixed(digits)
  const [int, dec] = s.split('.')
  return `${neg ? '-' : ''}${group(int)}${dec ? `.${dec}` : ''}`
}

/** '2026-02' → '2026年2月' */
export function fmtYm(ym: string): string {
  const [y, m] = ym.split('-')
  return `${y}年${Number(m)}月`
}

/** '2026-02' → '26/02'，图表轴用 */
export function fmtYmShort(ym: string): string {
  const [y, m] = ym.split('-')
  return `${y.slice(2)}/${m}`
}

/** '2026-09-21' → '09-21' */
export function fmtDateShort(date: string): string {
  return date.slice(5)
}

export function pct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`
}

const KIND_LABEL: Record<TxnKind, string> = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  debt_repay: '还贷',
  debt_borrow: '借入',
  debt_lend: '借出',
  debt_collect: '收款',
  refund: '退款',
  reimburse: '报销',
  unknown: '未识别',
}

export function kindLabel(k: TxnKind): string {
  return KIND_LABEL[k] ?? k
}

/** 金额展示方向：支出为负色、收入为正色、其余中性 */
export function amountToneClass(kind: TxnKind, amount: number): string {
  if (kind === 'expense') return 'text-expense'
  if (kind === 'income') return 'text-income'
  if (kind === 'refund' || kind === 'reimburse') return 'text-income'
  if (amount < 0) return 'text-income'
  return 'text-ink-500'
}

/** 展示用带符号金额：支出前置负号 */
export function signedAmount(kind: TxnKind, amount: number): string {
  if (kind === 'expense') return `-${fmtNum(amount)}`
  if (kind === 'income') return `+${fmtNum(amount)}`
  if (kind === 'refund' || kind === 'reimburse') return `+${fmtNum(amount)}`
  return fmtNum(amount)
}
