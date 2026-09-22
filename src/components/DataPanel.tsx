import { useRef, useState } from 'react'
import type { Txn } from '../types'
import { parseWorkbook, type ParseResult } from '../core/parse'
import { importTxns, recordImport, wipeAll } from '../core/db'
import { buildBackup, downloadBackup, restoreBackup } from '../core/backup'
import { totals } from '../core/stats'
import { Badge, Button, Card, CardHeader } from './ui'
import { fmtMoney, fmtNum, kindLabel } from '../utils/format'

interface ImportReport {
  fileName: string
  parse: ParseResult
  inserted: number
  duplicated: number
}

export function DataPanel({ txns, reload }: { txns: Txn[]; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const restoreRef = useRef<HTMLInputElement>(null)

  const agg = totals(txns)

  async function handleBillFile(file: File) {
    setBusy(true)
    setError(null)
    setNotice(null)
    setReport(null)
    try {
      const buf = await file.arrayBuffer()
      const parse = await parseWorkbook(buf)

      if (parse.missingColumns.length > 0) {
        throw new Error(
          `这份文件缺少必要列：${parse.missingColumns.join('、')}。请确认导出的是钱迹的账单文件（需要「时间」「类型」「金额」这三列）。`,
        )
      }
      if (parse.txns.length === 0) {
        throw new Error('文件里没有解析出任何账单，请确认导出时选择了账单数据而不是空账本。')
      }

      const outcome = await importTxns(parse.txns)
      await recordImport({
        fileName: file.name,
        importedAt: Date.now(),
        totalRows: parse.totalRows,
        inserted: outcome.inserted,
        duplicated: outcome.duplicated,
        skipped: parse.skipped,
        anomalies: [
          ...parse.issues.slice(0, 50).map((i) => `第 ${i.row} 行：${i.reason}`),
          ...(parse.unknownTypes.length > 0 ? [`未识别的类型：${parse.unknownTypes.join('、')}`] : []),
        ],
      })
      await reload()
      setReport({ fileName: file.name, parse, inserted: outcome.inserted, duplicated: outcome.duplicated })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleBackupDownload() {
    setBusy(true)
    setError(null)
    try {
      const backup = await buildBackup()
      const name = downloadBackup(backup)
      setNotice(`已导出 ${name}，包含 ${backup.txnCount} 笔流水、${backup.snapshotCount} 条账户快照。`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleRestore(file: File) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await restoreBackup(file)
      await reload()
      setNotice(
        `恢复完成：新增 ${r.txnsInserted} 笔（跳过重复 ${r.txnsDuplicated} 笔），账户快照 ${r.snapshotsRestored} 条。`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      if (restoreRef.current) restoreRef.current.value = ''
    }
  }

  async function handleWipe() {
    setBusy(true)
    setError(null)
    try {
      await wipeAll()
      await reload()
      setReport(null)
      setConfirmWipe(false)
      setNotice('本地数据已清空。')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-[#F3D9CD] bg-[#FDF3EF] px-4 py-3 text-[13px] text-expense">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-[#CFE6D6] bg-[#F1F8F3] px-4 py-3 text-[13px] text-income">
          {notice}
        </div>
      )}

      <Card>
        <CardHeader
          title="导入钱迹账单"
          desc="钱迹 App → 设置与关于 → 数据导出 → 选 Excel 或 CSV → 把这个文件拖进来。重复导入同一份文件不会产生重复数据。"
        />
        <div className="px-4 pb-4">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const f = e.dataTransfer.files?.[0]
              if (f) void handleBillFile(f)
            }}
            onClick={() => fileRef.current?.click()}
            className={[
              'cursor-pointer rounded-xl border border-dashed px-6 py-10 text-center transition-colors',
              dragOver ? 'border-accent bg-[#EFF3FD]' : 'border-ink-200 bg-ink-50 hover:border-ink-300',
            ].join(' ')}
          >
            <div className="text-[13px] font-medium text-ink-700">
              {busy ? '正在处理…' : '把账单文件拖到这里，或点击选择'}
            </div>
            <div className="text-2xs text-ink-400 mt-1.5">支持 .xlsx / .xls / .csv</div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleBillFile(f)
              }}
            />
          </div>
        </div>

        {report && (
          <div className="border-t border-ink-100 px-4 py-3.5">
            <div className="flex items-center gap-2 mb-2.5">
              <span className="text-[13px] font-medium">导入结果</span>
              <span className="text-2xs text-ink-400 truncate">{report.fileName}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <MiniStat label="文件数据行" value={String(report.parse.totalRows)} />
              <MiniStat label="新入库" value={String(report.inserted)} tone="good" />
              <MiniStat label="跳过重复" value={String(report.duplicated)} />
              <MiniStat label="异常跳过" value={String(report.parse.skipped)} tone={report.parse.skipped > 0 ? 'alert' : undefined} />
            </div>
            {report.parse.unknownTypes.length > 0 && (
              <p className="text-2xs text-expense mt-3">
                钱迹里出现了本系统还不认识的类型：{report.parse.unknownTypes.join('、')}。这些账单已入库但未计入收支，
                请告诉我，我来适配。
              </p>
            )}
            {report.parse.issues.length > 0 && (
              <details className="mt-3">
                <summary className="text-2xs text-ink-500 cursor-pointer">
                  查看跳过的 {report.parse.issues.length} 行明细
                </summary>
                <ul className="mt-2 space-y-1 max-h-48 overflow-auto">
                  {report.parse.issues.map((i, idx) => (
                    <li key={idx} className="text-2xs text-ink-500">
                      Excel 第 {i.row} 行：{i.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Card>

      {txns.length > 0 && (
        <Card>
          <CardHeader
            title="数据体检"
            desc="按钱迹原始类型统计。转账、还贷、退款、报销都不计入收支，所以「真实收支」会比流水总数小。"
          />
          <div className="px-4 pb-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <MiniStat label="真实收入" value={fmtMoney(agg.income)} tone="good" />
              <MiniStat label="真实支出" value={fmtMoney(agg.expense)} tone="alert" />
              <MiniStat label="结余" value={fmtMoney(agg.net)} />
              <MiniStat label="真实收支笔数" value={`${agg.realFlowCount} / ${agg.txnCount}`} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-2xs text-ink-400 border-b border-ink-100">
                    <th className="text-left font-normal py-2">类型</th>
                    <th className="text-right font-normal py-2">笔数</th>
                    <th className="text-right font-normal py-2">金额合计</th>
                    <th className="text-left font-normal py-2 pl-4">是否计入收支</th>
                  </tr>
                </thead>
                <tbody>
                  {agg.kindStats.map((k) => {
                    const counted = k.kind === 'expense' || k.kind === 'income'
                    return (
                      <tr key={k.kind} className="border-b border-ink-50 last:border-0">
                        <td className="py-2">{kindLabel(k.kind)}</td>
                        <td className="py-2 text-right tnum">{k.count}</td>
                        <td className="py-2 text-right tnum">{fmtNum(k.amount)}</td>
                        <td className="py-2 pl-4">
                          {counted ? (
                            <Badge tone="accent">计入</Badge>
                          ) : k.kind === 'refund' || k.kind === 'reimburse' ? (
                            <Badge tone="good">冲减支出</Badge>
                          ) : (
                            <Badge>不计入</Badge>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="备份与恢复"
          desc="数据只存在这台设备的浏览器里。清缓存、换电脑、换浏览器都会导致数据消失，因此每次导入后请导出一份备份。"
        />
        <div className="px-4 pb-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void handleBackupDownload()} disabled={busy || txns.length === 0}>
            导出备份（JSON）
          </Button>
          <Button onClick={() => restoreRef.current?.click()} disabled={busy}>
            从备份恢复
          </Button>
          <input
            ref={restoreRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleRestore(f)
            }}
          />
        </div>
      </Card>

      {txns.length > 0 && (
        <Card>
          <CardHeader title="清空本地数据" desc="删除后无法撤销，除非你手上有备份文件。" />
          <div className="px-4 pb-4">
            {confirmWipe ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-expense">
                  确认删除全部 {txns.length} 笔流水和账户快照？
                </span>
                <Button variant="primary" onClick={() => void handleWipe()} disabled={busy}>
                  确认删除
                </Button>
                <Button variant="ghost" onClick={() => setConfirmWipe(false)}>
                  取消
                </Button>
              </div>
            ) : (
              <Button onClick={() => setConfirmWipe(true)} disabled={busy}>
                清空数据
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'alert' }) {
  const color = tone === 'good' ? 'text-income' : tone === 'alert' ? 'text-expense' : 'text-ink-900'
  return (
    <div className="rounded-lg bg-ink-50 px-3 py-2.5">
      <div className="text-2xs text-ink-400">{label}</div>
      <div className={`tnum text-[15px] font-medium mt-0.5 ${color}`}>{value}</div>
    </div>
  )
}
