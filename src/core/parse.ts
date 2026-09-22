import type { Txn } from '../types'
import { normalizeKind } from './classify'

/**
 * 钱迹导出 xlsx 解析器。
 *
 * 设计原则：
 *  1. **按列名映射，不按列位置** —— 钱迹升级后列序可能变，位置映射会静默错位。
 *  2. **绝不静默丢数据** —— 任何跳过或异常都进 issues，最终展示给用户。
 *  3. **宽容解析时间与金额** —— 官方导出是 'YYYY-MM-DD HH:mm:ss' 与纯数字，
 *     但用户可能从 iOS 导出 CSV（'2022/7/12 21:20'），两种都要吃。
 */

type Cell = string | number | boolean | null | undefined
type Row = Cell[]

type Field =
  | 'id'
  | 'time'
  | 'ledger'
  | 'category'
  | 'subCategory'
  | 'rawType'
  | 'amount'
  | 'currency'
  | 'accountFrom'
  | 'accountTo'
  | 'note'
  | 'reimbursed'
  | 'relatedId'

/** 表头名 → 内部字段。未列出的列（手续费/优惠券/记账者/账单标记/标签/账单图片）直接忽略 */
const FIELD_BY_HEADER: Record<string, Field> = {
  ID: 'id',
  时间: 'time',
  账本: 'ledger',
  分类: 'category',
  二级分类: 'subCategory',
  类型: 'rawType',
  金额: 'amount',
  币种: 'currency',
  账户1: 'accountFrom',
  账户2: 'accountTo',
  备注: 'note',
  已报销: 'reimbursed',
  关联账单: 'relatedId',
}

/** 缺任何一列都无法构建可信数据 */
const REQUIRED_FIELDS: Field[] = ['time', 'rawType', 'amount']

export interface ParseIssue {
  /** Excel 里的真实行号（1-based，含表头），方便用户回文件核对 */
  row: number
  id?: string
  reason: string
}

export interface ParseResult {
  txns: Txn[]
  sheetName: string
  headers: string[]
  /** 数据区总行数（已跳过完全空行） */
  totalRows: number
  skipped: number
  issues: ParseIssue[]
  /** 钱迹新增的未识别类型，点名让用户知道 */
  unknownTypes: string[]
  missingColumns: Field[]
  /**
   * 没有 ID 列、只能靠指纹合成主键的行数。
   * 为什么不静默处理：指纹键的去重效果天然弱于钱迹自带的 ID，
   * 用户有权知道自己的去重保护是在降级状态下工作的。
   */
  fingerprinted: number
}

const TIME_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/

const pad2 = (s: string) => s.padStart(2, '0')

