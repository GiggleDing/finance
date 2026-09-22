import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Badge, Button, Card, CardHeader } from './ui'
import {
  buildEncryptedBackup,
  downloadEncryptedBackup,
  openBackupFile,
  probeBackupFile,
  type BackupProbe,
} from '../core/backup'
import {
  changePassword,
  currentPayload,
  destroyEverything,
  hasRecoveryCode,
  mergeFromBackup,
  reissueRecoveryCode,
  verifyPassword,
  vaultFacts,
} from '../core/session'
import { MIN_PASSWORD_LENGTH, assessPassword } from '../core/password'
import type { Txn } from '../types'

/**
 * 保险箱卡片：备份、恢复、改密码、恢复码、拆箱。
 *
 * 这一屏是整个应用里唯一「做错了没法回头」的地方，所以交互上刻意偏保守：
 *  - 导出备份时默认帮你核对主密码，避免打错一个字导出一份永远打不开的文件
 *  - 恢复码重新生成后立刻弹一次性展示，没有被静默覆盖的可能
 *  - 拆掉保险箱要求手打「删除」
 */

type Dialog =
  | { kind: 'export' }
  | { kind: 'restore'; file: File; probe: BackupProbe }
  | { kind: 'change' }
  | { kind: 'reissue' }
  | { kind: 'destroy' }
  | null

export function SecurityPanel({ txns }: { txns: Txn[] }) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [facts, setFacts] = useState<{ createdAt: number | null; hasRecoveryCode: boolean }>({
    createdAt: null,
    hasRecoveryCode: false,
  })

  const restoreRef = useRef<HTMLInputElement>(null)

  async function refreshFacts() {
    const [f, rc] = await Promise.all([vaultFacts(), hasRecoveryCode()])
    setFacts({ createdAt: f.createdAt, hasRecoveryCode: rc })
  }

  useEffect(() => {
    void refreshFacts()
  }, [])

  function close() {
    setDialog(null)
  }

  async function handleRestoreFile(file: File) {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const probe = await probeBackupFile(file)
      if (probe.kind === 'unknown') {
        throw new Error('这不是「账本透视」的备份文件。')
      }
      setDialog({ kind: 'restore', file, probe })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader
        title="保险箱"
        desc="数据在浏览器里是加密存的，明文只在解锁期间存在于内存中。备份文件同样是加密的，可以放心放进网盘或私有仓库。"
        right={facts.hasRecoveryCode ? <Badge tone="good">已设恢复码</Badge> : <Badge tone="alert">无恢复码</Badge>}
      />

      <div className="px-4 pb-4 space-y-3">
        {error && (
          <div className="rounded-lg border border-[#F3D9CD] bg-[#FDF3EF] px-3 py-2.5 text-2xs text-expense leading-relaxed">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-[#CFE6D6] bg-[#F1F8F3] px-3 py-2.5 text-2xs text-income leading-relaxed">
            {notice}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setDialog({ kind: 'export' })} disabled={busy || txns.length === 0}>
            导出加密备份
          </Button>
          <Button onClick={() => restoreRef.current?.click()} disabled={busy}>
            从备份恢复
          </Button>
          <Button onClick={() => setDialog({ kind: 'change' })} disabled={busy}>
            修改密码
          </Button>
          <Button onClick={() => setDialog({ kind: 'reissue' })} disabled={busy}>
            重新生成恢复码
          </Button>
        </div>

        <p className="text-2xs text-ink-400 leading-relaxed">
          每个备份文件自带独立的盐，所以<b>改主密码不会让旧备份失效</b>——旧备份仍然用它导出当时那个密码打开。
          记不清的话，把备份文件和它的密码一起写进密码管理器的备注里。
        </p>

        {facts.createdAt && (
          <p className="text-2xs text-ink-300">
            保险箱建立于 {new Date(facts.createdAt).toLocaleString('zh-CN')}
          </p>
        )}

        <div className="border-t border-ink-100 pt-3">
          <Button variant="ghost" onClick={() => setDialog({ kind: 'destroy' })} disabled={busy}>
            拆掉保险箱
          </Button>
        </div>
      </div>

      <input
        ref={restoreRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleRestoreFile(f)
          e.target.value = ''
        }}
      />

      {dialog?.kind === 'export' && (
        <ExportDialog
          txns={txns}
          onClose={close}
          onDone={(msg) => {
            setNotice(msg)
            close()
          }}
        />
      )}

      {dialog?.kind === 'restore' && (
        <RestoreDialog
          file={dialog.file}
          probe={dialog.probe}
          onClose={close}
          onDone={(msg) => {
            setNotice(msg)
            close()
          }}
        />
      )}

      {dialog?.kind === 'change' && (
        <ChangePasswordDialog
          onClose={close}
          onDone={(msg) => {
            setNotice(msg)
            close()
          }}
        />
      )}

      {dialog?.kind === 'reissue' && (
        <ReissueDialog
          onClose={close}
          onDone={(msg) => {
            setNotice(msg)
            void refreshFacts()
            close()
          }}
        />
      )}

      {dialog?.kind === 'destroy' && (
        <DestroyDialog
          onClose={close}
          onDone={() => {
            close()
          }}
        />
      )}
    </Card>
  )
}

