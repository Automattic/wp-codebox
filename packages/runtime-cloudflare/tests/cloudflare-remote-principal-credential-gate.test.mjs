import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { runChild, runRemotePrincipalCredentialGate } from "../scripts/remote-principal-credential-gate.mjs"

const accountId = "a".repeat(32)
const token = "remote-gate-test-token"
const uuid = "11111111-2222-3333-4444-555555555555"
const runId = "11111111-1111-4111-8111-111111111111"
const databaseName = `wp-codebox-2082-${runId}`
const suffix = "1111111111114111"

test("remote gate requires explicit confirmation and valid credentials before commands or network", async () => {
  let called = false
  for (const input of [{ accountId, apiToken: token }, { confirmation: true, accountId: "invalid", apiToken: "" }]) {
    await assert.rejects(runRemotePrincipalCredentialGate({ ...input, run: async () => { called = true }, fetch: async () => { called = true } }), /(?:requires --confirm-remote-d1-gate|configuration is invalid)/)
  }
  assert.equal(called, false)
})

test("remote gate uses exact create receipts and immutable UUID cleanup with bounded evidence", async () => {
  const harness = successfulHarness()
  const result = await runRemotePrincipalCredentialGate({ confirmation: true, accountId, apiToken: token, runId, ...harness })
  assert.equal(result.status, "passed")
  assert.deepEqual(result.evidence.concurrentRevocation, ["revoked", "unchanged"])
  assert.equal(harness.requests[0].url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`)
  assert.deepEqual(harness.requests[0].body, { name: databaseName })
  assert.equal(harness.requests.at(-1).url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${uuid}`)
  assert.equal(harness.requests.at(-1).method, "DELETE")
  assert.equal(harness.requests.some((request) => request.url.includes(databaseName)), false)
  assert.equal(harness.calls.some((call) => call.args.includes("d1")), false)
  const secret = harness.calls.find((call) => call.args[3] === "issue").stdin
  const digest = createHash("sha256").update(secret).digest("hex")
  const emitted = JSON.stringify(result)
  for (const value of [token, secret, digest, databaseName, uuid]) assert.equal(emitted.includes(value), false)
  assert.equal(harness.requests.filter((request) => request.method === "POST" && request.body?.batch).every((request) => request.body.batch.every((query) => !/SELECT .*\b(?:digest|dedupe_key)\b/i.test(query.sql))), true)
})

test("ambiguous create preserves only exact-name remediation and never deletes by name", async () => {
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, method: init.method })
    return response({ success: true, result: { name: "replacement-name", uuid } })
  }
  await assert.rejects(runRemotePrincipalCredentialGate({ confirmation: true, accountId, apiToken: token, runId, run: async () => { throw new Error("unexpected") }, fetch }), (error) => error.message === `Remote D1 credential gate create outcome is ambiguous; remediate exact database name ${databaseName}.`)
  assert.deepEqual(requests, [{ url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, method: "POST" }])
})

test("rollback requires a structured constraint failure and child output remains bounded and redacted", async () => {
  const nonConstraint = successfulHarness({ rollback: { success: false, result: [{ success: true, results: [] }, { success: false, errors: [{ message: "temporary unavailable" }] }] } })
  await assert.rejects(runRemotePrincipalCredentialGate({ confirmation: true, accountId, apiToken: token, runId, ...nonConstraint }), (error) => {
    const bearer = nonConstraint.calls.find((call) => call.args[3] === "issue")?.stdin
    const digest = bearer ? createHash("sha256").update(bearer).digest("hex") : ""
    return error.message === "Remote D1 credential gate failed." && ![token, bearer, digest].some((value) => value && error.message.includes(value))
  })
  assert.equal(nonConstraint.requests.at(-1).method, "DELETE")

  const bounded = successfulHarness({ largeOutput: true })
  await assert.rejects(runRemotePrincipalCredentialGate({ confirmation: true, accountId, apiToken: token, runId, ...bounded }), (error) => error.message === "Remote D1 credential gate failed." && !error.message.includes(token))
  assert.equal(bounded.requests.at(-1).method, "DELETE")

  for (const field of ["stdout", "stderr"]) {
    const expectedFailureOverflow = successfulHarness({ conflictLargeOutput: field })
    await assert.rejects(runRemotePrincipalCredentialGate({ confirmation: true, accountId, apiToken: token, runId, ...expectedFailureOverflow }), /Remote D1 credential gate failed/)
    assert.equal(expectedFailureOverflow.requests.at(-1).method, "DELETE")
  }
})

