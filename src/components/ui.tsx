import type { ReactNode } from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-white border border-ink-100 rounded-xl ${className}`}>{children}</div>
}

export function CardHeader({ title, desc, right }: { title: string; desc?: string; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
      <div className="min-w-0">
        <h3 className="text-[13px] font-medium text-ink-900">{title}</h3>
        {desc && <p className="text-2xs text-ink-400 mt-0.5 leading-relaxed">{desc}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  )
}

const TONE_TEXT: Record<string, string> = {
  neutral: 'text-ink-900',
  expense: 'text-expense',
  income: 'text-income',
  accent: 'text-accent',
}

export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string
  value: string
  sub?: string
  tone?: keyof typeof TONE_TEXT
}) {
  return (
    <div className="px-4 py-3">
      <div className="text-2xs text-ink-400">{label}</div>
      <div className={`tnum text-[19px] font-medium mt-1 tracking-tight ${TONE_TEXT[tone]}`}>{value}</div>
      {sub && <div className="text-2xs text-ink-400 mt-1">{sub}</div>}
    </div>
  )
}

const BADGE_TONE: Record<string, string> = {
  neutral: 'bg-ink-50 text-ink-500 border-ink-100',
  alert: 'bg-[#FDF3EF] text-expense border-[#F3D9CD]',
  notice: 'bg-[#FBF7EC] text-[#8A6412] border-[#EFE1BC]',
  good: 'bg-[#F1F8F3] text-income border-[#CFE6D6]',
  accent: 'bg-[#EFF3FD] text-accent border-[#D3E0F9]',
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: keyof typeof BADGE_TONE }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-2xs border whitespace-nowrap ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  )
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'ghost'
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  const base =
    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  const styles = {
    default: 'bg-white border border-ink-200 text-ink-700 hover:bg-ink-50',
    primary: 'bg-ink-900 text-white hover:bg-ink-700',
    ghost: 'text-ink-500 hover:bg-ink-50',
  }[variant]
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>
      {children}
    </button>
  )
}

export function EmptyState({
  title,
  desc,
  action,
}: {
  title: string
  desc?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-14">
      <div className="text-[13px] font-medium text-ink-700">{title}</div>
      {desc && <div className="text-2xs text-ink-400 mt-1.5 max-w-md leading-relaxed">{desc}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Bar({ value, tone = 'ink' }: { value: number; tone?: 'ink' | 'expense' | 'income' }) {
  const color = tone === 'expense' ? 'bg-expense' : tone === 'income' ? 'bg-income' : 'bg-ink-400'
  return (
    <div className="h-1.5 w-full rounded-full bg-ink-100 overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}
