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
    host: '0.0.0.0',
    allowedHosts: true,
    port: 5175,
  },
})
