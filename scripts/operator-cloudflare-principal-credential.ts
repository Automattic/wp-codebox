import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PRINCIPAL_CREDENTIAL_SCHEMA, validatePrincipalCredentialVersion, type PrincipalCredentialVersion } from "../packages/runtime-cloudflare/src/principal-credential-repository.js"

class OperatorError extends Error {}

const args = process.argv.slice(2)
const action = args.shift()
if (action !== "issue" && action !== "revoke") fail("The action must be issue or revoke.")

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
if (!config || !credentialId || !version || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(databaseName) || !/^[A-Z][A-Z0-9_]*$/.test(databaseBinding) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiTokenEnv) || (persistTo && !local) || (!local && (!accountId || !/^[a-f0-9]{32}$/.test(accountId)))) fail("The credential operator arguments are invalid.")
if (!local && flags.has("--wrangler")) fail("Remote credential operations use the D1 API directly.")
if (action === "revoke" && ["--principal", "--scopes", "--expires-at", "--max-sites", "--sites"].some((name) => flags.has(name))) fail("Revocation accepts only credential identity arguments.")

const bearer = await readStdin()
let credential: PrincipalCredentialVersion | undefined
if (action === "issue") {
  const principal = flags.get("--principal")
  const expiresAt = flags.get("--expires-at")
  const maxSites = Number(flags.get("--max-sites"))
  const scopes = list(flags.get("--scopes"))
  const sites = flags.has("--sites") ? list(flags.get("--sites")) : undefined
  if (!principal || !expiresAt || !bearer) fail("Issuing a credential requires policy arguments and a bearer on stdin.")
  credential = { credentialId, version, principal, scopes, expiresAt, maxSites, ...(sites ? { sites } : {}), digest: createHash("sha256").update(bearer).digest("hex") }
  validatePrincipalCredentialVersion(credential)
} else if (bearer.length) fail("Revocation does not accept stdin.")

const now = Date.now()
const queries = action === "issue" ? issueQueries(credential!, now) : revokeQueries(credentialId, version, now)
const marker = await execute(queries)
if (action === "issue" && marker !== "issued") fail("Credential issuance conflicted with existing durable state.")
if (action === "revoke" && marker !== "revoked" && marker !== "unchanged") fail("Credential revocation returned invalid durable state.")

process.stdout.write(`${JSON.stringify({
  schema: "wp-codebox/principal-credential-operator/v1",
  action: marker,
  credential: action === "issue" ? { credentialId, version, principal: credential!.principal, scopes: credential!.scopes, expiresAt: credential!.expiresAt, maxSites: credential!.maxSites, ...(credential!.sites ? { sites: credential!.sites } : {}) } : { credentialId, version },
})}\n`)

interface Query { sql: string; params: Array<string | number | null> }

async function execute(queries: Query[]): Promise<string> {
  if (!local) return executeRemote(queries)
  const directory = await mkdtemp(join(tmpdir(), "wp-codebox-credential-"))
  const sqlFile = join(directory, "mutation.sql")
  try {
    await writeFile(sqlFile, transaction(queries), { mode: 0o600 })
    const command = ["d1", "execute", databaseName, "--local", "--config", resolve(config!), "--file", sqlFile, "--json", "--yes"]
    if (persistTo) command.push("--persist-to", resolve(persistTo))
    const output = await run(command)
    const parsed = JSON.parse(output) as unknown
    const marker = findMarker(parsed)
    if (!marker) fail("Wrangler returned invalid credential operator evidence.")
    return marker
  } catch (error) {
    if (error instanceof OperatorError) throw error
    fail("The durable credential operation failed.")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function executeRemote(queries: Query[]): Promise<string> {
  try {
    const parsed = parseJsonc(await readFile(resolve(config!), "utf8"))
    const database = parsed.d1_databases?.find((candidate) => candidate.binding === databaseBinding && candidate.database_name === databaseName)
    const databaseId = database?.database_id
    const apiToken = process.env[apiTokenEnv]
    if (typeof databaseId !== "string" || !/^[a-f0-9-]{36}$/.test(databaseId) || !apiToken) fail("The remote D1 target or authentication is invalid.")
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ batch: queries }),
    })
    const output = await response.json() as unknown
    if (!response.ok || !batchSucceeded(output, queries.length)) fail("The durable credential operation failed.")
    const marker = findMarker(output)
    if (!marker) fail("The D1 API returned invalid credential operator evidence.")
    return marker
  } catch (error) {
    if (error instanceof OperatorError) throw error
    fail("The durable credential operation failed.")
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
    if (!allowed.has(name) || output.has(name)) fail("The credential operator arguments are invalid.")
    if (booleans.has(name)) output.set(name, "true")
    else {
      const value = values[++index]
      if (!value || value.startsWith("--")) fail("The credential operator arguments are invalid.")
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
    if (bytes > 4_096) fail("Credential stdin is invalid.")
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function run(command: string[]): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(wrangler, command, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.on("error", reject)
    child.on("exit", (code) => code === 0 ? resolveRun(stdout) : reject(new Error(`Wrangler failed with status ${code}.`)))
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

function fail(message: string): never { throw new OperatorError(message) }
