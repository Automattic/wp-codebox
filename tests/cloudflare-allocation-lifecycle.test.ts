import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { AllocationLifecycleConflict, CloudflareAllocationLifecycle } from "../packages/runtime-cloudflare/src/allocation-lifecycle.js"

function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:")
  let queued = Promise.resolve()
  return { prepare(query: string) { const statement = sqlite.prepare(query); let values: unknown[] = []; return { bind(...next: unknown[]) { values = next; return this }, async run() { return { meta: { changes: statement.run(...values).changes } } }, async first<T>() { return statement.get(...values) as T | null }, async all<T>() { return { results: statement.all(...values) as T[] } } } }, async batch(statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) { let release!: () => void; const previous = queued; queued = new Promise((resolve) => { release = resolve }); await previous; sqlite.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results } catch (error) { sqlite.exec("ROLLBACK"); throw error } finally { release() } } } as unknown as D1Database
}
class Bucket {
  objects = new Map<string, Uint8Array>()
  failOnce = false
  async list(options: { prefix?: string; cursor?: string; limit?: number }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix ?? "")).sort()
    const available = options.cursor ? keys.filter((key) => key > options.cursor!) : keys; const page = available.slice(0, options.limit ?? 100)
    return { objects: page.map((key) => ({ key })), truncated: page.length < available.length, cursor: page.at(-1) ?? "" }
  }
  async delete(keys: string[]) { if (this.failOnce) { this.failOnce = false; throw new Error("transient R2 failure") } for (const key of keys) this.objects.delete(key) }
}
const site = (id = "saaaaaaaaaaaaaaaaaaaaaaaa-g2-0123456789abcdef") => ({ id, hostname: `${id}.preview.example`, origin: `https://${id}.preview.example` })

test("expiration fences mutations, retains quota until terminal reclamation, and then releases it", async () => {
  const lifecycle = new CloudflareAllocationLifecycle(database(), { ttlMs: 10, retainMs: 20 }); const bucket = new Bucket(); const now = 1_000
  const active = await lifecycle.create(site(), "owner", now); assert.equal(active.retainUntil, now + 30); const mutation = await lifecycle.beginMutation(active.identity, "owner", now + 1)
  assert.deepEqual(await lifecycle.expire(now + 10), [active.identity])
  await assert.rejects(() => lifecycle.assertMutation(active.identity, mutation, now + 10), AllocationLifecycleConflict)
  assert.equal((await lifecycle.get(active.identity))!.state, "deleting")
  bucket.objects.set(`sites/${site().id}/one`, new Uint8Array([1]))
  assert.deepEqual(await lifecycle.pendingDeletions(1, now + 29), [], "reads remain available during the declared grace period")
  const deleting = (await lifecycle.get(active.identity))!; const tombstone = await lifecycle.reclaim(bucket as unknown as Pick<R2Bucket, "list" | "delete">, active.identity, deleting.operationFence, 10, now + 30)
  assert.equal(tombstone.state, "tombstoned"); assert.equal(tombstone.receipt?.deletedObjects, 1); assert.equal(tombstone.receipt?.completedAt, new Date(now + 30).toISOString())
})

