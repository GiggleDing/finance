/**
 * 密码强度评估。
 *
 * 为什么要有这个东西：PBKDF2 的 60 万次迭代提高的是「每次猜测的成本」，
 * 它完全不改变「密码本身有多好猜」。如果密码是 `20260922` 或者 `wangwei123`，
 * 攻击者拿着备份文件离线穷举，几十万次迭代也就多花他几个小时而已。
 * 所以强度门槛必须在设密码那一刻卡住，而不是靠 KDF 参数兜底。
 *
 * 这里刻意不引第三方库（zxcvbn 之类）：一个静态站点，为了一个只在设置密码时
 * 跑一次的函数去引入几十 KB 词典和依赖，收益远小于风险。下面这套规则
 * 用一段能读懂、能单测的逻辑覆盖了真实世界最常见的弱密码形态。
 *
 * 需要说清楚的边界：这是**启发式**，不是数学证明。它能把「一眼就完蛋」的密码
 * 挡在门外，挡不住一个用心良苦挑出来的弱密码。
 */

/** 长度是唯一真正有效的熵来源，其余规则只是补救 */
export const MIN_PASSWORD_LENGTH = 10

/** 认为足够安全的估算熵下限（bit）。50 bit 意味着离线穷举需要 2^50 次猜测。 */
export const MIN_ACCEPTABLE_BITS = 50

/**
 * 最常见弱密码。不求全，只求覆盖真实世界里出现频率最高的那一撮。
 * 全部小写比对，命中即拒绝（不看长度）。
 */
const COMMON_PASSWORDS = new Set([
  'password', 'passw0rd', 'password1', 'password123', 'p@ssw0rd', 'passwd',
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910',
  '111111', '000000', '666666', '888888', 'abc123', 'abcd1234', 'a1b2c3',
  'qwerty', 'qwertyuiop', 'qwerty123', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'zxcvbn',
  'iloveyou', 'woaini', 'woaini1314', '5201314', '1314520', '520520',
  'admin', 'administrator', 'root', 'letmein', 'welcome', 'monkey', 'dragon',
  'sunshine', 'princess', 'football', 'baseball', 'superman', 'master',
  'login', 'starwars', 'whatever', 'trustno1', 'freedom', 'shadow',
  'chinese', 'china', 'beijing', 'shanghai', 'wangwei', 'zhangwei', 'liwei',
  'wangfang', 'lilei', 'hanmeimei', 'xiaoming', 'zhangsan', 'lisi',
  'qianji', 'account', 'money', 'finance', 'bankcard', 'weixin', 'alipay',
  'zhongguo', 'tiantian', 'woainima', 'buzhidao', 'meiyou', 'nihao',
  'test123', 'test1234', 'demo1234', 'temp1234', 'changeme', 'secret',
  'meiyoumima', '123123', '112233', '123321', '654321', '666888', '88888888',
])

/** 键盘相邻序列，用来识别 qwerty / asdf 这类「看着长其实没熵」的串 */
const KEYBOARD_RUNS = [
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm',
  'qwerty', 'asdfgh', 'zxcvbn',
  '1234567890', '12345678', '1234567', '123456', '654321', '987654',
  'abcdefghijklmnopqrstuvwxyz', 'abcdefgh', 'abcdefg', 'abcdef', 'abcde', 'abcd',
  '111111', '000000', 'aaaaaa', 'ssssss',
]

export interface PasswordIssue {
  /** 稳定的机器可读标识，测试用 */
  code: string
  /** 给用户看的话 */
  message: string
}

export interface PasswordAssessment {
  /** 估算熵（bit），已计入模式惩罚 */
  bits: number
  level: 'too-short' | 'weak' | 'fair' | 'strong'
  issues: PasswordIssue[]
  /** 是否允许用这个密码 */
  acceptable: boolean
}

/** 字符集大小估算。中文一个字的信息量远大于一个 ASCII 字符，不能按 26 算。 */
function charsetSize(password: string): number {
  let size = 0
  if (/[a-z]/.test(password)) size += 26
  if (/[A-Z]/.test(password)) size += 26
  if (/[0-9]/.test(password)) size += 10
  // 除字母数字外的可打印 ASCII：空格、标点、符号
  if (/[^\p{L}\p{N}]/u.test(password)) size += 33
  // CJK 统一表意文字：按常用字量级估
  if (/[\u4e00-\u9fff]/.test(password)) size += 3500
  return Math.max(size, 2)
}

/** 是否存在 4 连以上的升/降序连续字符 */
function hasSequentialRun(lower: string): boolean {
  const isSeq = (a: number, b: number, c: number): boolean =>
    (b - a === 1 && c - b === 1) || (a - b === 1 && b - c === 1)
  for (let i = 0; i + 2 < lower.length; i++) {
    if (isSeq(lower.charCodeAt(i), lower.charCodeAt(i + 1), lower.charCodeAt(i + 2))) return true
  }
  return false
}

