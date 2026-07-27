export interface AdministratorSecretBinding {
  version: string
  claimSecret: string
  password: string
}

export interface AdministratorSecretBindings {
  active: AdministratorSecretBinding
  byVersion(version: string): AdministratorSecretBinding | undefined
}

export interface AdministratorRootPin {
  version: string
  claimSecretDigest: string
  passwordDigest: string
}

export interface AdministratorSecretBindingEnv {
  WORDPRESS_ADMIN_SECRET_BINDINGS?: string
  WORDPRESS_ADMIN_CLAIM_SECRET?: string
  WORDPRESS_ADMIN_PASSWORD?: string
}

const MAX_CONFIGURATION_BYTES = 16 * 1024
const MAX_BINDINGS = 8
const VERSION = /^[A-Za-z0-9._-]{1,64}$/

/** Parses managed bindings or adapts the legacy pair as the single `legacy` version. */
export function parseAdministratorSecretBindings(env: AdministratorSecretBindingEnv): AdministratorSecretBindings {
  const configured = env.WORDPRESS_ADMIN_SECRET_BINDINGS
  if (configured === undefined) return bindings([legacyBinding(env)], "legacy")
  if (env.WORDPRESS_ADMIN_CLAIM_SECRET !== undefined || env.WORDPRESS_ADMIN_PASSWORD !== undefined) throw new Error("Administrator secret bindings are invalid.")
  if (typeof configured !== "string" || new TextEncoder().encode(configured).byteLength > MAX_CONFIGURATION_BYTES) throw new Error("Administrator secret bindings are invalid.")
  let value: unknown
  try { value = JSON.parse(configured) } catch { throw new Error("Administrator secret bindings are invalid.") }
  if (!record(value) || Object.keys(value).some((key) => key !== "activeVersion" && key !== "versions") || typeof value.activeVersion !== "string" || !Array.isArray(value.versions) || !value.versions.length || value.versions.length > MAX_BINDINGS) throw new Error("Administrator secret bindings are invalid.")
  const versions = value.versions.map(parseBinding)
  if (new Set(versions.map((binding) => binding.version)).size !== versions.length || !versions.some((binding) => binding.version === value.activeVersion)) throw new Error("Administrator secret bindings are invalid.")
  return bindings(versions, value.activeVersion)
}

export async function pinAdministratorSecretBinding(binding: AdministratorSecretBinding): Promise<AdministratorRootPin> {
  return { version: binding.version, claimSecretDigest: await digest(binding.claimSecret), passwordDigest: await keyedDigest(binding.claimSecret, binding.password) }
}

export async function resolvePinnedAdministratorSecretBinding(bindings: AdministratorSecretBindings, pin: AdministratorRootPin | null): Promise<AdministratorSecretBinding | null> {
  if (!pin) return bindings.active
  const binding = bindings.byVersion(pin.version)
  if (!binding || !await equal(await digest(binding.claimSecret), pin.claimSecretDigest) || !await equal(await keyedDigest(binding.claimSecret, binding.password), pin.passwordDigest)) return null
  return binding
}

async function digest(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>)), (byte) => byte.toString(16).padStart(2, "0")).join("") }
async function keyedDigest(keyValue: string, value: string): Promise<string> { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyValue), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("") }
async function equal(left: string, right: string): Promise<boolean> { if (left.length !== right.length) return false; let result = 0; for (let i = 0; i < left.length; i++) result |= left.charCodeAt(i) ^ right.charCodeAt(i); return result === 0 }
function bindings(values: AdministratorSecretBinding[], activeVersion: string): AdministratorSecretBindings { const byVersion = new Map(values.map((value) => [value.version, Object.freeze(value)])); return Object.freeze({ active: byVersion.get(activeVersion)!, byVersion: (version: string) => byVersion.get(version) }) }
function legacyBinding(env: AdministratorSecretBindingEnv): AdministratorSecretBinding { return validBinding({ version: "legacy", claimSecret: env.WORDPRESS_ADMIN_CLAIM_SECRET, password: env.WORDPRESS_ADMIN_PASSWORD }) ? { version: "legacy", claimSecret: env.WORDPRESS_ADMIN_CLAIM_SECRET!, password: env.WORDPRESS_ADMIN_PASSWORD! } : invalid() }
function parseBinding(value: unknown): AdministratorSecretBinding { if (!record(value) || Object.keys(value).some((key) => key !== "version" && key !== "claimSecret" && key !== "password") || !validBinding(value)) return invalid(); return { version: value.version, claimSecret: value.claimSecret, password: value.password } }
function validBinding(value: { version?: unknown; claimSecret?: unknown; password?: unknown }): value is AdministratorSecretBinding { return typeof value.version === "string" && VERSION.test(value.version) && typeof value.claimSecret === "string" && new TextEncoder().encode(value.claimSecret).byteLength >= 32 && typeof value.password === "string" && new TextEncoder().encode(value.password).byteLength > 0 }
function invalid(): never { throw new Error("Administrator secret bindings are invalid.") }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
