import { describe, expect, it } from 'vitest'
import { normalizeAddressInput } from '../src/components/workbench/BrowserPanel'

describe('workbench browser address input', () => {
  it('opens a common local development address instead of searching for it', () => {
    expect(normalizeAddressInput(' localhost:5175/settings ')).toBe('http://localhost:5175/settings')
    expect(normalizeAddressInput('localhost')).toBe('http://localhost/')
  })

  it('preserves explicit secure and local URLs', () => {
    expect(normalizeAddressInput('https://example.com/path?q=value')).toBe('https://example.com/path?q=value')
    expect(normalizeAddressInput('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/')
    expect(normalizeAddressInput('example.com/docs')).toBe('https://example.com/docs')
  })

  it('encodes search text without letting it become a navigation scheme', () => {
    expect(normalizeAddressInput('UI layout tips')).toBe('https://www.bing.com/search?q=UI%20layout%20tips')
    expect(normalizeAddressInput('file://C:/private.txt')).toBeNull()
    expect(normalizeAddressInput('ftp://example.com')).toBeNull()
    expect(normalizeAddressInput('   ')).toBeNull()
  })
})
