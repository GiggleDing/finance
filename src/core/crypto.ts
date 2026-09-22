/**
 * 密码学原语层。这里只做「纯粹的、可单测的」加解密，不碰任何存储。
 *
 * 改动前请先读懂这几条，它们是这套东西成立的前提：
 *
 *  1. **信封加密**。真正锁住数据的是随机生成的 DEK（数据主密钥），用户密码只负责
 *     「包住」DEK。这样改密码只是重新包一次 DEK（毫秒级），不必重新加密整个库；
 *     也就不会出现「改密码改到一半断电，数据两头不靠」的状态。
 *  2. **AES-GCM 自带认证标签**。密文被改动一个字节，解密就会抛错。所以不需要额外
 *     再算一个 MAC；反过来说，解密失败既可能是密码错、也可能是数据被改，上层必须
 *     统一处理，不能把两者区分着报出去（那是给攻击者送信息）。
 *  3. **每次加密都必须用全新随机 IV**。GCM 在同一个密钥下复用 IV 会直接泄漏密钥流，
 *     这是死线。所以 seal() 里自己生成 IV，绝不接受调用方传入。
 *  4. **AAD 把密文钉死在用途上**。同一个密钥会加密多种东西（DEK 包装、校验探针、
 *     数据体、备份体），AAD 让「把 A 处的密文挪到 B 处」直接解密失败。
 *  5. salt 和 IV 都不保密，明文存在信封里；保密的是 DEK 和密码本身。
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * PBKDF2-HMAC-SHA256 的迭代次数。OWASP 对 SHA-256 的建议下限就是 60 万。
 * 这个数字只影响「猜密码的代价」和「解锁时多等几百毫秒」，不影响正确性。
 * 调低等于削弱，不要为了手感去动它。
 */
export const PBKDF2_ITERATIONS = 600_000

/** 校验探针的已知明文。作用是区分「密码错」与「数据坏」，以及空库时也能验密码。 */
export const VERIFIER_PLAINTEXT = 'qianji-lens/vault/v2'

/** AAD 常量：把每段密文钉死在自己的用途上，防止密文被互换位置 */
export const AAD_DEK = 'qianji-lens|dek'
export const AAD_VERIFIER = 'qianji-lens|verifier'
export const AAD_VAULT = 'qianji-lens|vault'
export const AAD_BACKUP = 'qianji-lens|backup'

/** 落盘形态的密文。iv 与 ct 都是 base64，都不保密。 */
export interface Sealed {
  iv: string
  ct: string
}

export interface KdfParams {
  name: 'PBKDF2'
  hash: 'SHA-256'
  iterations: number
  /** base64，16 字节 */
  salt: string
}

/* ─────────────────────────── 编解码 ─────────────────────────── */

/**
 * TS 5.7 起 `Uint8Array` 带上了底层缓冲区泛型（`ArrayBufferLike` 可能是 SharedArrayBuffer），
 * 而 Web Crypto 的 `BufferSource` 只接受 ArrayBuffer 底层的视图。
 * 与其在每个调用点写 `as BufferSource` 把类型错误按下去，不如在这里一次性收窄：
 * 本模块产生的字节一律是普通 ArrayBuffer，这个别名就是把这个事实写进类型里。
 */
export type Bytes = Uint8Array<ArrayBuffer>

/**
 * getRandomValues 单次最多填 65536 字节，超了抛 QuotaExceededError。
 * 生产路径上只用到 12/15/16 字节，本来踩不到；但一个通用工具函数留一个
 * 「你得自己知道上限」的坑迟早会被踩到，所以在这里分块填满。
 */
const RANDOM_MAX = 65_536

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n)
  for (let offset = 0; offset < n; offset += RANDOM_MAX) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + RANDOM_MAX, n)))
  }
  return out
}

/**
 * 分块转换。一次把十万个字节塞进 String.fromCharCode 会爆栈，
 * 而账单量级下密文动辄几百 KB，所以必须切片。
 */
