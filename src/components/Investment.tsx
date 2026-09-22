import { useMemo } from 'react'
import type { Txn } from '../types'
import { EFFECTIVE_WINDOW_START, FUND_ACCOUNT } from '../types'
import { investmentMonthly } from '../core/stats'
import { Badge, Card, CardHeader, Stat } from './ui'
import { CHART_FONT, Chart } from './Chart'
import { fmtMoney, fmtNum, fmtYm, fmtYmShort } from '../utils/format'
import type { EChartsCoreOption } from 'echarts/core'

export function Investment({ txns }: { txns: Txn[] }) {
  const all = useMemo(() => investmentMonthly(txns), [txns])
  const rows = useMemo(() => all.filter((r) => r.ym >= EFFECTIVE_WINDOW_START), [all])

  const totalInvested = all.reduce((a, r) => a + r.netInvested, 0)
  const totalGain = all.reduce((a, r) => a + r.gain, 0)
  const monthsWithGain = all.filter((r) => r.hasGainRecord).length
  const missingGain = rows.filter((r) => !r.hasGainRecord && r.netInvested !== 0)

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
        data: rows.map((r) => fmtYmShort(r.ym)),
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
          formatter: (v: number) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v)),
        },
        splitLine: { lineStyle: { color: '#F1F1EE' } },
      },
      series: [
        {
          name: '当月投入',
          type: 'bar',
          data: rows.map((r) => Number(r.netInvested.toFixed(2))),
          itemStyle: { color: '#1D4ED8', borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 22,
        },
        {
          name: '当月收益',
          type: 'bar',
          data: rows.map((r) => (r.hasGainRecord ? Number(r.gain.toFixed(2)) : null)),
          itemStyle: { color: '#15803D', borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 22,
        },
      ],
    }),
    [rows],
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="投资：只看每月投入和收益"
          desc={`投入是从流水里自动认出来的——转账且资金流入「${FUND_ACCOUNT}」账户。收益来自你每月在钱迹里记的那笔收入（账户选「${FUND_ACCOUNT}」），随账单一起导入，不需要在这里另外填。`}
        />
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-ink-100 border-b border-ink-100 sm:divide-x">
          <Stat label="累计净投入" value={fmtMoney(totalInvested)} sub={`${all.length} 个月有记录`} />
          <Stat label="累计记录收益" value={fmtMoney(totalGain)} tone="income" />
          <Stat label="已记收益月份" value={`${monthsWithGain} / ${rows.length}`} sub="有效窗口内" />
          <Stat
            label="最新月度"
            value={rows.length > 0 ? fmtYm(rows[rows.length - 1].ym) : '—'}
            sub={rows.length > 0 ? `投入 ${fmtMoney(rows[rows.length - 1].netInvested)}` : ''}
          />
        </div>
        <div className="px-2 pb-3 pt-2">
          {rows.length === 0 ? (
            <div className="px-2 py-10 text-center text-2xs text-ink-400">
              还没有识别到基金相关的记录。投入来自「转账」且转入账户为「{FUND_ACCOUNT}」的账单；收益来自「收入」且账户为「{FUND_ACCOUNT}」的账单。
            </div>
          ) : (
            <Chart option={chartOption} height={250} />
          )}
        </div>
      </Card>

      {rows.length > 0 && (
        <Card>
          <CardHeader title="逐月明细" desc="收益那列显示「未记」的月份，是你在钱迹里还没记这个月的基金收益。" />
          <div className="px-4 pb-4">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-2xs text-ink-400 border-b border-ink-100">
                  <th className="text-left font-normal py-2">月份</th>
                  <th className="text-right font-normal py-2">转入</th>
                  <th className="text-right font-normal py-2">转出</th>
                  <th className="text-right font-normal py-2">净投入</th>
                  <th className="text-right font-normal py-2">收益</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((r) => (
                  <tr key={r.ym} className="border-b border-ink-50 last:border-0">
                    <td className="py-2">{fmtYm(r.ym)}</td>
                    <td className="py-2 text-right tnum text-ink-500">
                      {r.invested > 0 ? fmtNum(r.invested) : '—'}
                    </td>
                    <td className="py-2 text-right tnum text-ink-500">
                      {r.redeemed > 0 ? fmtNum(r.redeemed) : '—'}
                    </td>
                    <td className="py-2 text-right tnum">{fmtNum(r.netInvested)}</td>
                    <td className="py-2 text-right tnum">
                      {r.hasGainRecord ? (
                        <span className={r.gain >= 0 ? 'text-income' : 'text-expense'}>{fmtNum(r.gain)}</span>
                      ) : (
                        <span className="text-ink-300">未记</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {missingGain.length > 0 && (
        <Card>
          <div className="px-4 py-3.5">
            <div className="flex items-start gap-2">
              <Badge tone="notice">提醒</Badge>
              <div className="text-2xs text-ink-500 leading-relaxed">
                这 {missingGain.length} 个月有投入但没记收益：
                {missingGain.map((r) => fmtYm(r.ym)).join('、')}。
                想看到收益曲线的话，在钱迹里补一笔「收入」，账户选「{FUND_ACCOUNT}」、金额填当期收益即可，
                下次导入账单就会自动带上。
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <div className="px-4 py-3.5">
          <p className="text-2xs text-ink-400 leading-relaxed">
            这里刻意不算「收益率」和「年化」。你的钱是分批投进去的，用「累计收益 ÷ 累计投入」算出来的比率
            没有意义；要算真收益率得知道每一笔的买入时点和份额，钱迹的导出里没有这些信息。与其给一个看起来
            专业但实际不准的数字，不如就只报投入和收益本身。
          </p>
        </div>
      </Card>
    </div>
  )
}
