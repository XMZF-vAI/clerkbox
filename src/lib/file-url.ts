/** Convert an absolute local path to a browser-safe file URL. */
export function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const encodePath = (value: string) => value
    .split('/')
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')

  // UNC paths use the first segment as the file URL host.
  if (normalized.startsWith('//')) {
    const [, , host, ...segments] = normalized.split('/')
    if (host) return `file://${encodeURIComponent(host)}/${segments.map(encodeURIComponent).join('/')}`
  }

  const encodedPath = encodePath(normalized)
  return normalized.startsWith('/') ? `file://${encodedPath}` : `file:///${encodedPath}`
}
