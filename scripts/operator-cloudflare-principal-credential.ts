import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PRINCIPAL_CREDENTIAL_SCHEMA, validatePrincipalCredentialVersion, type PrincipalCredentialVersion } from "../packages/runtime-cloudflare/src/principal-credential-repository.js"

class OperatorError extends Error { constructor(message: string, readonly code = "operation-failed") { super(message) } }
class ProviderError extends Error { constructor(readonly output: string) { super("Provider operation failed.") } }
const PROVIDER_OUTPUT_LIMIT = 16_384
const PROVIDER_TIMEOUT_MS = 30_000

main().catch((error) => {
  const code = error instanceof OperatorError ? error.code : "operation-failed"
  process.stderr.write(`${JSON.stringify({ schema: "wp-codebox/principal-credential-operator-error/v1", code })}\n`)
  process.exitCode = 1
})

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const action = args.shift()
  if (action !== "issue" && action !== "revoke") fail("The action must be issue or revoke.", "invalid-request")
  const flags = parseFlags(args)
  const databaseName = flags.get("--database-name") ?? "wp-codebox-runtime-state"
  const config = flags.get("--config")
  const credentialId = flags.get("--credential-id")
  const version = flags.get("--version")
  const wrangler = resolve(flags.get("--wrangler") ?? "node_modules/.bin/wrangler")
  const local = flags.has("--local")
  const persistTo = flags.get("--persist-to")
  const accountId = flags.get("--account-id")
  const apiTokenEnv = flags.get("--api-token-env") ?? "CLOUDFLARE_API_TOKEN"
  const databaseBinding = flags.get("--database-binding") ?? "WORDPRESS_STATE_DATABASE"
  if (!config || !credentialId || !version || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(databaseName) || !/^[A-Z][A-Z0-9_]*$/.test(databaseBinding) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiTokenEnv) || (persistTo && !local) || (!local && (!accountId || !/^[a-f0-9]{32}$/.test(accountId)))) fail("The credential operator arguments are invalid.", "invalid-request")
  if (!local && flags.has("--wrangler")) fail("Remote credential operations use the D1 API directly.", "invalid-request")
  if (action === "revoke" && ["--principal", "--scopes", "--expires-at", "--max-sites", "--sites"].some((name) => flags.has(name))) fail("Revocation accepts only credential identity arguments.", "invalid-request")
  const bearer = await readStdin()
  let credential: PrincipalCredentialVersion | undefined
  if (action === "issue") {
    const principal = flags.get("--principal")
    const expiresAt = flags.get("--expires-at")
    const maxSites = Number(flags.get("--max-sites"))
    const scopes = list(flags.get("--scopes"))
    const sites = flags.has("--sites") ? list(flags.get("--sites")) : undefined
    if (!principal || !expiresAt || !bearer) fail("Issuing a credential requires policy arguments and a bearer on stdin.", "invalid-request")
    credential = { credentialId, version, principal, scopes, expiresAt, maxSites, ...(sites ? { sites } : {}), digest: createHash("sha256").update(bearer).digest("hex") }
    try { validatePrincipalCredentialVersion(credential) } catch { fail("Credential policy is invalid.", "invalid-request") }
  } else if (bearer.length) fail("Revocation does not accept stdin.", "invalid-request")
  const now = Date.now()
  const queries = action === "issue" ? issueQueries(credential!, now) : revokeQueries(credentialId, version, now)
  const marker = await execute(queries, { local, config, databaseName, persistTo, wrangler, databaseBinding, accountId, apiTokenEnv })
  if (action === "issue" && marker !== "issued") fail("Credential issuance conflicted with existing durable state.", "version-policy-conflict")
  if (action === "revoke" && marker !== "revoked" && marker !== "unchanged") fail("Credential revocation returned invalid durable state.")
  process.stdout.write(`${JSON.stringify({ schema: "wp-codebox/principal-credential-operator/v1", action: marker, credential: action === "issue" ? { credentialId, version, principal: credential!.principal, scopes: credential!.scopes, expiresAt: credential!.expiresAt, maxSites: credential!.maxSites, ...(credential!.sites ? { sites: credential!.sites } : {}) } : { credentialId, version } })}\n`)
}

interface Query { sql: string; params: Array<string | number | null> }

