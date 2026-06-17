export interface TrustedBrowserSessionOrigin {
  schema: "wp-codebox/trusted-browser-session-origin/v1"
  origin: string
  secure: boolean
  loopback: boolean
}

export function trustedBrowserSessionOrigin(input: string | URL): TrustedBrowserSessionOrigin {
  const url = typeof input === "string" ? new URL(input) : input
  const hostname = url.hostname.toLowerCase()
  const loopback = isLoopbackHost(hostname)
  const secure = url.protocol === "https:" || (url.protocol === "http:" && loopback)
  if (!secure) {
    throw new Error("Trusted browser session origins must use https:// unless the host is loopback")
  }

  return {
    schema: "wp-codebox/trusted-browser-session-origin/v1",
    origin: url.origin,
    secure,
    loopback,
  }
}

export function trustedBrowserSessionOrigins(inputs: Array<string | URL>): TrustedBrowserSessionOrigin[] {
  const byOrigin = new Map<string, TrustedBrowserSessionOrigin>()
  for (const input of inputs) {
    const origin = trustedBrowserSessionOrigin(input)
    byOrigin.set(origin.origin, origin)
  }
  return [...byOrigin.values()]
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}