export function toB64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function fromB64(b64: string): Bytes {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/*
 * 注意：btoa/atob 只认 latin1。上面两个函数刻意按「字节」处理，不做任何文本解释，
 * UTF-8 的转换一律交给 TextEncoder/TextDecoder，这样中文备注不会在往返中损坏。
 */

/* ───────────────────────── 密钥派生 ───────────────────────── */

export function newKdfParams(saltBytes = 16): KdfParams {
  return {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations: PBKDF2_ITERATIONS,
    salt: toB64(randomBytes(saltBytes)),
  }
}

/**
 * 密码 / 恢复码 → KEK（钥匙加密密钥）。
 * extractable=false：派生出来的密钥永远拿不到裸字节，只能被 Web Crypto 内部使用。
 */
export async function deriveKek(secret: string, params: KdfParams): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromB64(params.salt),
      iterations: params.iterations,
      hash: params.hash,
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * 数据主密钥。
 * extractable=true 是必须的 —— 它要被密码和恢复码各包一份存进 IndexedDB，
 * 还要能导出裸字节供会话续期用。这是整套设计里唯一一个「可导出」的密钥。
 */
export async function newDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

export async function exportDekRaw(dek: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', dek))
}

export async function importDekRaw(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

/* ───────────────────────── 加解密 ───────────────────────── */

/** IV 在这里生成，不接受外部传入 —— 防止调用方手滑复用 IV 把密钥流泄漏出去。 */
export async function seal(key: CryptoKey, plaintext: BufferSource, aad: string): Promise<Sealed> {
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    plaintext,
  )
  return { iv: toB64(iv), ct: toB64(ct) }
}

export async function open(key: CryptoKey, sealed: Sealed, aad: string): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: encoder.encode(aad) },
    key,
    fromB64(sealed.ct),
  )
}

export async function sealJson(key: CryptoKey, value: unknown, aad: string): Promise<Sealed> {
  return seal(key, encoder.encode(JSON.stringify(value)), aad)
}

export async function openJson<T>(key: CryptoKey, sealed: Sealed, aad: string): Promise<T> {
  const buf = await open(key, sealed, aad)
  return JSON.parse(decoder.decode(buf)) as T
}

/* ──────────────────── 带填充的封装（防长度泄漏） ──────────────────── */

/**
 * GCM **不做任何填充** —— 密文长度严格等于明文长度。
 *
 * 这件事有一个容易被忽略的后果：不处理的话，备份文件的大小能直接反推出条数。
 * 实测约 414 字节/笔（含 base64 膨胀），1502 笔 ≈ 622KB，看一眼文件大小就知道
 * 里面大概有多少条记录。对于一个会被放进网盘、私有仓库的文件来说，
 * 「条数」本身就是关于你的信息。
 *
 * 所以这里把明文填充到**下一个 2 的幂**再加密：512KB~1MB 之间的所有备份在外部
 * 看起来一模一样大，攻击者最多只能判断数量级。代价是文件变大
 * （1502 笔从 622KB 变成 1MB）—— 对一份备份来说完全可以忽略。
 *
 * 编码方式是「4 字节大端长度前缀 + JSON 字节 + 零填充」，解开时先读长度再切片，
 * 所以填充不影响 JSON 本身的解析，也不需要给密文加标记位。
 *
 * 一个容易算错的地方：GCM 会在密文末尾再追加 **16 字节认证标签**，所以
 * `密文长度 = 填充后的明文长度 + 16`。防泄漏性质不受影响（桶仍然是离散的，
 * 同桶负载的密文长度完全相同），但任何「密文长度是不是 2 的幂」的判断都是错的。
 */

/** 分档下限：几十条的小备份也统一长成 32KB，避免小数据集被精确识别 */
const PAD_FLOOR = 32 * 1024
const LEN_PREFIX = 4

function paddedLength(needed: number): number {
  let size = PAD_FLOOR
  while (size < needed + LEN_PREFIX) size *= 2
  return size
}

export async function sealPaddedJson(key: CryptoKey, value: unknown, aad: string): Promise<Sealed> {
  const body = encoder.encode(JSON.stringify(value))
  const out = new Uint8Array(paddedLength(body.length))
  new DataView(out.buffer).setUint32(0, body.length, false)
  out.set(body, LEN_PREFIX)
  return seal(key, out, aad)
}

