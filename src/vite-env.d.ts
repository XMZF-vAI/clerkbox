/** 由 vite.config.ts 的 injectAppVersion 插件从 package.json.version 注入（About 页版本显示） */
declare const __APP_VERSION__: string

declare module '*.css'
declare module '*.png'
declare module '*.svg'
declare module '*.mjs?url' {
  const src: string
  export default src
}
