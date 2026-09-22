/**
 * 钱迹导出账单的数据模型。
 *
 * 事实依据：对用户真实导出文件《QianJi_日常账本》全表扫描 1502 行核实。
 * 关键事实（不要凭直觉改动）：
 *  - 导出 19 列，表头在第 1 行，数据第 2~1503 行
 *  - 「时间」是纯字符串 'YYYY-MM-DD HH:mm:ss'，月日已补零，可直接字典序排序
 *  - 「金额」恒为正数，收支方向由「类型」决定，绝不靠正负号
 *  - 「ID」1502 条全唯一 → 直接作去重主键
 *  - 「账单标记」「手续费」「优惠券」「标签」「账单图片」5 列全空，解析时忽略
 */

/** 钱迹「类型」列的全部 10 种取值 */
export const RAW_TYPES = [
  '支出',
  '收入',
  '转账',
  '债务-还款',
  '债务-借入',
  '债务-借出',
  '债务-收款',
  '退款',
  '报销',
  '报销记录',
] as const

export type RawType = (typeof RAW_TYPES)[number]

/**
 * 归一化类型。统计口径完全由它决定，不由原始「类型」字符串决定。
 *   expense / income   → 计入真实收支（1324 条）
 *   transfer           → 账户间搬运，不进收支，用于识别投资投入
 *   debt_*             → 债权债务变动，不进收支，单列
 *   refund/reimburse   → 支出冲减（负向），绝不能当收入
 */
export type TxnKind =
  | 'expense'
  | 'income'
  | 'transfer'
  | 'debt_repay'
  | 'debt_borrow'
  | 'debt_lend'
  | 'debt_collect'
  | 'refund'
  | 'reimburse'
  /** 钱迹若新增类型，不静默丢数据，归到此档并在导入报告里点名 */
  | 'unknown'

export interface Txn {
  /** 钱迹账单 ID，主键，天然唯一 */
  id: string
  /** 原样保留 'YYYY-MM-DD HH:mm:ss' */
  time: string
  /** 'YYYY-MM-DD' */
  date: string
  /** 'YYYY-MM' */
  ym: string
  ledger: string
  category: string
  subCategory: string
  rawType: string
  kind: TxnKind
  /** 恒为正数 */
  amount: number
  currency: string
  /** 「账户1」：支出=付款账户；收入=收款账户；转账=转出账户 */
  accountFrom: string
  /** 「账户2」：仅转账/债务类使用，见表义见 accountFrom */
  accountTo: string
  note: string
  reimbursed: string
  relatedId: string
  /** 入库时间戳，用于备份和调试 */
  importedAt: number
}

export type AccountGroup = '资金' | '充值' | '投资' | '负债' | '其他权益'

/**
 * 账户余额快照。
 *
 * 重要：资产总览**只认这个表**，绝不从流水倒推余额——
 * 钱迹导出没有期初余额，且基金账户不跟随净值波动，倒推必然算错。
 */
export interface AccountSnapshot {
  id?: number
  /** 快照日期 'YYYY-MM-DD' */
  date: string
  name: string
  /** 计入总资产时用正数；负债账户填负数 */
  balance: number
  group: AccountGroup
  /** 钱迹里标注"不计入"的账户（公积金/医保/饭卡/联通积点）为 false */
  includeInNet: boolean
}

/** 每次导入留痕，既用于排查也用于向用户交代数据从哪来 */
export interface ImportRecord {
  id?: number
  fileName: string
  importedAt: number
  /** 文件中的数据行数（不含表头） */
  totalRows: number
  inserted: number
  duplicated: number
  /** 缺关键字段等无法入库的行 */
  skipped: number
  anomalies: string[]
}

/** 投资收益的资金来源：用户每月在钱迹里记一笔「收入」，账户1 记「基金」 */
export const FUND_ACCOUNT = '基金'

/** 有效记账窗口起点。2026-02 之前每月仅 1 条（车贷补齐），做趋势会出假信号 */
export const EFFECTIVE_WINDOW_START = '2026-02'