export async function openPaddedJson<T>(key: CryptoKey, sealed: Sealed, aad: string): Promise<T> {
  const buf = await open(key, sealed, aad)
  const view = new Uint8Array(buf)
  if (view.length < LEN_PREFIX) throw new Error('密文长度不合法')

  const bodyLength = new DataView(view.buffer, view.byteOffset, LEN_PREFIX).getUint32(0, false)
  if (bodyLength > view.length - LEN_PREFIX) throw new Error('密文长度前缀与内容不符')

  const body = view.subarray(LEN_PREFIX, LEN_PREFIX + bodyLength)
  return JSON.parse(decoder.decode(body)) as T
}

/* ─────────────────────── 密码校验探针 ─────────────────────── */

export async function makeVerifier(kek: CryptoKey): Promise<Sealed> {
  return seal(kek, encoder.encode(VERIFIER_PLAINTEXT), AAD_VERIFIER)
}

export async function checkVerifier(kek: CryptoKey, sealed: Sealed): Promise<boolean> {
  try {
    return decoder.decode(await open(kek, sealed, AAD_VERIFIER)) === VERIFIER_PLAINTEXT
  } catch {
    return false
  }
}

/* ─────────────────────────── 恢复码 ─────────────────────────── */

/**
 * 恢复码字母表：从 A–Z 和 0–9 里剔掉 4 个最容易手抄认错的符号
 * （数字 0 与字母 O、数字 1 与字母 I），剩下 **32 个符号，正好 5 bit 一个**。
 *
 * 注意这个 32 是硬约束，不是巧合：120 bit ÷ 5 = 24 位，一位不多一位不少。
 * 如果为了「再顺手剔掉 L」把它变成 31 个符号，5 bit 映射就塌了，
 * 必须改用模运算（引入偏置）或者拒绝采样，得不偿失。
 * 所以 L 是保留的 —— 任何提示用户「恢复码不含 L」的文案都是错的。
 */
export const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** 24 个符号 × 5 bit = 120 bit 熵，足以抵抗离线穷举。 */
export const RECOVERY_LENGTH = 24

/**
 * 无偏生成，返回**不带连字符**的 24 位原始码。
 *
 * 取 15 字节 = 120 bit，按 5 bit 一组切出 24 个符号。不要写成「每字节 % 32」，
 * 那样会引入模偏置。这里 120 恰好被 5 整除，没有任何剩余 bit 需要丢弃。
 *
 * 刻意返回原始码而不是带连字符的展示形态：PBKDF2 的输入必须是唯一的，
 * 而展示用的连字符会和 normalizeRecoveryCode 的「丢掉非字母表字符」逻辑打架，
 * 一旦哪边改了另一边没改，用户手上的恢复码就静默失效了。展示一律走 formatRecoveryCode。
 */
export function newRecoveryCode(): string {
  const bytes = randomBytes(15)
  let acc = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += RECOVERY_ALPHABET[(acc >>> bits) & 31]
    }
  }
  return out
}

/** 每 4 位加一个连字符，纯为方便肉眼分段照抄。归一化时会去掉。 */
export function formatRecoveryCode(raw: string): string {
  return normalizeRecoveryCode(raw).replace(/(.{4})(?=.)/g, '$1-')
}

/**
 * 用户输入归一化：转大写、丢掉连字符/空格等一切非字母表字符。
 * 不做「O→0、I→1」这种纠正 —— 字母表里本来就没有 0 和 1，
 * 猜着纠正只会把「输错了」伪装成「密码不对」，更难排查。
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .split('')
    .filter((ch) => RECOVERY_ALPHABET.includes(ch))
    .join('')
}

/**
 * 恢复码使用前先做一次结构性检查。
 * PBKDF2 要跑 60 万次，对着一串明显不合法（长度不对）的输入白跑一遍没有意义。
 * 注意：这只拦「格式不对」，不构成任何安全性判断。
 */
export function isValidRecoveryCodeShape(input: string): boolean {
  return normalizeRecoveryCode(input).length === RECOVERY_LENGTH
}