async function execute(queries: Query[], options: { local: boolean; config: string; databaseName: string; persistTo?: string; wrangler: string; databaseBinding: string; accountId?: string; apiTokenEnv: string }): Promise<string> {
  if (!options.local) return executeRemote(queries, options)
  const directory = await mkdtemp(join(tmpdir(), "wp-codebox-credential-"))
  const sqlFile = join(directory, "mutation.sql")
  try {
    await writeFile(sqlFile, transaction(queries), { mode: 0o600 })
    const command = ["d1", "execute", options.databaseName, "--local", "--config", resolve(options.config), "--file", sqlFile, "--json", "--yes"]
    if (options.persistTo) command.push("--persist-to", resolve(options.persistTo))
    const output = await run(options.wrangler, command)
    const parsed = JSON.parse(output.stdout) as unknown
    const marker = findMarker(parsed)
    if (!marker) fail("Wrangler returned invalid credential operator evidence.")
    return marker
  } catch (error) {
    if (error instanceof OperatorError) throw error
    fail("The durable credential operation failed.", conflictCode(error))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function executeRemote(queries: Query[], options: { config: string; databaseName: string; databaseBinding: string; accountId?: string; apiTokenEnv: string }): Promise<string> {
  try {
    const parsed = parseJsonc(await readFile(resolve(options.config), "utf8"))
    const database = parsed.d1_databases?.find((candidate) => candidate.binding === options.databaseBinding && candidate.database_name === options.databaseName)
    const databaseId = database?.database_id
    const apiToken = process.env[options.apiTokenEnv]
    if (typeof databaseId !== "string" || !/^[a-f0-9-]{36}$/.test(databaseId) || !apiToken) fail("The remote D1 target or authentication is invalid.", "invalid-request")
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/d1/database/${databaseId}/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ batch: queries }),
    })
    const output = await response.json() as unknown
    if (!response.ok || !batchSucceeded(output, queries.length)) fail("The durable credential operation failed.", conflictCode(output))
    const marker = findMarker(output)
    if (!marker) fail("The D1 API returned invalid credential operator evidence.")
    return marker
  } catch (error) {
    if (error instanceof OperatorError) throw error
    fail("The durable credential operation failed.", conflictCode(error))
  }
}

function issueQueries(input: PrincipalCredentialVersion, now: number): Query[] {
  const scopes = JSON.stringify(input.scopes)
  const sites = input.sites ? JSON.stringify(input.sites) : null
  return [
    ...PRINCIPAL_CREDENTIAL_SCHEMA.map((sql) => ({ sql, params: [] })),
    { sql: "INSERT INTO wp_codebox_principal_credentials (credential_id, version, digest, principal, scopes, expires_at, max_sites, sites, revoked_at, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM wp_codebox_principal_credentials WHERE credential_id=? AND version=?)", params: [input.credentialId, input.version, input.digest, input.principal, scopes, Date.parse(input.expiresAt), input.maxSites, sites, now, input.credentialId, input.version] },
    { sql: "INSERT INTO wp_codebox_principal_credential_audit (at, kind, principal, credential_id, version, reason, dedupe_key) SELECT ?, 'registered', ?, ?, ?, 'ok', NULL WHERE changes() = 1", params: [now, input.principal, input.credentialId, input.version] },
    { sql: "DELETE FROM wp_codebox_principal_credential_audit WHERE id IN (SELECT id FROM wp_codebox_principal_credential_audit ORDER BY id DESC LIMIT -1 OFFSET 10000)", params: [] },
    { sql: "SELECT CASE WHEN EXISTS (SELECT 1 FROM wp_codebox_principal_credentials WHERE credential_id=? AND version=? AND digest=? AND principal=? AND scopes=? AND expires_at=? AND max_sites=? AND sites IS ?) THEN 'issued' ELSE 'conflict' END AS wp_codebox_operator_result", params: [input.credentialId, input.version, input.digest, input.principal, scopes, Date.parse(input.expiresAt), input.maxSites, sites] },
  ]
}

function revokeQueries(credentialId: string, version: string, now: number): Query[] {
  const dedupeKey = `operator-revoked:${randomUUID()}`
  return [
    ...PRINCIPAL_CREDENTIAL_SCHEMA.map((sql) => ({ sql, params: [] })),
    { sql: "INSERT OR IGNORE INTO wp_codebox_principal_credential_audit (at, kind, principal, credential_id, version, reason, dedupe_key) SELECT ?, 'revoked', principal, credential_id, version, 'ok', ? FROM wp_codebox_principal_credentials WHERE credential_id=? AND version=? AND revoked_at IS NULL", params: [now, dedupeKey, credentialId, version] },
    { sql: "UPDATE wp_codebox_principal_credentials SET revoked_at=? WHERE credential_id=? AND version=? AND revoked_at IS NULL", params: [now, credentialId, version] },
    { sql: "DELETE FROM wp_codebox_principal_credential_audit WHERE id IN (SELECT id FROM wp_codebox_principal_credential_audit ORDER BY id DESC LIMIT -1 OFFSET 10000)", params: [] },
    { sql: "SELECT CASE WHEN EXISTS (SELECT 1 FROM wp_codebox_principal_credential_audit WHERE dedupe_key=? AND at=?) THEN 'revoked' ELSE 'unchanged' END AS wp_codebox_operator_result", params: [dedupeKey, now] },
  ]
}

