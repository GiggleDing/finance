import { useMemo, useState } from 'react'
import type { Txn } from '../types'
import { EFFECTIVE_WINDOW_START } from '../types'
import { expenseByCategory, expenseBySubCategory, monthlyFlows } from '../core/stats'
import { Badge, Button, Card, CardHeader } from './ui'
import { CHART_COLORS, CHART_FONT, Chart } from './Chart'
import { fmtMoney, fmtNum, fmtYm, fmtYmShort, pct } from '../utils/format'
import type { EChartsCoreOption } from 'echarts/core'

function axisFmt(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 10000) return `${(v / 10000).toFixed(1)}万`
  if (abs >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(v)
}

export function Reports({ txns }: { txns: Txn[] }) {
  const [mode, setMode] = useState<'category' | 'sub'>('category')
  const [range, setRange] = useState<'window' | 'all'>('window')

  const months = useMemo(() => monthlyFlows(txns), [txns])
  const windowed = useMemo(() => months.filter((m) => m.inWindow), [months])
  const outsideCount = months.filter((m) => !m.inWindow).reduce((a, m) => a + m.txnCount, 0)

  const ymRange = range === 'window' ? { from: EFFECTIVE_WINDOW_START } : undefined
  const cats = useMemo(
    () => (mode === 'category' ? expenseByCategory(txns, ymRange) : expenseBySubCategory(txns, ymRange)),
    [txns, mode, ymRange],
  )
  const totalExpense = cats.reduce((a, c) => a + c.amount, 0)
  const maxAmount = cats.length > 0 ? Math.max(...cats.map((c) => c.amount)) : 0

  const chartOption = useMemo<EChartsCoreOption>(
    () => ({
      grid: { left: 4, right: 8, top: 30, bottom: 2, containLabel: true },
      tooltip: {
        trigger: 'axis',
        textStyle: { fontFamily: CHART_FONT, fontSize: 12 },
        valueFormatter: (v: unknown) => fmtMoney(Number(v)),
      },
      legend: {
        top: 0,
        left: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { fontFamily: CHART_FONT, fontSize: 11, color: '#6B6B6B' },
      },
      xAxis: {
        type: 'category',
        data: windowed.map((m) => fmtYmShort(m.ym)),
        axisLine: { lineStyle: { color: '#E8E8E4' } },
        axisTick: { show: false },
        axisLabel: { fontFamily: CHART_FONT, fontSize: 11, color: '#8A8A8A' },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          fontFamily: CHART_FONT,
          fontSize: 11,
          color: '#8A8A8A',
          formatter: (v: number) => axisFmt(v),
        },
        splitLine: { lineStyle: { color: '#F1F1EE' } },
      },
      series: [
        {
          name: '收入',
          type: 'bar',
          data: windowed.map((m) => Number(m.income.toFixed(2))),
          itemStyle: { color: '#15803D', borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 22,
        },
        {
          name: '支出',
          type: 'bar',
          data: windowed.map((m) => Number(m.expense.toFixed(2))),
          itemStyle: { color: '#C2410C', borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 22,
        },
      ],
    }),
    [windowed],
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="月度收支"
          desc={`只统计 ${fmtYm(EFFECTIVE_WINDOW_START)} 之后的月份。${fmtYm(EFFECTIVE_WINDOW_START)} 之前一共只有 ${outsideCount} 条记录（基本是车贷月供的历史补齐），混进来会看成「常年为零然后突然暴涨」。`}
        />
        <div className="px-2 pb-3">
          {windowed.length === 0 ? (
            <div className="px-2 py-10 text-center text-2xs text-ink-400">有效窗口内还没有数据</div>
          ) : (
            <Chart option={chartOption} height={250} />
          )}
        </div>
        {windowed.length > 0 && (
          <div className="border-t border-ink-100 px-4 py-3">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-2xs text-ink-400">
                  <th className="text-left font-normal pb-2">月份</th>
                  <th className="text-right font-normal pb-2">收入</th>
                  <th className="text-right font-normal pb-2">支出</th>
                  <th className="text-right font-normal pb-2">结余</th>
                  <th className="text-right font-normal pb-2">储蓄率</th>
                  <th className="text-right font-normal pb-2">笔数</th>
                </tr>
              </thead>
              <tbody>
                {[...windowed].reverse().map((m) => (
                  <tr key={m.ym} className="border-t border-ink-50">
                    <td className="py-2">{fmtYm(m.ym)}</td>
                    <td className="py-2 text-right tnum text-income">{fmtNum(m.income)}</td>
                    <td className="py-2 text-right tnum text-expense">{fmtNum(m.expense)}</td>
                    <td className={`py-2 text-right tnum ${m.net < 0 ? 'text-expense' : ''}`}>
                      {fmtNum(m.net)}
                    </td>
                    <td className="py-2 text-right tnum text-ink-500">
                      {m.savingsRate === null ? '—' : pct(m.savingsRate)}
                    </td>
                    <td className="py-2 text-right tnum text-ink-400">{m.txnCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="支出去了哪"
          desc={
            mode === 'category'
              ? '按钱迹的一级分类。占比过高的分类说明里面装得太杂，切到「二级明细」能看清具体是什么。'
              : '按一级 + 二级展开。标「未细分」的是你在钱迹里没填二级分类的记录。'
          }
          right={
            <div className="flex gap-2 items-center">
              <div className="flex rounded-lg border border-ink-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setMode('category')}
                  className={`px-2.5 py-1 text-2xs ${mode === 'category' ? 'bg-ink-900 text-white' : 'text-ink-500'}`}
                >
                  一级
                </button>
                <button
                  type="button"
                  onClick={() => setMode('sub')}
                  className={`px-2.5 py-1 text-2xs ${mode === 'sub' ? 'bg-ink-900 text-white' : 'text-ink-500'}`}
                >
                  二级明细
                </button>
              </div>
            </div>
          }
        />
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-2xs text-ink-400">统计范围</span>
            <Button variant={range === 'window' ? 'primary' : 'default'} onClick={() => setRange('window')}>
              {fmtYm(EFFECTIVE_WINDOW_START)}起
            </Button>
            <Button variant={range === 'all' ? 'primary' : 'default'} onClick={() => setRange('all')}>
              全部历史
            </Button>
            <span className="text-2xs text-ink-400 ml-auto">
              合计 {fmtMoney(totalExpense)} · {cats.reduce((a, c) => a + c.count, 0)} 笔
            </span>
          </div>
        </div>

        <div className="px-4 pb-4">
          {cats.length === 0 ? (
            <div className="py-8 text-center text-2xs text-ink-400">没有支出数据</div>
          ) : (
            <ul className="space-y-2.5">
              {cats.slice(0, mode === 'category' ? 20 : 30).map((c, i) => (
                <li key={`${c.category}-${c.subCategory ?? ''}`}>
                  <div className="flex items-baseline gap-2 text-[13px]">
                    <span className="flex-1 min-w-0 truncate">
                      {c.category}
                      {c.subCategory && (
                        <span className="text-ink-400 text-2xs">
                          {' / '}
                          {c.subCategory}
                        </span>
                      )}
                    </span>
                    <span className="text-2xs text-ink-400 tnum">{c.count} 笔</span>
                    <span className="tnum w-24 text-right">{fmtMoney(c.amount)}</span>
                    <span className="tnum w-12 text-right text-ink-400">{pct(c.share)}</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-ink-100 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${maxAmount > 0 ? (c.amount / maxAmount) * 100 : 0}%`,
                        background: CHART_COLORS[i % CHART_COLORS.length],
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {mode === 'sub' && cats.length > 30 && (
            <p className="text-2xs text-ink-400 mt-3">
              <Badge>提示</Badge> 只显示了前 30 项，共 {cats.length} 个二级分类。
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}