test("child capture terminates deterministic hung commands", async () => {
  const result = await runChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], "", 25)
  assert.equal(result.outputTruncated, true)
  assert.ok(result.stdout.length <= 16_384)
  assert.ok(result.stderr.length <= 16_384)
})

function successfulHarness(options = {}) {
  const calls = []
  const requests = []
  let revokeV3 = 0
  const run = async (command, args, stdin) => {
    calls.push({ command, args, stdin })
    if (options.largeOutput) return { status: 0, stdout: "x".repeat(16_385), stderr: "", outputTruncated: true }
    const action = args[3]
    const version = args[args.indexOf("--version") + 1]
    const conflict = action === "issue" && (args.includes(`duplicate-${suffix}`) || args[args.indexOf("--max-sites") + 1] === "3")
    if (conflict) {
      const code = args.includes(`duplicate-${suffix}`) ? "duplicate-digest-conflict" : "version-policy-conflict"
      if (options.conflictLargeOutput) return { status: 1, stdout: options.conflictLargeOutput === "stdout" ? "x".repeat(16_385) : "", stderr: options.conflictLargeOutput === "stderr" ? "x".repeat(16_385) : JSON.stringify({ schema: "wp-codebox/principal-credential-operator-error/v1", code }), outputTruncated: true }
      return { status: 1, stdout: "", stderr: JSON.stringify({ schema: "wp-codebox/principal-credential-operator-error/v1", code }) }
    }
    const result = action === "revoke" && version === "v3" ? (++revokeV3 === 1 ? "revoked" : "unchanged") : action === "revoke" && version === "v1" ? (calls.filter((call) => call.args[3] === "revoke" && call.args.includes("v1")).length === 1 ? "revoked" : "unchanged") : "issued"
    return { status: 0, stdout: JSON.stringify({ schema: "wp-codebox/principal-credential-operator/v1", action: result }), stderr: "" }
  }
  const fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    requests.push({ url, method: init.method, body })
    if (init.method === "POST" && !body.batch) return response({ success: true, result: { name: databaseName, uuid } })
    if (init.method === "DELETE") return response({ success: true, result: {} })
    if (body.batch.length === 2 && body.batch[0].sql.startsWith("INSERT")) return response(options.rollback ?? { success: false, result: [{ success: true, results: [] }, { success: false, errors: [{ code: 1000, message: "UNIQUE constraint failed" }] }] })
    if (body.batch[0].sql.includes("principal_credential_audit")) return response({ success: true, result: [{ success: true, results: [audit("registered", "v1"), audit("registered", "v2"), audit("revoked", "v1"), audit("registered", "v3"), audit("revoked", "v3")] }] })
    if (body.batch.length === 1 && body.batch[0].sql.startsWith("SELECT credential_id, version")) return response({ success: true, result: [{ success: true, results: [] }] })
    return response({ success: true, result: [{ success: true, results: [{ credential_id: `gate-${suffix}`, version: "v1", principal: `ci:remote-gate:${suffix}`, scopes: "[\"sites:create\",\"sites:read\"]", expires_at: Date.parse("2099-01-01T00:00:00.000Z"), max_sites: 2, sites: null, revoked_at: 1 }, { credential_id: `gate-${suffix}`, version: "v2", principal: `ci:remote-gate:${suffix}`, scopes: "[\"sites:create\",\"sites:read\"]", expires_at: Date.parse("2099-01-01T00:00:00.000Z"), max_sites: 2, sites: null, revoked_at: null }, { credential_id: `gate-${suffix}`, version: "v3", principal: `ci:remote-gate:${suffix}`, scopes: "[\"sites:create\",\"sites:read\"]", expires_at: Date.parse("2099-01-01T00:00:00.000Z"), max_sites: 2, sites: null, revoked_at: 2 }] }, { success: true, results: [] }] })
  }
  return { run, fetch, calls, requests }
}

function audit(kind, version) { return { kind, version, principal: `ci:remote-gate:${suffix}`, credential_id: `gate-${suffix}`, reason: "ok" } }
function response(value) { return { ok: true, async json() { return value } } }
