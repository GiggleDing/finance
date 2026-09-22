import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 生产构建注入的 CSP。
 *
 * 为什么这件事值得单独做：这个站点的威胁模型里，「同源脚本被注入」等于
 * 「数据全部失守」—— 内存里就有一把能解开整个保险箱的钥匙。而内容安全策略是
 * 目前唯一能在浏览器层面把「不该执行的脚本」按住的机制，纯静态站点只能靠它。
 *
 * `style-src` 必须放行 'unsafe-inline'：React 的 style={{}} 和 ECharts 都会写
 * 行内样式属性，禁掉就没有图表了。样式注入的危险等级远低于脚本注入，这个妥协是划算的。
 *
 * 不写 frame-ancestors —— 它只能通过 HTTP 响应头生效，写在 meta 里浏览器直接忽略，
 * 写上去只会让人误以为已经防住了点击劫持。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/**
 * 只在 build 时注入 CSP。
 * 开发模式下 Vite 的 HMR 客户端依赖内联脚本和 websocket，硬塞严格 CSP 会让
 * `npm run dev` 白屏，然后大概率有人为了「先让它跑起来」去放宽策略，
 * 最后线上也跟着放宽。把两件事分开，比事后打补丁可靠。
 */
function cspPlugin() {
  return {
    name: 'inject-csp',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      )
    },
  }
}

export default defineConfig(({ command }) => ({
  plugins: [react(), cspPlugin()],
  // GitHub Pages 部署：用相对路径，避免仓库名 / 自定义域名导致资源 404
  base: './',
  // 生产构建剥掉 console/debugger。财务数据不该有机会从日志里漏出去。
  esbuild: command === 'build' ? { drop: ['console', 'debugger'] } : {},
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1600,
    // 开 sourcemap 等于把源码（含注释里的设计说明）一并发布到公开站点
    sourcemap: false,
  },
}))
