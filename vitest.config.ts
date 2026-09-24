import { defineConfig } from 'vitest/config'

// 单元测试只覆盖纯逻辑（tests/ 目录），不碰 Electron 运行时与 DOM；
// 涉及 electron 模块的被测文件在测试内用 vi.mock 打桩。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
