import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Badge, Button } from './ui'
import { assessPassword, MIN_PASSWORD_LENGTH, suggestPassword } from '../core/password'
import {
  dismissRecoveryCode,
  resetPasswordWithRecoveryCode,
  setVaultError,
  setupVault,
  unlock,
  useVault,
} from '../core/session'
import { formatRecoveryCode } from '../core/crypto'
import { copySensitive } from '../utils/clipboard'

/**
 * 保险箱门禁。
 *
 * 三种入口状态各自对应一个真实场景，不能合并：
 *   setup  —— 第一次用，或者刚换了一台机器（还没有保险箱）
 *   locked —— 有保险箱，但会话里的钥匙已经不在了（新开标签页 / 手动锁定）
 *   broken —— 信封在但数据体解不开，只能靠备份文件救
 *
 * 解锁失败信息一律走同一句话。区分「密码错」「主密钥损坏」「JSON 坏了」
 * 只会让攻击者拿着错误信息做筛选，对用户却没有任何帮助。
 */
export function VaultGate({ children }: { children: ReactNode }) {
  const { status, pending, freshRecoveryCode, error } = useVault()

  if (status === 'loading') {
    return (
      <Frame>
        <p className="text-2xs text-ink-400 py-10 text-center">正在打开保险箱…</p>
      </Frame>
    )
  }

  if (status === 'broken') {
    return (
      <Frame>
        <Heading title="保险箱打不开了" desc="信封还在，但里面的数据体解不出来。这通常意味着浏览器数据被外部程序改动过。" />
        <p className="text-[13px] text-expense leading-relaxed px-1">{error}</p>
        <div className="mt-4">
          <Button variant="primary" onClick={() => window.location.reload()}>
            重新载入页面
          </Button>
        </div>
      </Frame>
    )
  }

  if (status === 'setup') {
    return (
      <Frame>
        <SetupScreen pending={pending} />
      </Frame>
    )
  }

  if (status === 'locked') {
    return (
      <Frame>
        <UnlockScreen error={error} />
      </Frame>
    )
  }

  return (
    <>
      {children}
      {freshRecoveryCode && <RecoveryCodeSheet code={freshRecoveryCode} />}
    </>
  )
}

/* ───────────────────────── 外壳 ───────────────────────── */

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full flex items-start justify-center px-5 py-16">
      <div className="w-full max-w-md">
        <div className="flex items-baseline gap-2 mb-5">
          <h1 className="text-[15px] font-medium tracking-tight">账本透视</h1>
          <span className="text-2xs text-ink-400">本机运行 · 数据不上传</span>
        </div>
        <div className="bg-white border border-ink-100 rounded-xl px-5 py-5 space-y-4">{children}</div>
      </div>
    </div>
  )
}

function Heading({ title, desc }: { title: string; desc?: string }) {
  return (
    <div>
      <h2 className="text-[14px] font-medium text-ink-900">{title}</h2>
      {desc && <p className="text-2xs text-ink-400 mt-1.5 leading-relaxed">{desc}</p>}
    </div>
  )
}

function FieldAlert({ children, tone }: { children: ReactNode; tone: 'error' | 'warn' | 'info' }) {
  const styles = {
    error: 'border-[#F3D9CD] bg-[#FDF3EF] text-expense',
    warn: 'border-[#EFE1BC] bg-[#FBF7EC] text-[#8A6412]',
    info: 'border-[#D3E0F9] bg-[#EFF3FD] text-accent',
  }[tone]
  return (
    <div className={`rounded-lg border px-3 py-2.5 text-2xs leading-relaxed whitespace-pre-line ${styles}`}>
      {children}
    </div>
  )
}

/* ───────────────────────── 首次设置 ───────────────────────── */

