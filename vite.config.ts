import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * 仅构建时注入 CSP meta（dev 模式不注入：plugin-react 的内联 preamble 会被
 * script-src 'self' 拦截，且开发期无需此防线）。生产产物（Electron file://
 * 与 WebUI 静态托管）都从 dist/index.html 获得完整 CSP 纵深防御。
 */
const injectCsp = (): Plugin => ({
  name: 'inject-csp-meta',
  apply: 'build',
  transformIndexHtml() {
    return [
      {
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content:
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' http: https: ws: wss:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'",
        },
        injectTo: 'head',
      },
    ]
  },
})

export default defineConfig({
  plugins: [react(), injectCsp()],
  base: './',
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@electron': resolve(__dirname, 'electron'),
    },
  },
  server: {
    // 开发服务器只供本机 Electron/WebUI 代理访问，避免暴露给局域网后
    // 触发 Vite/esbuild 的跨站请求风险；生产 WebUI 仍由独立服务控制 LAN 绑定。
    host: '127.0.0.1',
    allowedHosts: ['localhost', '127.0.0.1'],
    port: 5175,
    // release-out 是 electron-builder 的产物目录：dev 服务器若监听它，其目录
    // 句柄会阻止 electron-builder 解压后的 win-unpacked.tmp 重命名（EPERM），
    // 导致 dev 运行期间打包必然失败。产物无需热更新，直接排除。
    watch: {
      ignored: ['**/release-out/**'],
    },
  },
})
