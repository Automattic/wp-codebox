import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { D1PrincipalCredentialRepository } from "../packages/runtime-cloudflare/src/principal-credential-repository.js"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
function database(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:")
  return Object.assign({ prepare(query: string) { const statement = sqlite.prepare(query); let values: unknown[] = []; return { bind(...next: unknown[]) { values = next; return this }, async run() { return { meta: { changes: statement.run(...values).changes } } }, async first<T>() { return statement.get(...values) as T | null }, async all<T>() { return { results: statement.all(...values) as T[] } } } }, async batch(statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) { sqlite.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results } catch (error) { sqlite.exec("ROLLBACK"); throw error } } } as unknown as D1Database, { sqlite })
}
const policy = (change: Record<string, unknown> = {}) => ({ credentialId: "issuer-key", version: "v1", digest: digest("secret-bearer"), principal: "principal-a", scopes: ["sites:create", "sites:read"], expiresAt: "2099-01-01T00:00:00.000Z", maxSites: 1, ...change })

test("credential repository persists supplied digests only and rejects malformed policy", async () => {
  const db = database(); const repository = new D1PrincipalCredentialRepository(db)
  await repository.register(policy())
  await repository.register(policy())
  const stored = JSON.stringify(db.sqlite.prepare("SELECT * FROM wp_codebox_principal_credentials").all())
  assert.match(stored, new RegExp(digest("secret-bearer")))
  assert.doesNotMatch(stored, /secret-bearer/)
  await assert.rejects(() => repository.register(policy({ version: "v2", scopes: ["root"] })), /policy is invalid/)
  await assert.rejects(() => repository.register(policy({ version: "v2", sites: ["INVALID"] })), /policy is invalid/)
})

test("credential repository enforces scope, site policy, expiry, overlap, and immediate revocation", async () => {
  const repository = new D1PrincipalCredentialRepository(database())
  await repository.register(policy({ sites: ["alpha"] }))
  assert.equal((await repository.authorize("secret-bearer", "sites:create", "alpha"))?.principal, "principal-a")
  assert.equal(await repository.authorize("secret-bearer", "sites:import"), null)
  assert.equal(await repository.authorize("secret-bearer", "sites:create", "beta"), null)
  await repository.register(policy({ version: "v2", digest: digest("rotated-bearer") }))
  assert.ok(await repository.authenticate("secret-bearer"))
  assert.ok(await repository.authenticate("rotated-bearer"))
  assert.equal(await repository.revoke("issuer-key", "v1"), true)
  assert.equal(await repository.authenticate("secret-bearer"), null)
  await repository.register(policy({ credentialId: "expired", version: "v1", digest: digest("expired-bearer"), expiresAt: "2000-01-01T00:00:00.000Z" }))
  assert.equal(await repository.authenticate("expired-bearer"), null)
})

test("credential audit is bounded, immutable, redacted evidence", async () => {
  const db = database(); const repository = new D1PrincipalCredentialRepository(db, 3)
  await repository.register(policy())
  await repository.authenticate("secret-bearer")
  await repository.authorize("secret-bearer", "sites:import", undefined, 1_000_000)
  await repository.authorize("secret-bearer", "sites:import", undefined, 1_000_001)
  const events = await repository.auditEvents()
  assert.ok(Object.isFrozen(events[0]))
  assert.throws(() => { events[0].reason = "ok" }, TypeError)
  assert.ok(events.some((event) => event.kind === "denied" && event.reason === "scope"))
  assert.equal(events.filter((event) => event.reason === "scope").length, 1, "known denials coalesce within a bounded time bucket")
  const evidence = JSON.stringify(events)
  assert.doesNotMatch(evidence, /secret-bearer|[a-f0-9]{64}/)
  assert.equal((await repository.auditEvents(1_000)).length, events.length, "audit reads remain bounded to 100 records")
  await repository.authenticate("secret-bearer")
  assert.equal(countAudit(db), 3, "audit retention remains bounded while preserving the newest evidence")
  await repository.authenticate("unknown-a", 1_000_000)
  await repository.authenticate("unknown-b", 1_000_001)
  assert.equal((await repository.auditEvents()).filter((event) => event.reason === "unknown").length, 1, "unknown attempts coalesce within a bounded time bucket")
})

test("durable lookup distinguishes static fallback from known credential denial", async () => {
  const repository = new D1PrincipalCredentialRepository(database())
  await repository.register(policy())
  assert.deepEqual(await repository.authorizeDigest(digest("static-bearer"), "sites:create"), { status: "not-found" })
  assert.equal((await repository.auditEvents()).some((event) => event.reason === "unknown"), false)
  await repository.revoke("issuer-key", "v1")
  assert.equal((await repository.authorizeDigest(digest("secret-bearer"), "sites:create")).status, "denied")
})

test("malformed persisted credential policy fails closed", async () => {
  const db = database(); const repository = new D1PrincipalCredentialRepository(db)
  await repository.initialize()
  db.sqlite.prepare("INSERT INTO wp_codebox_principal_credentials (credential_id, version, digest, principal, scopes, expires_at, max_sites, sites, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)").run("corrupt", "v1", digest("corrupt-bearer"), "principal-a", "not-json", Date.parse("2099-01-01T00:00:00.000Z"), 1, Date.now())
  await assert.rejects(() => repository.authorizeDigest(digest("corrupt-bearer"), "sites:create"), /Stored credential policy is invalid/)
})

test("credential registration and revocation are atomic with their audit evidence", async () => {
  const db = database(); const repository = new D1PrincipalCredentialRepository(db)
  await repository.initialize()
  db.sqlite.exec("CREATE TRIGGER fail_registration_audit BEFORE INSERT ON wp_codebox_principal_credential_audit WHEN NEW.kind = 'registered' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  await assert.rejects(() => repository.register(policy()), /audit unavailable/)
  assert.equal(Number((db.sqlite.prepare("SELECT COUNT(*) AS count FROM wp_codebox_principal_credentials").get() as { count: number }).count), 0)
  db.sqlite.exec("DROP TRIGGER fail_registration_audit")
  await repository.register(policy())
  db.sqlite.exec("CREATE TRIGGER fail_revocation_audit BEFORE INSERT ON wp_codebox_principal_credential_audit WHEN NEW.kind = 'revoked' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  await assert.rejects(() => repository.revoke("issuer-key", "v1"), /audit unavailable/)
  assert.equal((db.sqlite.prepare("SELECT revoked_at FROM wp_codebox_principal_credentials WHERE credential_id = 'issuer-key' AND version = 'v1'").get() as { revoked_at: number | null }).revoked_at, null)
})

function countAudit(db: D1Database & { sqlite: DatabaseSync }): number { return Number((db.sqlite.prepare("SELECT COUNT(*) AS count FROM wp_codebox_principal_credential_audit").get() as { count: number }).count) }
