// Same-session in-memory cache for image text extraction.
//
// The Rust handler also writes a disk cache at
// `<appData>/cache/image-text/<hash>__<supplier>__<model>.txt`, so this is
// strictly a perf optimisation: when a user re-drops the same image inside
// one session we skip even the bridge round-trip (~5 ms) and short-circuit
// in JS. Keyed by data-URL; sha-of-payload is computed Rust-side.

const cache = new Map<string, string>()

export function getCachedImageText(dataUrl: string): string | undefined {
  return cache.get(dataUrl)
}

export function setCachedImageText(dataUrl: string, text: string): void {
  // Cap the in-memory cache so a session full of attachments doesn't bloat
  // RAM. Disk cache covers the long tail.
  if (cache.size > 200) {
    const firstKey = cache.keys().next().value
    if (firstKey) cache.delete(firstKey)
  }
  cache.set(dataUrl, text)
}

export function clearImageTextCache(): void {
  cache.clear()
}
