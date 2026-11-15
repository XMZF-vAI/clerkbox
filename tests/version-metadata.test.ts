import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageMetadata {
  name: string
  version: string
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata
const lockfile = JSON.parse(
  readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
) as PackageMetadata & { packages: Record<string, PackageMetadata> }

describe('application release metadata', () => {
  it('keeps the lockfile root project aligned with the application manifest', () => {
    expect(lockfile.name).toBe(manifest.name)
    expect(lockfile.version).toBe(manifest.version)
    expect(lockfile.packages[''].name).toBe(manifest.name)
    expect(lockfile.packages[''].version).toBe(manifest.version)
  })
})