function SetupScreen({ pending }: { pending: { txnCount: number; snapshotCount: number } | null }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const assessment = useMemo(() => (password ? assessPassword(password) : null), [password])
  const mismatch = confirm.length > 0 && confirm !== password

  async function handleSubmit() {
    setLocalError(null)
    if (!assessment?.acceptable) {
      setLocalError(assessment ? '密码强度还不够，下面列了具体原因。' : '请先填密码。')
      return
    }
    if (password !== confirm) {
      setLocalError('两次输入的密码不一样。')
      return
    }
    setBusy(true)
    try {
      await setupVault(password)
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Heading
        title="先给数据上一把锁"
        desc="这把锁只在你这台设备上。密码不会发到任何服务器，也不会存进浏览器——它只用来在本地推导出一把加密钥匙。"
      />

      {pending && (
        <FieldAlert tone="info">
          发现本机还有 <b className="tnum">{pending.txnCount}</b> 笔未加密的流水、
          <b className="tnum">{pending.snapshotCount}</b> 条账户快照。设好密码后它们会被一并加密，
          明文副本随即从浏览器里抹掉。
        </FieldAlert>
      )}

      <div className="space-y-3">
        <PasswordField
          label="设置密码"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`}
          onEnter={handleSubmit}
        />
        {assessment && <StrengthMeter assessment={assessment} />}
        <PasswordField
          label="再输一遍"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          onEnter={handleSubmit}
          invalid={mismatch}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            const s = suggestPassword()
            setPassword(s)
            setConfirm(s)
          }}
          disabled={busy}
        >
          给我生成一个
        </Button>
      </div>

      <FieldAlert tone="warn">
        ⚠️ 这个密码忘了，钱迹导出的流水可以从钱迹重新导，但手动录入的账户余额快照会一起丢掉。
        下一屏会给你一串<b>恢复码</b>，那是唯一的重置后路——请抄下来存到跟这台电脑无关的地方。
      </FieldAlert>

      {(localError || (assessment && !assessment.acceptable && password)) && (
        <FieldAlert tone="error">{localError ?? assessment?.issues.map((i) => `· ${i.message}`).join('\n')}</FieldAlert>
      )}

      <Button variant="primary" onClick={() => void handleSubmit()} disabled={busy || !password || !confirm}>
        {busy ? '正在加密…' : '建立保险箱'}
      </Button>
    </>
  )
}

/* ───────────────────────── 解锁 / 重置 ───────────────────────── */

function UnlockScreen({ error }: { error: string | null }) {
  const [mode, setMode] = useState<'unlock' | 'reset'>('unlock')

  if (mode === 'reset') return <ResetScreen onBack={() => setMode('unlock')} />
  return <UnlockForm error={error} onForgot={() => setMode('reset')} />
}

function UnlockForm({ error, onForgot }: { error: string | null; onForgot: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  async function handleSubmit() {
    if (!password) return
    setLocalError(null)
    setVaultError(null)
    setBusy(true)
    try {
      await unlock(password)
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Heading
        title="保险箱是锁着的"
        desc="数据在浏览器里是加密存的。输入密码解开，明文只会短暂存在于这个页面的内存里。"
      />

      <PasswordField
        label="密码"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        onEnter={() => void handleSubmit()}
        autoFocus
      />

      {(localError || error) && <FieldAlert tone="error">{localError ?? error}</FieldAlert>}

      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void handleSubmit()} disabled={busy || !password}>
          {busy ? '正在解密…' : '解锁'}
        </Button>
        <Button variant="ghost" onClick={onForgot} disabled={busy}>
          忘记密码了
        </Button>
      </div>

      <p className="text-2xs text-ink-300 leading-relaxed">
        刷新页面不用重输密码，关掉这个标签页就要。手动锁定在右上角。
      </p>
    </>
  )
}

function ResetScreen({ onBack }: { onBack: () => void }) {
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const assessment = useMemo(() => (password ? assessPassword(password) : null), [password])

  async function handleSubmit() {
    setLocalError(null)
    if (!assessment?.acceptable) {
      setLocalError(assessment ? '新密码强度不够。' : '请填写新密码。')
      return
    }
    if (password !== confirm) {
      setLocalError('两次输入的新密码不一样。')
      return
    }
    setBusy(true)
    try {
      await resetPasswordWithRecoveryCode(code, password)
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Heading
        title="用恢复码重置密码"
        desc="恢复码是设置密码时生成的那串 24 位字符。重置成功后会作废，并给你一条新的。"
      />

      <PasswordField
        label="恢复码"
        value={code}
        onChange={setCode}
        autoComplete="off"
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
        mono
        autoFocus
      />

      <div className="space-y-3">
        <PasswordField
          label="新密码"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`}
        />
        {assessment && <StrengthMeter assessment={assessment} />}
        <PasswordField label="再输一遍新密码" value={confirm} onChange={setConfirm} autoComplete="new-password" />
      </div>

      {localError && <FieldAlert tone="error">{localError}</FieldAlert>}

      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void handleSubmit()} disabled={busy || !code || !password || !confirm}>
          {busy ? '正在重置…' : '重置密码'}
        </Button>
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          返回输入密码
        </Button>
      </div>
    </>
  )
}

