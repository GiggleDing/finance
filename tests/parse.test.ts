import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'
import { parseWorkbook } from '../src/core/parse'

const HEADERS = [
  'ID',
  '时间',
  '账本',
  '分类',
  '二级分类',
  '类型',
  '金额',
  '币种',
  '账户1',
  '账户2',
  '备注',
  '已报销',
  '手续费',
  '优惠券',
  '记账者',
  '账单标记',
  '标签',
  '账单图片',
  '关联账单',
]

/** 按钱迹真实表头顺序生成一行，缺省字段留空 */
function row(over: Record<string, string | number>): (string | number)[] {
  return HEADERS.map((h) => over[h] ?? '')
}

function toBuffer(aoa: (string | number)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '账单')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

function build(rows: (string | number)[][]): ArrayBuffer {
  return toBuffer([HEADERS, ...rows])
}

describe('parseWorkbook 正常路径', () => {
  it('解析支出与转账，并派生 date / ym', async () => {
    const buf = build([
      row({ ID: 'qj1', 时间: '2026-09-20 16:56:44', 分类: '餐饮', 二级分类: '食堂三餐', 类型: '支出', 金额: 7, 账户1: '饭卡' }),
      row({ ID: 'qj2', 时间: '2026-09-18 16:52:21', 类型: '转账', 金额: 42, 账户1: '余额宝', 账户2: '基金' }),
    ])
    const r = await parseWorkbook(buf)

    expect(r.txns).toHaveLength(2)
    expect(r.totalRows).toBe(2)
    expect(r.skipped).toBe(0)
    expect(r.sheetName).toBe('账单')

    const [e, t] = r.txns
    expect(e.kind).toBe('expense')
    expect(e.date).toBe('2026-09-20')
    expect(e.ym).toBe('2026-09')
    expect(e.amount).toBe(7)
    expect(e.subCategory).toBe('食堂三餐')

    expect(t.kind).toBe('transfer')
    expect(t.accountTo).toBe('基金')
  })

  it('金额始终为正数，方向由类型决定', async () => {
    const buf = build([row({ ID: 'qj1', 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 28.58 })])
    const r = await parseWorkbook(buf)
    expect(r.txns[0].amount).toBe(28.58)
    expect(r.txns[0].amount).toBeGreaterThan(0)
  })

  it('忽略全空的数据列（账单标记/手续费等）', async () => {
    const buf = build([row({ ID: 'qj1', 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 1 })])
    const r = await parseWorkbook(buf)
    expect(r.txns[0].note).toBe('')
    expect(r.txns[0].reimbursed).toBe('')
  })
})

describe('parseWorkbook 健壮性', () => {
  it('列序被改动也能正确解析（按列名映射，不按位置）', async () => {
    const shuffled = [
      '类型',
      '金额',
      '时间',
      'ID',
      '账户2',
      '分类',
      '账户1',
      '二级分类',
      '账本',
      '备注',
      '币种',
      '已报销',
      '手续费',
      '优惠券',
      '记账者',
      '账单标记',
      '标签',
      '账单图片',
      '关联账单',
    ]
    const buf = toBuffer([
      shuffled,
      ['支出', 7, '2026-09-20 16:56:44', 'qj1', '', '餐饮', '饭卡', '食堂三餐', '日常账本', '', 'CNY', '', '', '', '', '', '', '', ''],
    ])
    const r = await parseWorkbook(buf)
    expect(r.txns).toHaveLength(1)
    expect(r.txns[0].category).toBe('餐饮')
    expect(r.txns[0].accountFrom).toBe('饭卡')
    expect(r.txns[0].amount).toBe(7)
  })

  it('表头不在第一行（前面有标题行）也能定位', async () => {
    const buf = toBuffer([
      ['钱迹账单导出'],
      [],
      HEADERS,
      row({ ID: 'qj1', 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5 }),
    ])
    const r = await parseWorkbook(buf)
    expect(r.txns).toHaveLength(1)
    expect(r.txns[0].amount).toBe(5)
  })

  it('兼容 iOS 导出的 2026/9/1 9:05 时间写法', async () => {
    const buf = build([row({ ID: 'qj1', 时间: '2026/9/1 9:05', 类型: '支出', 金额: 5 })])
    const r = await parseWorkbook(buf)
    expect(r.txns[0].time).toBe('2026-09-01 09:05:00')
    expect(r.txns[0].ym).toBe('2026-09')
  })

  it('兼容带千分位与货币符号的金额字符串', async () => {
    const buf = build([row({ ID: 'qj1', 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: '1,234.50' })])
    const r = await parseWorkbook(buf)
    expect(r.txns[0].amount).toBe(1234.5)
  })

  it('未知类型保留记录并归到 unknown，同时点名上报', async () => {
    const buf = build([row({ ID: 'qj1', 时间: '2026-09-20 10:00:00', 类型: '钱迹新类型', 金额: 5 })])
    const r = await parseWorkbook(buf)
    expect(r.txns).toHaveLength(1)
    expect(r.txns[0].kind).toBe('unknown')
    expect(r.unknownTypes).toContain('钱迹新类型')
  })

  it('时间无法识别时跳过该行并记入 issues，不静默丢弃', async () => {
    const buf = build([
      row({ ID: 'qj1', 时间: '不是时间', 类型: '支出', 金额: 5 }),
      row({ ID: 'qj2', 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 6 }),
    ])
    const r = await parseWorkbook(buf)
    expect(r.txns).toHaveLength(1)
    expect(r.skipped).toBe(1)
    expect(r.issues[0].row).toBe(2)
  })

  it('缺少必要列（时间+金额）时直接报错，而不是产出一堆空数据', async () => {
    const buf = toBuffer([
      ['ID', '时间', '类型'],
      ['qj1', '2026-09-20 10:00:00', '支出'],
    ])
    await expect(parseWorkbook(buf)).rejects.toThrow(/表头/)
  })

  it('ID 缺失时用内容指纹兜底，保证同一笔账单得到同一个键', async () => {
    const rows = [row({ 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5, 账户1: '饭卡' })]
    const r1 = await parseWorkbook(build(rows))
    const r2 = await parseWorkbook(build(rows))
    expect(r1.txns[0].id).toBe(r2.txns[0].id)
    expect(r1.txns[0].id.startsWith('fb')).toBe(true)
  })

  it('全空行不计入数据行数', async () => {
    const buf = build([
      row({ ID: 'qj1', 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5 }),
      ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      row({ ID: 'qj2', 时间: '2026-09-21 10:00:00', 类型: '支出', 金额: 6 }),
    ])
    const r = await parseWorkbook(buf)
    expect(r.totalRows).toBe(2)
    expect(r.txns).toHaveLength(2)
  })
})

