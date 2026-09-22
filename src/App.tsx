import { useCallback, useMemo, useState } from 'react'
import { useLensData } from './hooks/useLensData'
import { Overview } from './components/Overview'
import { Reports } from './components/Reports'
import { Investment } from './components/Investment'
import { Transactions } from './components/Transactions'
import { DataPanel } from './components/DataPanel'
import { totals } from './core/stats'

type TabKey = 'overview' | 'reports' | 'investment' | 'txns' | 'data'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: '总览' },
  { key: 'reports', label: '报表' },
  { key: 'investment', label: '投资' },
  { key: 'txns', label: '流水' },
  { key: 'data', label: '数据' },
]

export default function App() {
  const { txns, snapshots, loading, reload } = useLensData()
  const [tab, setTab] = useState<TabKey>('overview')

  const agg = useMemo(() => totals(txns), [txns])
  const isEmpty = !loading && txns.length === 0

  // 没数据时，无论点哪个 Tab 都只能先去「数据」页导入
  const activeTab: TabKey = isEmpty ? 'data' : tab

  const goData = useCallback(() => setTab('data'), [])

  return (
    <div className="min-h-full pb-16">
      <header className="sticky top-0 z-10 bg-ink-50/92 backdrop-blur-sm border-b border-ink-100">
        <div className="mx-auto max-w-4xl px-5">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-baseline gap-2 min-w-0">
              <h1 className="text-[15px] font-medium tracking-tight">账本透视</h1>
              <span className="text-2xs text-ink-400 truncate">
                {loading
                  ? '读取中'
                  : txns.length > 0
                    ? `${txns.length} 笔 · ${agg.dateMin?.slice(0, 10) ?? ''} 起`
                    : '本机运行，数据不上传'}
              </span>
            </div>
          </div>
          <nav className="flex gap-0.5 -mb-px overflow-x-auto">
            {TABS.map((t) => {
              const disabled = isEmpty && t.key !== 'data'
              const active = activeTab === t.key
              return (
                <button
                  key={t.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => setTab(t.key)}
                  className={[
                    'px-3 py-2 text-[13px] border-b-2 whitespace-nowrap transition-colors',
                    active
                      ? 'border-ink-900 text-ink-900 font-medium'
                      : disabled
                        ? 'border-transparent text-ink-300 cursor-not-allowed'
                        : 'border-transparent text-ink-500 hover:text-ink-900',
                  ].join(' ')}
                >
                  {t.label}
                </button>
              )
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-5">
        {loading ? (
          <div className="text-2xs text-ink-400 py-20 text-center">正在读取本地数据…</div>
        ) : activeTab === 'overview' ? (
          <Overview txns={txns} snapshots={snapshots} reload={reload} onGoData={goData} />
        ) : activeTab === 'reports' ? (
          <Reports txns={txns} />
        ) : activeTab === 'investment' ? (
          <Investment txns={txns} />
        ) : activeTab === 'txns' ? (
          <Transactions txns={txns} />
        ) : (
          <DataPanel txns={txns} reload={reload} />
        )}
      </main>

      <footer className="mx-auto max-w-4xl px-5 pb-8">
        <p className="text-2xs text-ink-300 leading-relaxed">
          所有数据只保存在你这台设备的浏览器里，不会上传到任何服务器。
          换了电脑或清了浏览器数据就需要用备份文件恢复 —— 建议每次导入账单后都导出一份备份。
        </p>
      </footer>
    </div>
  )
}