/** 把各种时间写法归一成 'YYYY-MM-DD HH:mm:ss' + 派生字段 */
function parseTime(raw: string): { time: string; date: string; ym: string } | null {
  const m = TIME_RE.exec(raw.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const date = `${y}-${pad2(mo)}-${pad2(d)}`
  const time = `${date} ${pad2(h ?? '0')}:${pad2(mi ?? '0')}:${pad2(s ?? '0')}`
  return { time, date, ym: `${y}-${pad2(mo)}` }
}

/** 金额恒为正；容忍千分位、货币符号、空格 */
function parseAmount(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.abs(v) : null
  if (typeof v === 'string') {
    const cleaned = v.replace(/[,，¥$￥\s]/g, '')
    if (cleaned === '') return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? Math.abs(n) : null
  }
  return null
}

function asText(v: Cell): string {
  if (v === null || v === undefined) return ''
  return String(v).trim()
}

/**
 * ID 缺失时的降级指纹。
 *
 * 这里最初只用 (时间, 类型, 金额, 账户1) 四段做键 —— 那是不够的：同一个账户在
 * 同一秒完全可能有两笔金额相同的支出（两杯一样价钱的咖啡），四段键会算出同一个
 * 指纹，第二条在按 ID 去重时被当成重复**静默丢掉**。丢的还是账。
 *
 * 现在把整行的业务身份都放进来（含账户2、分类、二级分类、备注），覆盖面已经足够；
 * 万一仍然撞上（两行内容逐字相同），调用方会再追加「该指纹在本文件内的出现序号」，
 * 保证同一份文件里绝不出现两个相同的 ID。
 *
 * 为什么用出现序号而不是 Excel 行号：序号只依赖「这一行在本文件里是第几次出现」，
 * 而钱迹重复导出同一批账单时顺序是稳定的，所以重复导入同一份文件仍然得到同一批 ID，
 * 去重照旧生效。用行号的话，用户在中间插一行就会让后面所有 ID 漂移，
 * 再导入时整批被当成新账单，重复一遍。
 */
function fallbackId(parts: (string | number)[]): string {
  const src = parts.join('|')
  let h = 5381
  for (let i = 0; i < src.length; i++) {
    h = ((h << 5) + h + src.charCodeAt(i)) | 0
  }
  return `fb${(h >>> 0).toString(36)}`
}

/**
 * 取主键。有钱迹的 ID 就用 ID（1502 行实测 100% 唯一），没有才合成指纹，
 * 并对逐字相同的行追加出现序号 —— 保证同一份文件里不会有两行拿到同一个键。
 * 这是「重复导入不重复、不同账单不被吞掉」两条要求的落点。
 */
function resolveId(
  pick: (f: Field) => Cell,
  time: string,
  rawType: string,
  amount: number,
  seen: Map<string, number>,
): string {
  const realId = asText(pick('id'))
  if (realId) return realId

  const identity: (string | number)[] = [
    time,
    rawType,
    amount,
    asText(pick('accountFrom')),
    asText(pick('accountTo')),
    asText(pick('category')),
    asText(pick('subCategory')),
    asText(pick('ledger')),
    asText(pick('note')),
  ]
  const base = identity.join('|')
  const occurrence = seen.get(base) ?? 0
  seen.set(base, occurrence + 1)
  // 首次出现保持裸指纹（最常见的路径），之后才追加序号
  return occurrence === 0 ? fallbackId(identity) : fallbackId([...identity, `#${occurrence}`])
}

function buildColumnIndex(headerRow: Row): Partial<Record<Field, number>> {
  const idx: Partial<Record<Field, number>> = {}
  headerRow.forEach((cell, i) => {
    const name = asText(cell)
    if (!name) return
    const field = FIELD_BY_HEADER[name]
    if (field && idx[field] === undefined) idx[field] = i
  })
  return idx
}

export async function parseWorkbook(data: ArrayBuffer, importedAt = Date.now()): Promise<ParseResult> {
  // 按需加载：SheetJS 体积大，只有真正导入账单时才拉进来，避免拖慢首屏
  const XLSX = await import('xlsx')
  const wb = XLSX.read(data, { type: 'array' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('工作簿里没有任何工作表')

  const ws = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<Row>(ws, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: false,
  })

  if (rows.length === 0) throw new Error(`工作表「${sheetName}」是空的`)

  // 表头不一定在第 1 行（可能带标题行），前 10 行里找「同时含时间与金额」的那行
  let headerRowIdx = -1
  let colIndex: Partial<Record<Field, number>> = {}
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cand = buildColumnIndex(rows[i] ?? [])
    if (cand.time !== undefined && cand.amount !== undefined) {
      headerRowIdx = i
      colIndex = cand
      break
    }
  }
  if (headerRowIdx === -1) {
    throw new Error('找不到表头行：需要同时包含「时间」和「金额」两列，请确认导出的是钱迹账单文件')
  }

  const missingColumns = REQUIRED_FIELDS.filter((f) => colIndex[f] === undefined)
  const headers = (rows[headerRowIdx] ?? []).map(asText).filter(Boolean)

  const txns: Txn[] = []
  const issues: ParseIssue[] = []
  const unknownTypeSet = new Set<string>()
  let dataRows = 0
  let fingerprinted = 0
  /** 指纹 → 在本文件内已出现的次数，用来给逐字相同的行做区分 */
  const fingerprintSeen = new Map<string, number>()

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r] ?? []
    const excelRowNo = r + 1
    const pick = (f: Field): Cell => {
      const i = colIndex[f]
      return i === undefined ? '' : row[i]
    }

    const rawTime = asText(pick('time'))
    const rawType = asText(pick('rawType'))
    const rawAmount = pick('amount')

    // 只跳过「三要素全空」的行，不因为单个字段空就丢整行
    if (!rawTime && !rawType && asText(rawAmount) === '') continue
    dataRows++

    const parsedTime = parseTime(rawTime)
    if (!parsedTime) {
      issues.push({ row: excelRowNo, id: asText(pick('id')), reason: `时间格式无法识别：「${rawTime}」` })
      continue
    }

    const amount = parseAmount(rawAmount)
    if (amount === null) {
      issues.push({
        row: excelRowNo,
        id: asText(pick('id')),
        reason: `金额不是数字：「${asText(rawAmount)}」`,
      })
      continue
    }

    if (!rawType) {
      issues.push({ row: excelRowNo, id: asText(pick('id')), reason: '类型为空，无法判定收支方向' })
      continue
    }

    const kind = normalizeKind(rawType)
    if (kind === 'unknown') unknownTypeSet.add(rawType)

    const id = resolveId(pick, parsedTime.time, rawType, amount, fingerprintSeen)
    if (!asText(pick('id'))) fingerprinted += 1

    txns.push({
      id,
      time: parsedTime.time,
      date: parsedTime.date,
      ym: parsedTime.ym,
      ledger: asText(pick('ledger')),
      category: asText(pick('category')),
      subCategory: asText(pick('subCategory')),
      rawType,
      kind,
      amount,
      currency: asText(pick('currency')) || 'CNY',
      accountFrom: asText(pick('accountFrom')),
      accountTo: asText(pick('accountTo')),
      note: asText(pick('note')),
      reimbursed: asText(pick('reimbursed')),
      relatedId: asText(pick('relatedId')),
      importedAt,
    })
  }

  return {
    txns,
    sheetName,
    headers,
    totalRows: dataRows,
    skipped: issues.length,
    issues,
    unknownTypes: [...unknownTypeSet],
    missingColumns,
    fingerprinted,
  }
}
