export const WORDPRESS_AUTH_CONSTANTS = ["AUTH_KEY", "SECURE_AUTH_KEY", "LOGGED_IN_KEY", "NONCE_KEY", "AUTH_SALT", "SECURE_AUTH_SALT", "LOGGED_IN_SALT", "NONCE_SALT"] as const

export type WordPressAuthConstant = (typeof WORDPRESS_AUTH_CONSTANTS)[number]

export async function deriveWordPressAuthConstants(rootSecret: string, site: string): Promise<Record<WordPressAuthConstant, string>> {
  if (!rootSecret) throw new Error("WORDPRESS_AUTH_SECRET is required for canonical WordPress runtime boots.")
  const encoder = new TextEncoder()
  const entries = await Promise.all(WORDPRESS_AUTH_CONSTANTS.map(async (name) => {
    const input = encoder.encode(`wp-codebox/wordpress-auth/v1\0${site}\0${name}\0${rootSecret}`)
    const digest = await crypto.subtle.digest("SHA-256", input)
    return [name, Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")] as const
  }))
  return Object.fromEntries(entries) as Record<WordPressAuthConstant, string>
}
