/**
 * shiki 语言包与主题的按需加载。
 *
 * Vite 会把 `@shikijs/langs/${name}` 展开成真实路径并按需分包 ——
 * 未被引用的语言不会进产物，因此这里用动态 import + 映射表。
 *
 * 动态 import 拿到的是**模块命名空间**（`{ default: ... }`），
 * shiki 要的是解包后的注册对象，所以每个 loader 都要取 `.default`。
 */
type LangModule = { default: unknown }

/** 语言 id → 动态 import（新增语言只需加一行） */
const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  python: () => import('@shikijs/langs/python'),
  json: () => import('@shikijs/langs/json'),
  bash: () => import('@shikijs/langs/bash'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  sql: () => import('@shikijs/langs/sql'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  ruby: () => import('@shikijs/langs/ruby'),
  vue: () => import('@shikijs/langs/vue'),
  swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  php: () => import('@shikijs/langs/php'),
  r: () => import('@shikijs/langs/r'),
  lua: () => import('@shikijs/langs/lua'),
  perl: () => import('@shikijs/langs/perl'),
  scala: () => import('@shikijs/langs/scala'),
  haskell: () => import('@shikijs/langs/haskell'),
  elixir: () => import('@shikijs/langs/elixir'),
  erlang: () => import('@shikijs/langs/erlang'),
  clojure: () => import('@shikijs/langs/clojure'),
  zig: () => import('@shikijs/langs/zig'),
  dart: () => import('@shikijs/langs/dart'),
  groovy: () => import('@shikijs/langs/groovy'),
  'objective-c': () => import('@shikijs/langs/objective-c'),
  powershell: () => import('@shikijs/langs/powershell'),
  nginx: () => import('@shikijs/langs/nginx'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  graphql: () => import('@shikijs/langs/graphql'),
  prisma: () => import('@shikijs/langs/prisma'),
  svelte: () => import('@shikijs/langs/svelte'),
  solidity: () => import('@shikijs/langs/solidity'),
  terraform: () => import('@shikijs/langs/terraform'),
  hcl: () => import('@shikijs/langs/hcl'),
  makefile: () => import('@shikijs/langs/makefile'),
  cmake: () => import('@shikijs/langs/cmake'),
  vim: () => import('@shikijs/langs/vim'),
  latex: () => import('@shikijs/langs/latex'),
  wasm: () => import('@shikijs/langs/wasm'),
  matlab: () => import('@shikijs/langs/matlab'),
  julia: () => import('@shikijs/langs/julia'),
  fsharp: () => import('@shikijs/langs/fsharp'),
  vb: () => import('@shikijs/langs/vb'),
  asm: () => import('@shikijs/langs/asm'),
  batch: () => import('@shikijs/langs/batch'),
  ada: () => import('@shikijs/langs/ada'),
  prolog: () => import('@shikijs/langs/prolog'),
  lisp: () => import('@shikijs/langs/lisp'),
  scheme: () => import('@shikijs/langs/scheme'),
  ocaml: () => import('@shikijs/langs/ocaml'),
  nim: () => import('@shikijs/langs/nim'),
  crystal: () => import('@shikijs/langs/crystal'),
  d: () => import('@shikijs/langs/d'),
  purescript: () => import('@shikijs/langs/purescript'),
  elm: () => import('@shikijs/langs/elm'),
  coffeescript: () => import('@shikijs/langs/coffeescript'),
  stylus: () => import('@shikijs/langs/stylus'),
  less: () => import('@shikijs/langs/less'),
  scss: () => import('@shikijs/langs/scss'),
  sass: () => import('@shikijs/langs/sass'),
  postcss: () => import('@shikijs/langs/postcss'),
  protobuf: () => import('@shikijs/langs/protobuf'),
  wgsl: () => import('@shikijs/langs/wgsl'),
  glsl: () => import('@shikijs/langs/glsl'),
  hlsl: () => import('@shikijs/langs/hlsl'),
}

/** 加载一批核心语言（返回解包后的注册对象） */
export async function loadCoreLangs(langs: readonly string[]): Promise<unknown[]> {
  const loaders = langs.map((name) => LANG_LOADERS[name]).filter(Boolean)
  const mods = await Promise.all(loaders.map((load) => load()))
  return mods.map((m) => m.default)
}

/** 加载单个语言（核心集之外的语言按需补载）；不认识则返回 null */
export async function loadLang(lang: string): Promise<unknown | null> {
  const loader = LANG_LOADERS[lang]
  if (!loader) return null
  const mod = await loader()
  return mod.default
}

/** 语言 id 是否在可补载清单里 */
export function isKnownLang(lang: string): boolean {
  return lang in LANG_LOADERS
}

/** 加载双主题（亮 + 暗） */
export async function loadThemes(): Promise<unknown[]> {
  const [light, dark] = await Promise.all([
    import('@shikijs/themes/vitesse-light'),
    import('@shikijs/themes/vitesse-dark'),
  ])
  return [light.default, dark.default]
}