/* ───────────────────────── 导出 ───────────────────────── */

function ExportDialog({ txns, onClose, onDone }: { txns: Txn[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [password, setPassword] = useState('')
  const [isMaster, setIsMaster] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleExport() {
    setError(null)
    setBusy(true)
    try {
      if (isMaster) {
        // 这一步不是为了安全，是为了防手滑：备份密码打错一个字，
        // 导出的文件就永远打不开了，而且你不会立刻发现。
        const ok = await verifyPassword(password)
        if (!ok) throw new Error('这不像是你的主密码，密码没对上。请再输一次，或取消「用主密码」改用别的密码。')
      } else if (password.length < 8) {
        throw new Error('给这个备份单独设的密码也至少要 8 位。')
      }

      const backup = await buildEncryptedBackup(currentPayload(), password)
      const name = downloadEncryptedBackup(backup)
      onDone(`已导出 ${name}，包含 ${txns.length} 笔流水。这个文件是加密的，放到网盘或私有仓库都可以，但请记住打开它的密码。`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="导出加密备份"
      desc="备份文件自带独立的盐和密码——它不依赖本机这个保险箱就能打开。"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void handleExport()} disabled={busy || !password}>
            {busy ? '正在加密…' : '导出'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
        </div>
      }
    >
      <PasswordField label="给这个备份设的密码" value={password} onChange={setPassword} autoComplete="off" />

      <label className="flex items-start gap-2 text-2xs text-ink-500 leading-relaxed cursor-pointer">
        <input type="checkbox" checked={isMaster} onChange={(e) => setIsMaster(e.target.checked)} className="mt-0.5" />
        <span>这就是我的主密码（导出前帮我核对一遍，防止打错字导出一个永远打不开的文件）</span>
      </label>

      {!isMaster && (
        <p className="text-2xs text-ink-400 leading-relaxed">
          换成别的密码也可以，但那样你就需要另外记住它，而且改主密码之后更容易搞混。
        </p>
      )}

      {error && <ErrorAlert>{error}</ErrorAlert>}
    </Modal>
  )
}

/* ───────────────────────── 恢复 ───────────────────────── */

function RestoreDialog({
  file,
  probe,
  onClose,
  onDone,
}: {
  file: File
  probe: BackupProbe
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRestore() {
    setError(null)
    setBusy(true)
    try {
      const opened = await openBackupFile(file, password)

      if (opened.legacy) {
        const confirmed = window.confirm(
          '这是一份**未加密的旧版备份**，里面是明文账单。继续导入后数据会被重新加密存进来，但那个旧文件本身仍然是明文的，建议导入完就删掉它。要继续吗？',
        )
        if (!confirmed) {
          setBusy(false)
          return
        }
      }

      const outcome = await mergeFromBackup(opened.payload)
      onDone(
        `恢复完成：新增 ${outcome.txnsInserted} 笔（跳过重复 ${outcome.txnsDuplicated} 笔），账户快照 ${outcome.snapshotsRestored} 条。` +
          (opened.legacy ? ' 原文件是明文备份，请记得删除它。' : ''),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const requiresPassword = probe.kind === 'encrypted'

  return (
    <Modal
      title="从备份恢复"
      desc={requiresPassword ? '这个文件是加密的，输入导出它时用的那个密码。' : '这是一份旧版明文备份。'}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void handleRestore()} disabled={busy || (requiresPassword && !password)}>
            {busy ? '正在恢复…' : '恢复'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
        </div>
      }
    >
      <div className="rounded-lg bg-ink-50 px-3 py-2.5 text-2xs text-ink-500 leading-relaxed">
        <div className="truncate">
          文件：<span className="text-ink-700">{file.name}</span>
        </div>
        {probe.exportedOn && <div>导出于：{probe.exportedOn}</div>}
        {probe.legacyCounts && (
          <div>
            内含：{probe.legacyCounts.txnCount} 笔流水、{probe.legacyCounts.snapshotCount} 条快照（明文，可直接读出）
          </div>
        )}
      </div>

      {requiresPassword ? (
        <PasswordField label="备份密码" value={password} onChange={setPassword} autoComplete="off" autoFocus />
      ) : (
        <ErrorAlert>这是一份明文备份，不需要密码。导入后数据会被加密存进保险箱。</ErrorAlert>
      )}

      <p className="text-2xs text-ink-400 leading-relaxed">
        恢复采用<b>合并</b>而不是覆盖：流水按账单 ID 补齐，已有的不会重复；账户快照会被备份里的版本整份替换。
      </p>

      {error && <ErrorAlert>{error}</ErrorAlert>}
    </Modal>
  )
}

/* ───────────────────────── 改密码 ───────────────────────── */

function ChangePasswordDialog({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const assessment = next ? assessPassword(next) : null

  async function handleChange() {
    setError(null)
    if (!assessment?.acceptable) {
      setError(assessment ? assessment.issues.map((i) => i.message).join('\n') : '请填写新密码。')
      return
    }
    if (next !== confirm) {
      setError('两次输入的新密码不一样。')
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
      onDone('密码已改。数据体没有重新加密，所以是瞬时的；旧备份仍然用旧密码打开，新的备份用新密码。')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="修改主密码"
      desc="只重新包装主密钥，数据体不动，所以几乎瞬间完成。"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void handleChange()} disabled={busy || !current || !next || !confirm}>
            {busy ? '正在修改…' : '确认修改'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
        </div>
      }
    >
      <PasswordField label="当前密码" value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
      <PasswordField
        label="新密码"
        value={next}
        onChange={setNext}
        autoComplete="new-password"
        placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`}
      />
      {assessment && (
        <p className="text-2xs text-ink-400">
          新密码强度：约 {assessment.bits} bit{assessment.acceptable ? '' : `（不够，需要 ≥ 50）`}
        </p>
      )}
      <PasswordField label="再输一遍新密码" value={confirm} onChange={setConfirm} autoComplete="new-password" />

      <p className="text-2xs text-ink-400 leading-relaxed">
        改完密码后，恢复码<b>不会</b>跟着变。如果你担心恢复码也泄露了，再单独重新生成一次。
      </p>

      {error && <ErrorAlert>{error}</ErrorAlert>}
    </Modal>
  )
}

/* ───────────────────────── 恢复码 ───────────────────────── */

function ReissueDialog({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleReissue() {
    setError(null)
    setBusy(true)
    try {
      await reissueRecoveryCode(password)
      // 新恢复码由 VaultGate 里的全局一次性展示层接管，这里只负责收尾
      onDone('已生成新的恢复码，旧的即刻作废。请看弹出的那一屏——它只显示这一次。')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="重新生成恢复码"
      desc="适用于「恢复码可能已经泄露」或「找不到当初抄的那张纸」。旧码会立即作废。"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void handleReissue()} disabled={busy || !password}>
            {busy ? '正在生成…' : '生成新的恢复码'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
        </div>
      }
    >
      <PasswordField label="当前密码" value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
      <p className="text-2xs text-ink-400 leading-relaxed">
        需要验证当前密码——否则一个走到你电脑前面的人就能悄悄换掉恢复码，把后门留在自己手里。
      </p>
      {error && <ErrorAlert>{error}</ErrorAlert>}
    </Modal>
  )
}

/* ───────────────────────── 拆箱 ───────────────────────── */

function DestroyDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleDestroy() {
    setBusy(true)
    try {
      await destroyEverything()
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="拆掉保险箱"
      desc="删除加密数据和密码本身，回到「首次设置」。这一步不可撤销。"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void handleDestroy()} disabled={busy || typed !== '删除'}>
            {busy ? '正在删除…' : '确认拆掉'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
        </div>
      }
    >
      <ErrorAlert>
        ⚠️ 拆掉之后，没有备份文件的话数据就找不回来了。密码和恢复码都会一起消失。
        <br />
        如果你只是想重新导入一遍账单，请改用「清空账面数据」，那个会保留保险箱。
      </ErrorAlert>

      <label className="block">
        <span className="text-2xs text-ink-400">输入「删除」以确认</span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-[13px] outline-none focus:border-expense"
        />
      </label>
    </Modal>
  )
}

/* ───────────────────────── 零件 ───────────────────────── */

function Modal({
  title,
  desc,
  children,
  footer,
  onClose,
}: {
  title: string
  desc?: string
  children: ReactNode
  footer: ReactNode
  onClose: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-ink-900/45 px-4 py-10">
      <div className="w-full max-w-md bg-white rounded-xl border border-ink-100 px-5 py-5 space-y-3.5">
        <div>
          <h2 className="text-[14px] font-medium">{title}</h2>
          {desc && <p className="text-2xs text-ink-400 mt-1 leading-relaxed">{desc}</p>}
        </div>
        {children}
        {footer}
      </div>
    </div>
  )
}

function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[#F3D9CD] bg-[#FDF3EF] px-3 py-2.5 text-2xs text-expense leading-relaxed whitespace-pre-line">
      {children}
    </div>
  )
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  autoFocus,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  autoComplete?: string
  placeholder?: string
  autoFocus?: boolean
}) {
  const [reveal, setReveal] = useState(false)
  return (
    <label className="block">
      <span className="text-2xs text-ink-400">{label}</span>
      <span className="mt-1 flex items-stretch gap-1.5">
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 min-w-0 rounded-lg border border-ink-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => setReveal((v) => !v)}
          className="shrink-0 rounded-lg border border-ink-200 px-2.5 text-2xs text-ink-500 hover:bg-ink-50"
        >
          {reveal ? '隐藏' : '显示'}
        </button>
      </span>
    </label>
  )
}