/**
 * 指纹降级路径。这是「没有 ID 列」时的唯一去重手段，也是最容易静默丢账的地方 ——
 * 曾经只用 (时间, 类型, 金额, 账户1) 四段做键，同一个账户在同一秒的两笔同额支出
 * 会算出同一个指纹，第二条在按 ID 去重时被当成重复丢掉。
 */
describe('ID 缺失时的指纹降级', () => {
  it('逐字相同的两行也必须拿到不同的主键 —— 宁可重复导入，不能吃掉账单', async () => {
    const same = { 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5, 账户1: '饭卡', 备注: '咖啡' }
    const r = await parseWorkbook(build([row(same), row(same)]))

    expect(r.txns).toHaveLength(2)
    const ids = new Set(r.txns.map((t) => t.id))
    expect(ids.size).toBe(2)
    // 两条都进了 txns，交给上层按 ID 去重时也不会互相吞掉
    expect([...ids].every((id) => id.startsWith('fb'))).toBe(true)
  })

  it('同一秒同额但备注不同的两行，本来就该是两条', async () => {
    const r = await parseWorkbook(
      build([
        row({ 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5, 账户1: '饭卡', 备注: '咖啡' }),
        row({ 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5, 账户1: '饭卡', 备注: '酸奶' }),
      ]),
    )
    expect(new Set(r.txns.map((t) => t.id)).size).toBe(2)
  })

  it('重复解析同一份文件得到完全相同的主键 —— 否则重复导入会翻倍', async () => {
    const rows = [
      row({ 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5, 账户1: '饭卡', 备注: '咖啡' }),
      row({ 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5, 账户1: '饭卡', 备注: '咖啡' }),
      row({ 时间: '2026-09-20 11:00:00', 类型: '收入', 金额: 100, 账户1: '招行' }),
    ]
    const a = await parseWorkbook(build(rows))
    const b = await parseWorkbook(build(rows))
    expect(a.txns.map((t) => t.id)).toEqual(b.txns.map((t) => t.id))
  })

  it('有 ID 的行一律用 ID，不参与指纹计数', async () => {
    const r = await parseWorkbook(
      build([
        row({ ID: 'qj1', 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5 }),
        row({ 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5 }),
      ]),
    )
    expect(r.txns[0].id).toBe('qj1')
    expect(r.fingerprinted).toBe(1)
  })

  it('报告降级行数，让用户知道去重保护正在打折', async () => {
    const r = await parseWorkbook(
      build([
        row({ ID: 'qj1', 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5 }),
        row({ 时间: '2026-09-20 11:00:00', 类型: '支出', 金额: 6 }),
        row({ 时间: '2026-09-20 12:00:00', 类型: '支出', 金额: 7 }),
      ]),
    )
    expect(r.fingerprinted).toBe(2)

    const clean = await parseWorkbook(
      build([row({ ID: 'qj9', 时间: '2026-09-20 10:00:00', 类型: '支出', 金额: 5 })]),
    )
    expect(clean.fingerprinted).toBe(0)
  })
})