/* ───────────────────────── 恢复码展示 ───────────────────────── */

function RecoveryCodeSheet({ code }: { code: string }) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [copied, setCopied] = useState(false)

  // 恢复码是唯一的重置后路，误触关闭等于让用户永远看不到它
  useEffect(() => {
    function blockEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') e.preventDefault()
    }
    window.addEventListener('keydown', blockEsc)
    return () => window.removeEventListener('keydown', blockEsc)
  }, [])

  const pretty = formatRecoveryCode(code)

  async function handleCopy() {
    setCopied(await copySensitive(code))
  }

  function handleDownload() {
    const text = [
      '账本透视 · 恢复码',
      '',
      `恢复码：${pretty}`,
      '',
      '用途：主密码忘记时，用它重置密码。',
      '',
      '存放建议：存进密码管理器（1Password / 苹果钥匙串 / Bitwarden 都可以）。',
      '不要把它和备份文件放在同一个网盘账号里——那样一把钥匙和一把锁就在一起了。',
      '',
      `生成时间：${new Date().toLocaleString('zh-CN')}`,
    ].join('\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'qianji-lens-recovery-code.txt'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-ink-900/45 px-4 py-10">
      <div className="w-full max-w-lg bg-white rounded-xl border border-ink-100 px-5 py-5 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-medium">这是你的恢复码</h2>
          <Badge tone="notice">只显示这一次</Badge>
        </div>

        <FieldAlert tone="warn">
          它等同于一把能重置主密码的钥匙。请现在就存到一个跟这台电脑无关的地方 ——
          密码管理器最合适。关掉这一屏之后，系统里不会再有它的明文。
        </FieldAlert>

        <div className="rounded-lg border border-ink-200 bg-ink-50 px-4 py-4">
          <div className="font-mono text-[15px] tracking-[0.12em] text-ink-900 break-all text-center tnum">
            {pretty}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void handleCopy()}>{copied ? '已复制（60 秒后自动清空剪贴板）' : '复制'}</Button>
          <Button onClick={handleDownload}>下载为文本</Button>
        </div>

        <label className="flex items-start gap-2 text-2xs text-ink-500 leading-relaxed cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            我已经把恢复码存好了。我理解：密码和恢复码都丢失的话，本机数据无法恢复，
            只能从备份文件或钱迹重新导入。
          </span>
        </label>

        <Button variant="primary" onClick={dismissRecoveryCode} disabled={!acknowledged}>
          {acknowledged ? '进入系统' : '请先勾选上面的确认'}
        </Button>
      </div>
    </div>
  )
}

/* ───────────────────────── 零件 ───────────────────────── */

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  onEnter,
  invalid,
  mono,
  autoFocus,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  autoComplete?: string
  placeholder?: string
  onEnter?: () => void
  invalid?: boolean
  mono?: boolean
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
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEnter?.()
          }}
          placeholder={placeholder}
          className={[
            'flex-1 min-w-0 rounded-lg border bg-white px-3 py-2 text-[13px] outline-none transition-colors',
            mono ? 'font-mono tracking-wider tnum' : '',
            invalid ? 'border-[#E4B9A8] focus:border-expense' : 'border-ink-200 focus:border-accent',
          ].join(' ')}
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

function StrengthMeter({ assessment }: { assessment: ReturnType<typeof assessPassword> }) {
  const config = {
    'too-short': { width: 0.15, color: 'bg-expense', label: '太短' },
    weak: { width: 0.35, color: 'bg-expense', label: '偏弱' },
    fair: { width: 0.7, color: 'bg-[#B45309]', label: '够用' },
    strong: { width: 1, color: 'bg-income', label: '很强' },
  }[assessment.level]

  return (
    <div>
      <div className="flex items-center justify-between text-2xs text-ink-400 mb-1">
        <span>强度：{config.label}</span>
        <span className="tnum">约 {assessment.bits} bit（需要 ≥ 50）</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-ink-100 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${config.color}`} style={{ width: `${config.width * 100}%` }} />
      </div>
    </div>
  )
}