/** 同一字符连续出现 3 次以上 */
function hasRepeatRun(lower: string): boolean {
  for (let i = 0; i + 2 < lower.length; i++) {
    if (lower[i] === lower[i + 1] && lower[i + 1] === lower[i + 2]) return true
  }
  return false
}

/** 4 位年份，如 1998 / 2026 —— 生日和纪念日密码的标志 */
function hasYearToken(password: string): boolean {
  return /(19|20)\d{2}/.test(password)
}

/**
 * 完整 8 位日期，形如 20260922 / 19980922。
 * 这类密码看起来「有 8 位数字」，实际搜索空间只有几万个日期。
 */
function hasDateToken(password: string): boolean {
  return /(19|20)\d{6}/.test(password)
}

export function assessPassword(password: string): PasswordAssessment {
  const issues: PasswordIssue[] = []
  const lower = password.toLowerCase()
  const length = [...password].length

  if (length < MIN_PASSWORD_LENGTH) {
    issues.push({
      code: 'too-short',
      message: `至少 ${MIN_PASSWORD_LENGTH} 位。长度是最管用的，不是花色。`,
    })
  }

  if (COMMON_PASSWORDS.has(lower)) {
    issues.push({ code: 'common', message: '这是被泄露字典里排最前面的那批密码，一定会被优先猜到。' })
  }

  if (new Set(password).size < 4) {
    issues.push({ code: 'low-variety', message: '整串只用了一两个字符来回重复。' })
  }

  // 命中常见词做子串也要拦：`iloveyou2026` 不是安全密码，只是给弱词加了个尾缀
  const hitWord = [...COMMON_PASSWORDS].find((w) => w.length >= 6 && lower.includes(w))
  if (hitWord && !COMMON_PASSWORDS.has(lower)) {
    issues.push({
      code: 'contains-common-word',
      message: `里面有「${hitWord}」这种一看就猜的词根，后面加数字并不能把它救回来。`,
    })
  }

  if (/^\d+$/.test(password)) {
    issues.push({ code: 'all-digits', message: '纯数字。八位纯数字的搜索空间比你想的小几个数量级。' })
  }

  let bits = length * Math.log2(charsetSize(password))

  if (hasDateToken(password)) {
    bits *= 0.4
    issues.push({ code: 'date-like', message: '看起来是某个完整日期（生日/纪念日）。这类密码的攻击者会拿日历穷举。' })
  } else if (hasYearToken(password)) {
    bits *= 0.75
    issues.push({ code: 'year-token', message: '含 4 位年份。如果那是你自己或家人的年份，它基本等于公开信息。' })
  }

  if (KEYBOARD_RUNS.some((run) => lower.includes(run)) || hasSequentialRun(lower)) {
    bits *= 0.55
    issues.push({ code: 'keyboard-run', message: '含键盘相邻键或连续字符（如 qwerty / 1234 / abcd），这部分几乎不贡献熵。' })
  }

  if (hasRepeatRun(lower)) {
    bits *= 0.8
    issues.push({ code: 'repeat-run', message: '有字符连续重复三次以上，浪费了长度。' })
  }

  bits = Math.round(bits)

  const hardFail = issues.some((i) =>
    ['too-short', 'common', 'low-variety', 'contains-common-word', 'all-digits', 'date-like'].includes(i.code),
  )
  const acceptable = !hardFail && bits >= MIN_ACCEPTABLE_BITS

  const level: PasswordAssessment['level'] =
    !acceptable && length < MIN_PASSWORD_LENGTH
      ? 'too-short'
      : !acceptable
        ? 'weak'
        : bits >= 75
          ? 'strong'
          : 'fair'

  return { bits, level, issues, acceptable }
}

/**
 * 生成一条随机强密码建议（密码管理器之外的兜底方案）。
 * 用 4 个无规律短词拼接 —— 比 `Xk9#mQ2$` 更好记，熵却更高。
 */
export function suggestPassword(): string {
  const words = [
    'lamp', 'river', 'frost', 'maple', 'otter', 'velvet', 'garnet', 'willow',
    'ember', 'quartz', 'sable', 'thistle', 'walnut', 'harbor', 'nimbus', 'plume',
    'cobalt', 'dune', 'fern', 'glacier', 'heron', 'ivory', 'juniper', 'kelp',
    'lotus', 'marsh', 'nettle', 'onyx', 'pebble', 'raven', 'sorrel', 'timber',
  ]
  const digits = ['3', '7', '9', '2']
  const symbols = ['-', '.', '_', '+']
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
  const parts = [pick(words), pick(words), pick(words), pick(words)]
  parts[Math.floor(Math.random() * 4)] += pick(digits)
  return parts.join(pick(symbols))
}
