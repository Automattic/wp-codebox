import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const CONFIRMATION = "--confirm-remote-d1-gate"
const ACCOUNT_ID = /^[a-f0-9]{32}$/
const DATABASE_ID = /^[a-f0-9-]{36}$/
const EXPIRY = "2099-01-01T00:00:00.000Z"
const OUTPUT_LIMIT = 16_384
const CHILD_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 30_000

class AmbiguousCreateError extends Error {}

export async function runRemotePrincipalCredentialGate(input = {}) {
  const accountId = input.accountId
  const apiToken = input.apiToken ?? process.env.CLOUDFLARE_API_TOKEN
  if (input.confirmation !== true) throw new Error("The remote D1 credential gate requires --confirm-remote-d1-gate.")
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId) || typeof apiToken !== "string" || !apiToken) throw new Error("Remote D1 credential gate configuration is invalid.")
  const run = input.run ?? runChild
  const request = input.fetch ?? globalThis.fetch
  if (typeof request !== "function") throw new Error("Remote D1 credential gate configuration is invalid.")
  const runId = input.runId ?? randomUUID()
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId)) throw new Error("Remote D1 credential gate configuration is invalid.")

  const databaseName = `wp-codebox-2082-${runId}`
  const identitySuffix = runId.replaceAll("-", "").slice(0, 16)
  const resourceEndpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`
  const directory = await mkdtemp(join(tmpdir(), "wp-codebox-remote-d1-gate-"))
  const config = join(directory, "wrangler.json")
  const operator = resolve(input.operator ?? "scripts/operator-cloudflare-principal-credential.ts")
  let databaseId
  let primaryError
  let cleanupError
  let evidence

  try {
    databaseId = await createDatabase(request, resourceEndpoint, apiToken, databaseName)
    await writeConfig(config, { account_id: accountId, d1_databases: [{ binding: "WORDPRESS_STATE_DATABASE", database_name: databaseName, database_id: databaseId }] })
    const endpoint = `${resourceEndpoint}/${databaseId}/query`
    const credentialId = `gate-${identitySuffix}`
    const duplicateId = `duplicate-${identitySuffix}`
    const principal = `ci:remote-gate:${identitySuffix}`
    const policy = ["--principal", principal, "--scopes", "sites:create,sites:read", "--expires-at", EXPIRY, "--max-sites", "2"]
    const base = ["--config", config, "--database-name", databaseName, "--account-id", accountId, "--credential-id", credentialId]
    const bearerOne = randomBytes(32).toString("base64url")
    const bearerTwo = randomBytes(32).toString("base64url")
    const bearerThree = randomBytes(32).toString("base64url")

    await operatorAction(run, operator, "issue", [...base, "--version", "v1", ...policy], bearerOne, "issued")
    await operatorAction(run, operator, "issue", [...base, "--version", "v1", ...policy], bearerOne, "issued")
    await operatorFailure(run, operator, "issue", [...base, "--version", "v1", ...policy.slice(0, -1), "3"], bearerOne, "version-policy-conflict")
    const duplicateBase = [...base]
    duplicateBase[duplicateBase.indexOf("--credential-id") + 1] = duplicateId
    await operatorFailure(run, operator, "issue", [...duplicateBase, "--version", "v1", ...policy], bearerOne, "duplicate-digest-conflict")
    await operatorAction(run, operator, "issue", [...base, "--version", "v2", ...policy], bearerTwo, "issued")
    await operatorAction(run, operator, "revoke", [...base, "--version", "v1"], "", "revoked")
    await operatorAction(run, operator, "revoke", [...base, "--version", "v1"], "", "unchanged")
    await operatorAction(run, operator, "issue", [...base, "--version", "v3", ...policy], bearerThree, "issued")
    const concurrentActions = (await Promise.all([operatorResult(run, operator, "revoke", [...base, "--version", "v3"], ""), operatorResult(run, operator, "revoke", [...base, "--version", "v3"], "")])).map((result) => result.action).sort()
    if (concurrentActions.join(",") !== "revoked,unchanged") throw new Error("Remote D1 credential gate concurrent revocation did not converge.")

    const state = await batch(request, endpoint, apiToken, [
      { sql: "SELECT credential_id, version, principal, scopes, expires_at, max_sites, sites, revoked_at FROM wp_codebox_principal_credentials WHERE credential_id = ? ORDER BY version LIMIT ?", params: [credentialId, 4] },
      { sql: "SELECT credential_id, version FROM wp_codebox_principal_credentials WHERE credential_id = ? LIMIT ?", params: [duplicateId, 1] },
    ])
    const audits = await batch(request, endpoint, apiToken, [{ sql: "SELECT at, kind, principal, credential_id, version, reason FROM wp_codebox_principal_credential_audit WHERE credential_id = ? ORDER BY id LIMIT ?", params: [credentialId, 12] }])
    const stateRows = results(state)[0] ?? []
    const duplicateRows = results(state)[1] ?? []
    const auditRows = results(audits)[0] ?? []
    if (!validCredentialEvidence(stateRows, credentialId, principal) || duplicateRows.length !== 0 || !validAuditEvidence(auditRows, credentialId, principal)) throw new Error("Remote D1 credential gate durable evidence is invalid.")

    const rollbackId = `rollback-${identitySuffix}`
    const failed = await batch(request, endpoint, apiToken, rollbackQueries(rollbackId), false)
    if (!constraintFailure(failed)) throw new Error("Remote D1 credential gate rollback batch did not return a constraint failure.")
    const rollback = await batch(request, endpoint, apiToken, [{ sql: "SELECT credential_id, version FROM wp_codebox_principal_credentials WHERE credential_id = ? LIMIT ?", params: [rollbackId, 1] }])
    if ((results(rollback)[0] ?? []).length !== 0) throw new Error("Remote D1 credential gate rollback did not restore durable state.")
    evidence = Object.freeze({ schema: "wp-codebox/cloudflare-remote-principal-credential-gate/v1", status: "passed", evidence: { credentials: stateRows.length, auditEvents: auditRows.length, concurrentRevocation: concurrentActions, rollback: "passed" } })
  } catch (error) {
    primaryError = error
  } finally {
    if (databaseId) {
      try { await deleteDatabase(request, resourceEndpoint, apiToken, databaseId) } catch (error) { cleanupError = error }
    }
    try { await rm(directory, { recursive: true, force: true }) } catch (error) { cleanupError ??= error }
  }
  if (cleanupError && primaryError) throw new Error("Remote D1 credential gate failed and cleanup failed.")
  if (cleanupError) throw new Error("Remote D1 credential gate cleanup failed.")
  if (primaryError instanceof AmbiguousCreateError) throw primaryError
  if (primaryError) throw new Error("Remote D1 credential gate failed.")
  return evidence
}

async function createDatabase(request, endpoint, token, name) {
  let response
  try { response = await request(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }) } catch { throw new AmbiguousCreateError(`Remote D1 credential gate create outcome is ambiguous; remediate exact database name ${name}.`) }
  let value
  try { value = await response.json() } catch { if (response.ok) throw new AmbiguousCreateError(`Remote D1 credential gate create outcome is ambiguous; remediate exact database name ${name}.`); throw new Error("Remote D1 credential gate resource create failed.") }
  if (!response.ok || value?.success !== true) throw new Error("Remote D1 credential gate resource create failed.")
  if (value.result?.name !== name || typeof value.result?.uuid !== "string" || !DATABASE_ID.test(value.result.uuid)) throw new AmbiguousCreateError(`Remote D1 credential gate create outcome is ambiguous; remediate exact database name ${name}.`)
  return value.result.uuid
}
async function deleteDatabase(request, endpoint, token, databaseId) {
  const response = await request(`${endpoint}/${databaseId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const value = await response.json()
  if (!response.ok || value?.success !== true) throw new Error("Remote D1 credential gate resource cleanup failed.")
}
function rollbackQueries(rollbackId) {
  const digest = () => createHash("sha256").update(randomBytes(32)).digest("hex")
  const row = (value) => [rollbackId, "v1", value, "ci:remote-gate:rollback", "[\"sites:read\"]", Date.parse(EXPIRY), 1, Date.now()]
  const sql = "INSERT INTO wp_codebox_principal_credentials (credential_id, version, digest, principal, scopes, expires_at, max_sites, sites, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)"
  return [{ sql, params: row(digest()) }, { sql, params: row(digest()) }]
}
function validCredentialEvidence(rows, credentialId, principal) {
  if (rows.length !== 3) return false
  return ["v1", "v2", "v3"].every((version) => rows.some((row) => row.credential_id === credentialId && row.version === version && row.principal === principal && row.scopes === "[\"sites:create\",\"sites:read\"]" && row.expires_at === Date.parse(EXPIRY) && row.max_sites === 2 && row.sites === null && (version === "v2" ? row.revoked_at === null : Number.isSafeInteger(row.revoked_at))))
}
function validAuditEvidence(rows, credentialId, principal) {
  if (rows.length !== 5 || rows.some((row) => row.credential_id !== credentialId || row.principal !== principal || row.reason !== "ok")) return false
  return ["v1", "v2", "v3"].every((version) => rows.filter((row) => row.kind === "registered" && row.version === version).length === 1) && ["v1", "v3"].every((version) => rows.filter((row) => row.kind === "revoked" && row.version === version).length === 1)
}
function constraintFailure({ responseOk, value }) {
  return responseOk && Array.isArray(value?.result) && value.result.length === 2 && value.result[0]?.success === true && value.result[1]?.success === false && boundedStrings(value.result[1]?.errors).some((text) => /(?:constraint|unique|primary key)/i.test(text))
}
function boundedStrings(value, depth = 0, output = []) { if (depth > 8 || output.length >= 32) return output; if (typeof value === "string") output.push(value.slice(0, 512)); else if (Array.isArray(value)) value.slice(0, 32).forEach((item) => boundedStrings(item, depth + 1, output)); else if (value && typeof value === "object") Object.values(value).slice(0, 32).forEach((item) => boundedStrings(item, depth + 1, output)); return output }
async function writeConfig(path, value) { await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await chmod(path, 0o600) }
async function operatorAction(run, operator, action, args, stdin, expected) { const result = await operatorResult(run, operator, action, args, stdin); if (result.action !== expected) throw new Error("Remote D1 credential gate operator result is invalid.") }
async function operatorFailure(run, operator, action, args, stdin, expectedCode) { const [command, commandArgs] = operatorCommand(operator, action, args); const result = await run(command, commandArgs, stdin); if (!result || result.status === 0 || result.outputTruncated || typeof result.stdout !== "string" || typeof result.stderr !== "string" || result.stdout.length > OUTPUT_LIMIT || result.stderr.length > OUTPUT_LIMIT || structuredErrorCode(result.stderr) !== expectedCode) throw new Error("Remote D1 credential gate expected conflict evidence is invalid.") }
async function operatorResult(run, operator, action, args, stdin) { const result = await required(run, ...operatorCommand(operator, action, args), stdin); const value = parseJson(result.stdout); if (!value || value.schema !== "wp-codebox/principal-credential-operator/v1" || typeof value.action !== "string") throw new Error("Remote D1 credential gate operator evidence is invalid."); return value }
function operatorCommand(operator, action, args) { return [process.execPath, ["--import", "tsx", operator, action, ...args]] }
async function required(run, command, args, stdin = "") { const result = await run(command, args, stdin); if (!result || result.status !== 0 || typeof result.stdout !== "string" || typeof result.stderr !== "string" || result.stdout.length > OUTPUT_LIMIT || result.stderr.length > OUTPUT_LIMIT || result.outputTruncated) throw new Error("Remote D1 credential gate command failed."); return result }
async function batch(request, endpoint, token, queries, expectSuccess = true) { const response = await request(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ batch: queries }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); const value = await response.json(); const success = response.ok && value?.success === true && Array.isArray(value.result) && value.result.length === queries.length && value.result.every((entry) => entry?.success === true); if (expectSuccess && !success) throw new Error("Remote D1 credential gate batch failed."); return expectSuccess ? value : { responseOk: response.ok, value } }
function results(value) { return value.result.map((entry) => Array.isArray(entry.results) ? entry.results : []) }
function parseJson(value) { try { return JSON.parse(value) } catch { throw new Error("Remote D1 credential gate received invalid JSON.") } }
function structuredErrorCode(value) { try { const parsed = JSON.parse(value); return parsed?.schema === "wp-codebox/principal-credential-operator-error/v1" && typeof parsed.code === "string" ? parsed.code : undefined } catch { return undefined } }
export function runChild(command, args, stdin, timeoutMs = CHILD_TIMEOUT_MS) { return new Promise((resolveRun) => { const child = spawn(command, args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }); let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let outputTruncated = false; let settled = false; let killTimer; const finish = (status) => { if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(killTimer); resolveRun({ status, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), outputTruncated }) }; const terminate = () => { child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000) }; const append = (target, chunk) => { const value = Buffer.from(chunk); const current = target === "stdout" ? stdout : stderr; if (current.byteLength + value.byteLength > OUTPUT_LIMIT) { const remaining = Math.max(0, OUTPUT_LIMIT - current.byteLength); if (target === "stdout") stdout = Buffer.concat([stdout, value.subarray(0, remaining)]); else stderr = Buffer.concat([stderr, value.subarray(0, remaining)]); outputTruncated = true; terminate(); return } if (target === "stdout") stdout = Buffer.concat([stdout, value]); else stderr = Buffer.concat([stderr, value]) }; const timeout = setTimeout(() => { outputTruncated = true; terminate() }, timeoutMs); child.stdout.on("data", (chunk) => append("stdout", chunk)); child.stderr.on("data", (chunk) => append("stderr", chunk)); child.on("error", () => finish(1)); child.on("exit", (status) => finish(status)); child.stdin.end(stdin) }) }

if (import.meta.url === `file://${process.argv[1]}`) { const args = process.argv.slice(2); const accountIndex = args.indexOf("--account-id"); runRemotePrincipalCredentialGate({ confirmation: args.includes(CONFIRMATION), accountId: accountIndex === -1 ? undefined : args[accountIndex + 1] }).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }) }
