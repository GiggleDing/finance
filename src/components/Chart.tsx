import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

/** 统一字体，避免图表里的中文回退到衬线体 */
export const CHART_FONT =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'

export const CHART_COLORS = ['#1D4ED8', '#C2410C', '#15803D', '#8A6412', '#6B6B6B', '#9333EA', '#0891B2', '#BE123C']

export function Chart({ option, height = 240 }: { option: EChartsCoreOption; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const instRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const inst = echarts.init(el)
    instRef.current = inst
    const onResize = () => inst.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      inst.dispose()
      instRef.current = null
    }
  }, [])

  useEffect(() => {
    instRef.current?.setOption(option, true)
  }, [option])

  return <div ref={ref} style={{ height, width: '100%' }} />
}
