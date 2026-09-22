/**
 * 剪贴板工具。
 *
 * 唯一值得写一个文件的原因是「用完自动擦」：恢复码复制到剪贴板之后，
 * 它会一直躺在系统剪贴板里 —— 任何应用、任何网页、任何同步服务
 * （iOS 通用剪贴板会把内容同步到同一账号的其它设备）都能读到它。
 * 对一个能重置主密码的字符串来说，这个暴露窗口不该无限期开着。
 *
 * 擦除前先回读确认内容没被你自己覆盖过，避免把用户后来复制的
 * 别的东西一起抹掉 —— 那是一种比泄漏更让人恼火的 bug。
 */
const CLEAR_DELAY_MS = 60_000

export async function copySensitive(text: string, clearAfterMs = CLEAR_DELAY_MS): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return false
  }

  window.setTimeout(() => {
    void (async () => {
      try {
        const current = await navigator.clipboard.readText()
        if (current === text) await navigator.clipboard.writeText('')
      } catch {
        // 没有读取权限（Firefox 默认不给）就干脆不动它 ——
        // 宁可少擦一次，也不能把用户后复制的内容误删
      }
    })()
  }, clearAfterMs)

  return true
}