test("owner authorization, concurrent deletion, and stale generations fail closed", async () => {
  const lifecycle = new CloudflareAllocationLifecycle(database()); const created = await lifecycle.create(site(), "owner", 1_000)
  await assert.rejects(() => lifecycle.renew(created.identity, "other", 1_001), AllocationLifecycleConflict)
  await assert.rejects(() => lifecycle.beginDeletion(created.identity, "other", 1_001), AllocationLifecycleConflict)
  const [one, two] = await Promise.allSettled([lifecycle.beginDeletion(created.identity, "owner", 1_001), lifecycle.beginDeletion(created.identity, "owner", 1_001)])
  assert.equal([one, two].filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(await lifecycle.get({ ...created.identity, generation: 1 }), null, "a prior generation is never an authorized identity")
})

test("cleanup checkpoints resume after partial R2 failure and tombstone receipts are immutable", async () => {
  const lifecycle = new CloudflareAllocationLifecycle(database(), { ttlMs: 10, retainMs: 0 }); const bucket = new Bucket(); const created = await lifecycle.create(site(), "owner", 1_000)
  for (const key of ["a", "b", "c"]) bucket.objects.set(`sites/${site().id}/${key}`, new Uint8Array([1]))
  const fence = await lifecycle.beginDeletion(created.identity, "owner", 1_001)
  const first = await lifecycle.reclaim(bucket as unknown as Pick<R2Bucket, "list" | "delete">, created.identity, fence, 1, 1_002)
  assert.ok(first.cleanupCursor?.endsWith("/a")); assert.equal(first.deletedObjects, 1)
  bucket.failOnce = true
  await assert.rejects(() => lifecycle.reclaim(bucket as unknown as Pick<R2Bucket, "list" | "delete">, created.identity, fence, 1, 1_003))
  let current = await lifecycle.reclaim(bucket as unknown as Pick<R2Bucket, "list" | "delete">, created.identity, fence, 1, 1_004)
  current = await lifecycle.reclaim(bucket as unknown as Pick<R2Bucket, "list" | "delete">, created.identity, fence, 1, 1_005)
  assert.equal(current.state, "tombstoned"); assert.equal(bucket.objects.size, 0)
  const receipt = JSON.stringify(current.receipt)
  await assert.rejects(() => lifecycle.reclaim(bucket as unknown as Pick<R2Bucket, "list" | "delete">, created.identity, fence, 1, 1_006), AllocationLifecycleConflict)
  assert.equal(JSON.stringify((await lifecycle.get(created.identity))!.receipt), receipt)
})

test("reclamation removes bounded D1 work before issuing a zero-unresolved receipt", async () => {
  const db = database(); const lifecycle = new CloudflareAllocationLifecycle(db, { ttlMs: 10, retainMs: 0 }); const created = await lifecycle.create(site(), "owner", 1_000)
  await db.prepare("CREATE TABLE wp_codebox_operations (site_id TEXT, operation_id TEXT, state TEXT, stage TEXT, progress INTEGER, claim_token TEXT, claim_expires_at INTEGER, retry_at INTEGER, error_code TEXT, error_message TEXT, completed_at TEXT, updated_at INTEGER)").run()
  await db.prepare("CREATE TABLE wp_codebox_operation_attempts (site_id TEXT, operation_id TEXT, completed_at TEXT, state TEXT, stage TEXT, error_code TEXT, error_message TEXT)").run()
  await db.prepare("CREATE TABLE wp_codebox_api_admin_claims (site_id TEXT, state TEXT, updated_at INTEGER)").run()
  await db.prepare("INSERT INTO wp_codebox_operations (site_id, operation_id, state) VALUES (?, ?, 'queued')").bind(site().id, "one").run()
  await db.prepare("INSERT INTO wp_codebox_operations (site_id, operation_id, state) VALUES (?, ?, 'queued')").bind(site().id, "two").run()
  await db.prepare("INSERT INTO wp_codebox_operation_attempts (site_id, operation_id) VALUES (?, ?)").bind(site().id, "one").run()
  await db.prepare("INSERT INTO wp_codebox_api_admin_claims (site_id, state) VALUES (?, 'pending')").bind(site().id).run()
  const fence = await lifecycle.beginDeletion(created.identity, "owner", 1_001)
  const bucket = new Bucket(); const first = await lifecycle.reclaim(bucket as unknown as Pick<R2Bucket, "list" | "delete">, created.identity, fence, 1, 1_002)
  assert.equal(first.state, "deleting", "a bounded cleanup pass cannot tombstone unresolved D1 work")
  const final = await lifecycle.reclaim(bucket as unknown as Pick<R2Bucket, "list" | "delete">, created.identity, fence, 10, 1_003)
  assert.equal(final.state, "tombstoned")
  assert.equal(final.receipt?.unresolvedRecords, 0)
  assert.equal(final.receipt?.deletedRecords, 4)
})
