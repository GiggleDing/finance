import type { VaultPayload } from './db'
import {
  AAD_BACKUP,
  checkVerifier,
  deriveKek,
  makeVerifier,
  newKdfParams,
  openPaddedJson,
  sealPaddedJson,
  type KdfParams,
  type Sealed,
} from './crypto'

/**
 * 加密备份。
 *
 * 为什么备份必须加密，而不是「顺手也加密一下」：
 * GitHub Pages 上没有服务端，浏览器本地数据随时可能因为清缓存、换设备、
 * 换浏览器而消失。所以备份文件天然会被用户放到网盘、iCloud、私有仓库里 ——
 * 那是**离开你控制范围**的位置。一份明文 JSON 账单躺在别人的服务器上，
 * 等于把整套收支明细公开了。加密之后，这个文件放在哪里都不再是关键问题。
 *
 * 关键结构决定：每个备份文件**自带独立的 salt 和迭代数**，而不是复用保险箱的。
 *   - 备份可以脱离保险箱单独打开（恢复时不要求先建保险箱）
 *   - 改主密码不会让历史备份失效，旧备份仍然用它导出时那个密码打开
 * 代价是：你要记住「这份备份是用哪个密码导的」。UI 上会明确提示这一点。
 */

export interface EncryptedBackup {
  app: 'qianji-lens'
  format: 'encrypted-backup'
  version: 2
  /**
   * 只精确到日。
   * 精确到秒的时间戳会暴露「你什么时候做的财务整理」这类行为信息，
   * 而且对恢复数据毫无帮助 —— 用户只需要知道这是一份哪天的备份。
   */
  exportedOn: string
  kdf: KdfParams
  /** 已知明文的加密封装，用来把「密码错」和「文件坏」分开报 */
  verifier: Sealed
  payload: Sealed
}

/** 旧版明文备份（v1）。只读兼容，不再产生。 */
interface LegacyBackup {
  app: 'qianji-lens'
  version: 1
  exportedAt?: string
  txns?: unknown
  snapshots?: unknown
}

export type BackupKind = 'encrypted' | 'legacy-plaintext' | 'unknown'

export interface BackupProbe {
  kind: BackupKind
  exportedOn: string | null
  /** 旧版明文备份里的条数，加密备份拿不到（解密前不泄漏条数） */
  legacyCounts: { txnCount: number; snapshotCount: number } | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/* ───────────────────────── 导出 ───────────────────────── */

export async function buildEncryptedBackup(payload: VaultPayload, password: string): Promise<EncryptedBackup> {
  const kdf = newKdfParams()
  const kek = await deriveKek(password, kdf)
  return {
    app: 'qianji-lens',
    format: 'encrypted-backup',
    version: 2,
    exportedOn: today(),
    kdf,
    verifier: await makeVerifier(kek),
    // 带填充封装：GCM 不填充，密文长度 = 明文长度，不处理的话文件大小能反推出条数。
    // 填到 2 的幂之后，同档位的备份在外部看起来一样大。
    payload: await sealPaddedJson(
      kek,
      { txns: payload.txns, snapshots: payload.snapshots, imports: payload.imports },
      AAD_BACKUP,
    ),
  }
}

export function downloadEncryptedBackup(backup: EncryptedBackup): string {
  const fileName = `qianji-lens-backup-${backup.exportedOn}.json`
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  return fileName
}

/* ───────────────────────── 导入 ───────────────────────── */

async function readJson(file: File): Promise<unknown> {
  let text: string
  try {
    text = await file.text()
  } catch {
    throw new Error('读不到这个文件，可能已被移动或没有读取权限。')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('这个文件不是合法的 JSON。请确认选的是「账本透视」导出的备份文件。')
  }
}

/**
 * 先探明文件类型，再决定要不要向用户要密码。
 * 加密备份在解密之前**不暴露任何条数**，所以探针只回报「这是加密备份」。
 */
export async function probeBackupFile(file: File): Promise<BackupProbe> {
  const parsed = await readJson(file)

  if (isRecord(parsed) && parsed.app === 'qianji-lens' && parsed.format === 'encrypted-backup') {
    return {
      kind: 'encrypted',
      exportedOn: typeof parsed.exportedOn === 'string' ? parsed.exportedOn : null,
      legacyCounts: null,
    }
  }

  if (isRecord(parsed) && parsed.app === 'qianji-lens' && Array.isArray(parsed.txns)) {
    return {
      kind: 'legacy-plaintext',
      exportedOn: typeof parsed.exportedAt === 'string' ? parsed.exportedAt.slice(0, 10) : null,
      legacyCounts: {
        txnCount: (parsed.txns as unknown[]).length,
        snapshotCount: Array.isArray(parsed.snapshots) ? (parsed.snapshots as unknown[]).length : 0,
      },
    }
  }

  return { kind: 'unknown', exportedOn: null, legacyCounts: null }
}

export interface OpenedBackup {
  payload: VaultPayload
  exportedOn: string | null
  /** 明文旧备份，导入时需要额外警告 */
  legacy: boolean
}

/**
 * 解开备份文件。
 *
 * 两步失败分开报：verifier 过不了 = 密码错（确定）；verifier 过了但数据体解不开
 * = 文件被改坏过（确定）。这里区分两者不会给攻击者额外信息 —— 他手上已经有
 * 整个文件可以做离线穷举，verifier 的存在本身就允许他离线判断密码对错。
 * 真正需要防的是「用错误信息试探服务端接口」，而这里根本没有服务端。
 */
export async function openBackupFile(file: File, password: string): Promise<OpenedBackup> {
  const parsed = await readJson(file)

  if (isRecord(parsed) && parsed.app === 'qianji-lens' && parsed.format === 'encrypted-backup') {
    const backup = parsed as unknown as EncryptedBackup
    const kek = await deriveKek(password, backup.kdf)

    if (!(await checkVerifier(kek, backup.verifier))) {
      throw new Error('这个备份文件的密码不对。注意：备份用的是**导出那一刻**的密码，如果你改过主密码，旧备份要用旧密码打开。')
    }

    let payload: VaultPayload
    try {
      payload = await openPaddedJson<VaultPayload>(kek, backup.payload, AAD_BACKUP)
    } catch {
      throw new Error('密码是对的，但数据体解不开，说明这个文件在传输或存放过程中被改动过。换一份备份试试。')
    }

    return {
      payload: {
        txns: Array.isArray(payload.txns) ? payload.txns : [],
        snapshots: Array.isArray(payload.snapshots) ? payload.snapshots : [],
        imports: Array.isArray(payload.imports) ? payload.imports : [],
      },
      exportedOn: typeof backup.exportedOn === 'string' ? backup.exportedOn : null,
      legacy: false,
    }
  }

  if (isRecord(parsed) && parsed.app === 'qianji-lens' && Array.isArray(parsed.txns)) {
    const legacy = parsed as unknown as LegacyBackup
    return {
      payload: {
        txns: legacy.txns as VaultPayload['txns'],
        snapshots: Array.isArray(legacy.snapshots) ? (legacy.snapshots as VaultPayload['snapshots']) : [],
        imports: [],
      },
      exportedOn: typeof legacy.exportedAt === 'string' ? legacy.exportedAt.slice(0, 10) : null,
      legacy: true,
    }
  }

  throw new Error('这不是「账本透视」的备份文件。')
}
