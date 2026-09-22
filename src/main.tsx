import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { boot } from './core/session'
import './index.css'

/**
 * 启动时先问一次保险箱的状态，再渲染。
 *
 * 刻意不放在 App 的 useEffect 里：那样会先渲染一帧「没有数据」的空界面，
 * 再切到锁屏 —— 对财务应用来说，闪一下未授权的内容比慢半秒更糟。
 * boot() 只读 IndexedDB 和会话存储，不涉及密码学，所以它很快。
 */
void boot()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
