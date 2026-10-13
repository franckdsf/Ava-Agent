/**
 * Hostname without `www.`, lowercased, or null when the string isn't a URL.
 *
 * **Strict:** a bare `example.com` is not a URL and returns null. A caller that
 * holds one — `feed-finder`, whose domains come from the reader — adds the scheme
 * itself, so this function means the same thing everywhere it is called.
 *
 * Not `normalizeHost` in `services/lead-identity.ts`, which reduces a host to the
 * company that owns it; this keeps the host as given.
 */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}
