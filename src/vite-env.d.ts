declare module '*.css'
declare module '*.png'
declare module '*.mjs?url' {
  const src: string
  export default src
}