function transaction(queries: Query[]): string { return `BEGIN TRANSACTION;\n${queries.map(({ sql, params }) => `${bind(sql, params)};`).join("\n")}\nCOMMIT;\n` }
function bind(sql: string, params: Query["params"]): string { let index = 0; const output = sql.replaceAll("?", () => literal(params[index++])); if (index !== params.length) fail("Credential SQL parameters are invalid."); return output }
function literal(value: string | number | null): string { return value === null ? "NULL" : typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'` }
function list(value: string | undefined): string[] { return value ? value.split(",") : [] }

function parseFlags(values: string[]): Map<string, string> {
  const booleans = new Set(["--local"])
  const allowed = new Set(["--database-name", "--database-binding", "--config", "--credential-id", "--version", "--wrangler", "--persist-to", "--account-id", "--api-token-env", "--principal", "--scopes", "--expires-at", "--max-sites", "--sites", ...booleans])
  const output = new Map<string, string>()
  for (let index = 0; index < values.length; index++) {
    const name = values[index]
    if (!allowed.has(name) || output.has(name)) fail("The credential operator arguments are invalid.", "invalid-request")
    if (booleans.has(name)) output.set(name, "true")
    else {
      const value = values[++index]
      if (!value || value.startsWith("--")) fail("The credential operator arguments are invalid.", "invalid-request")
      output.set(name, value)
    }
  }
  return output
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > 4_096) fail("Credential stdin is invalid.", "invalid-request")
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function run(wrangler: string, command: string[]): Promise<{ stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(wrangler, command, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let terminated = false
    let killTimer: NodeJS.Timeout | undefined
    const terminate = () => { if (terminated) return; terminated = true; child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000) }
    const append = (target: "stdout" | "stderr", chunk: Buffer) => { const current = target === "stdout" ? stdout : stderr; const remaining = PROVIDER_OUTPUT_LIMIT - current.byteLength; if (chunk.byteLength > remaining) terminate(); const next = Buffer.concat([current, chunk.subarray(0, Math.max(0, remaining))]); if (target === "stdout") stdout = next; else stderr = next }
    child.stdout.on("data", (chunk) => { append("stdout", Buffer.from(chunk)) })
    child.stderr.on("data", (chunk) => { append("stderr", Buffer.from(chunk)) })
    const timeout = setTimeout(terminate, PROVIDER_TIMEOUT_MS)
    child.on("error", reject)
    child.on("close", (code) => { clearTimeout(timeout); clearTimeout(killTimer); const output = stdout.toString("utf8"); if (code === 0 && !terminated) resolveRun({ stdout: output }); else reject(new ProviderError(`${stderr.subarray(0, 2_048).toString("utf8")}\n${stdout.subarray(0, 2_048).toString("utf8")}`)) })
  })
}

function findMarker(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  if ("wp_codebox_operator_result" in value && typeof value.wp_codebox_operator_result === "string") return value.wp_codebox_operator_result
  for (const child of Array.isArray(value) ? value : Object.values(value)) { const marker = findMarker(child); if (marker) return marker }
  return undefined
}

function batchSucceeded(value: unknown, count: number): boolean {
  if (!value || typeof value !== "object" || !("success" in value) || value.success !== true || !("result" in value) || !Array.isArray(value.result) || value.result.length !== count) return false
  return value.result.every((result) => result && typeof result === "object" && "success" in result && result.success === true)
}

function parseJsonc(value: string): { d1_databases?: Array<Record<string, unknown>> } {
  return JSON.parse(value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1"))
}

function boundedStrings(value: unknown, depth = 0, output: string[] = []): string[] { if (depth > 8 || output.length >= 32) return output; if (typeof value === "string") output.push(value.slice(0, 512)); else if (Array.isArray(value)) value.slice(0, 32).forEach((item) => boundedStrings(item, depth + 1, output)); else if (value && typeof value === "object") Object.values(value).slice(0, 32).forEach((item) => boundedStrings(item, depth + 1, output)); return output }
function conflictCode(value: unknown): string {
  const digestConflict = /UNIQUE constraint failed:\s*wp_codebox_principal_credentials\.digest/i
  if (value instanceof ProviderError) return digestConflict.test(value.output) ? "duplicate-digest-conflict" : "operation-failed"
  if (!value || typeof value !== "object" || !("result" in value) || !Array.isArray(value.result) || value.result[2]?.success !== false) return "operation-failed"
  return boundedStrings(value.result[2]?.errors).some((text) => digestConflict.test(text)) ? "duplicate-digest-conflict" : "operation-failed"
}
function fail(message: string, code?: string): never { throw new OperatorError(message, code) }
