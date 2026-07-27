import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { D1OperationRepository, OperationConflict, shouldRecoverPreparedCommit } from "../packages/runtime-cloudflare/src/d1-operation-repository.js"
import { CloudflareAllocationLifecycle } from "../packages/runtime-cloudflare/src/allocation-lifecycle.js"
import { DEFAULT_RUNTIME_QUEUE_POLICY, parseRuntimeQueueMessage, RUNTIME_QUEUE_MESSAGE_SCHEMA, runtimeQueueMessage } from "../packages/runtime-cloudflare/src/queue-dispatch.js"

function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:")
  let queued = Promise.resolve()
  return { prepare(query: string) { const statement = sqlite.prepare(query); let values: unknown[] = []; return { bind(...next: unknown[]) { values = next; return this }, async run() { return { meta: { changes: statement.run(...values).changes } } }, async first<T>() { return statement.get(...values) as T | null }, async all<T>() { return { results: statement.all(...values) as T[] } } } }, async batch(statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) { let release!: () => void; const previous = queued; queued = new Promise((resolve) => { release = resolve }); await previous; sqlite.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results } catch (error) { sqlite.exec("ROLLBACK"); throw error } finally { release() } } } as unknown as D1Database
}
const site = { id: "alpha", hostname: "alpha.example", origin: "https://alpha.example" }
const beta = { id: "beta", hostname: "beta.example", origin: "https://beta.example" }
function input(key = "key", fingerprint = "a".repeat(64)) { return { idempotencyKey: key, fingerprint, artifact: { r2Key: `sites/alpha/import-artifacts/${"b".repeat(64)}.json`, sha256: "b".repeat(64), size: 1 }, options: { slug: "site", name: "Site", siteTitle: "Site" } } }
const pointer = { revision: "revision", manifestKey: "sites/alpha/markdown/revisions/revision.json", persistedAt: "2026-07-23T00:00:00.000Z" }

test("D1 operations converge by site/key/fingerprint and reject changed input or site identity", async () => {
  const repository = new D1OperationRepository(database())
  const first = await repository.createOrConverge(site, input())
  const duplicate = await repository.createOrConverge(site, input())
  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.operation.operationId, first.operation.operationId)
  await assert.rejects(() => repository.createOrConverge(site, input("key", "c".repeat(64))), OperationConflict)
  await assert.rejects(() => repository.createOrConverge({ ...site, origin: "https://other.example" }, input("other")), /identity conflicts/)
})

test("D1 enforces one active mutation per site while independent sites claim concurrently", async () => {
  const repository = new D1OperationRepository(database())
  await repository.createOrConverge(site, input("one"))
  await assert.rejects(() => repository.createOrConverge(site, input("two")), /active/)
  await repository.createOrConverge(beta, input("two"))
  const [alphaClaim, racedAlphaClaim, betaClaim] = await Promise.all([repository.claimNext(site.id), repository.claimNext(site.id), repository.claimNext(beta.id)])
  assert.equal([alphaClaim, racedAlphaClaim].filter(Boolean).length, 1)
  assert.ok(betaClaim)
  assert.notEqual((alphaClaim ?? racedAlphaClaim)!.operationId, betaClaim.operationId)
})

test("an operation wake-up can claim only its exact durable operation identity", async () => {
  const repository = new D1OperationRepository(database())
  const created = await repository.createOrConverge(site, input("target"))
  assert.equal(await repository.claimOperation(site.id, "00000000-0000-4000-8000-000000000000"), null)
  const claim = await repository.claimOperation(site.id, created.operation.operationId)
  assert.equal(claim?.operationId, created.operation.operationId)
})

test("expired claims recover, retries retain attempt history, and terminal receipts are immutable", async () => {
  const repository = new D1OperationRepository(database())
  const created = await repository.createOrConverge(site, input())
  const claim = await repository.claimNext(site.id)
  assert.ok(claim)
  await repository.retry(site.id, claim.operationId, claim.claimToken, new Error("retry\nsecret"), Date.now())
  const recovered = await repository.claimNext(site.id)
  assert.ok(recovered)
  await repository.prepareCommit(site.id, recovered.operationId, recovered.claimToken, 7, pointer, { imported: true }, null)
  await repository.complete(site.id, recovered.operationId, recovered.claimToken, { imported: true }, undefined, site.origin)
  const terminal = await repository.get(site.id, created.operation.operationId)
  assert.equal(terminal?.state, "succeeded")
  assert.equal(terminal?.stage, "completed")
  assert.equal(terminal?.attemptHistory.length, 2)
  assert.equal(terminal?.attemptHistory[0].state, "succeeded")
  assert.equal("token" in terminal!.attemptHistory[0], false)
  assert.equal(terminal?.receipt?.publication.status, "none")
  assert.ok(terminal?.receipt?.terminalCompletedAt)
  assert.deepEqual(terminal?.receipt?.canonical, { pointer, version: 7 })
  assert.equal(await repository.claimNext(site.id), null)
  await assert.rejects(() => repository.fail(site.id, recovered.operationId, recovered.claimToken, new Error("late")), OperationConflict)

  await repository.createOrConverge(beta, input("expiry"))
  const expired = await repository.claimNext(beta.id)
  assert.ok(expired)
  const reclaimed = await repository.claimNext(beta.id, Date.now() + 600_001)
  assert.ok(reclaimed)
  assert.notEqual(reclaimed.claimToken, expired.claimToken)
})

test("claim and terminal batches keep attempt rows consistent and publication reconciliation is truthful", async () => {
  const repository = new D1OperationRepository(database())
  const created = await repository.createOrConverge(site, input())
  const claim = await repository.claimNext(site.id)
  assert.ok(claim)
  let operation = await repository.get(site.id, created.operation.operationId)
  assert.equal(operation?.attemptHistory.length, 1)
  assert.equal(operation?.attemptHistory[0].completedAt, null)
  await repository.prepareCommit(site.id, claim.operationId, claim.claimToken, 8, pointer, { imported: true }, "job-8")
  await repository.complete(site.id, claim.operationId, claim.claimToken, { imported: true }, "job-8", site.origin)
  operation = await repository.get(site.id, created.operation.operationId)
  assert.equal(operation?.state, "publication-pending")
  assert.equal(operation?.attemptHistory[0].completedAt !== null, true)
  await repository.reconcilePublication(site.id, "job-8", "promoted", "publication-revision")
  operation = await repository.get(site.id, created.operation.operationId)
  assert.equal(operation?.state, "succeeded")
  assert.deepEqual(operation?.receipt?.publication, { status: "promoted", jobKey: "job-8", revision: "publication-revision" })
  assert.ok(operation?.receipt?.terminalCompletedAt)
})

test("exact prepared-pointer recovery only skips SSI for the matching coordinator receipt", () => {
  const prepared = { pointer, version: 7, ssiResult: { imported: true }, publicationJobKey: null }
  assert.equal(shouldRecoverPreparedCommit(prepared, pointer), true)
  assert.equal(shouldRecoverPreparedCommit(prepared, { ...pointer, revision: "unrelated", manifestKey: "sites/alpha/markdown/revisions/unrelated.json" }), false)
  assert.equal(shouldRecoverPreparedCommit(null, pointer), false)
})

test("deletion fences an in-flight claim and a publication callback", async () => {
  const db = database(); const dynamic = { id: "race-g2-0123456789abcdef", hostname: "race.preview.example", origin: "https://race.preview.example" }
  const lifecycle = new CloudflareAllocationLifecycle(db, { ttlMs: 60_000, retainMs: 0 }); const active = await lifecycle.create(dynamic, "owner")
  const repository = new D1OperationRepository(db); const created = await repository.createOrConverge(dynamic, input("race")); const claim = await repository.claimNext(dynamic.id)
  assert.ok(claim)
  const fence = await lifecycle.beginDeletion(active.identity, "owner")
  await assert.rejects(() => repository.renew(dynamic.id, claim.operationId, claim.claimToken), OperationConflict)
  await assert.rejects(() => repository.prepareCommit(dynamic.id, claim.operationId, claim.claimToken, 1, { ...pointer, manifestKey: `sites/${dynamic.id}/markdown/revisions/revision.json` }, { imported: true }, "job-race"), OperationConflict)
  await assert.rejects(() => repository.complete(dynamic.id, claim.operationId, claim.claimToken, { imported: true }, "job-race", dynamic.origin), OperationConflict)
  assert.equal(await repository.claimNext(dynamic.id), null)
  assert.equal((await repository.get(dynamic.id, created.operation.operationId))?.stage, "allocation-deleted")
  await repository.reconcilePublication(dynamic.id, "job-race", "promoted", "revision")
  assert.equal((await repository.get(dynamic.id, created.operation.operationId))?.state, "failed")
  assert.ok(fence > active.operationFence)
})

test("queue dispatches are versioned wake-ups with durable repair and dead-letter evidence", async () => {
  const repository = new D1OperationRepository(database())
  const created = await repository.createOrConverge(site, input())
  const message = await repository.stageDispatch(site, "operation", created.operation.operationId, "principal:a")
  assert.deepEqual(message, { schema: RUNTIME_QUEUE_MESSAGE_SCHEMA, siteId: site.id, generation: 1, kind: "operation", identity: created.operation.operationId })
  assert.deepEqual(await repository.pendingDispatches(DEFAULT_RUNTIME_QUEUE_POLICY), [message])
  await repository.failedDispatch(message, new Error("queue unavailable\nsecret"))
  assert.deepEqual(await repository.pendingDispatches(DEFAULT_RUNTIME_QUEUE_POLICY), [message], "a producer failure leaves durable repair work")
  await repository.deadDispatch(message, 3, new Error("isolate evicted\nsecret"))
  const evidence = await repository.deadLetterEvidence(message)
  assert.equal(evidence?.attempts, 3)
  assert.equal(evidence?.inputDigest, created.operation.input.fingerprint)
  assert.equal(evidence?.lastError, "isolate evicted secret")
  assert.match(evidence?.recoveryCommand ?? "", /^npx wrangler d1 execute wp-codebox-runtime-state --remote --command/)
  await repository.completeDispatch(message)
  assert.equal(await repository.dispatchState(message), "dead-letter")
  assert.deepEqual(await repository.pendingDispatches(DEFAULT_RUNTIME_QUEUE_POLICY), [])
  assert.equal(parseRuntimeQueueMessage({ ...message, schema: "foreign" }), null)
  assert.equal(parseRuntimeQueueMessage({ ...message, generation: 0 }), null)
  assert.equal(parseRuntimeQueueMessage({ ...message, identity: "x".repeat(1024) }), null)
  assert.throws(() => runtimeQueueMessage({ id: "alpha" }, 1, "operation", ""), /invalid/)
})

test("publication dispatch registers configured site identity before any import operation", async () => {
  const repository = new D1OperationRepository(database())
  const identity = "sites/alpha/publications/jobs/00000000000000000001-00000000-0000-4000-8000-000000000000.json"
  const message = await repository.stageDispatch(site, "publication", identity, "system:alpha")
  assert.deepEqual(message, { schema: RUNTIME_QUEUE_MESSAGE_SCHEMA, siteId: site.id, generation: 1, kind: "publication", identity })
  await assert.rejects(() => repository.stageDispatch({ ...site, origin: "https://other.example" }, "publication", identity, "system:alpha"), /identity conflicts/)
})

test("queue admission enforces global and explicit principal backpressure", async () => {
  const repository = new D1OperationRepository(database())
  const betaSite = { id: "beta", hostname: "beta.example", origin: "https://beta.example" }
  const alphaOperation = await repository.createOrConverge(site, input("alpha-dispatch"))
  const betaOperation = await repository.createOrConverge(betaSite, input("beta-dispatch"))
  const alpha = await repository.stageDispatch(site, "operation", alphaOperation.operation.operationId, "principal:a")
  const betaMessage = await repository.stageDispatch(betaSite, "operation", betaOperation.operation.operationId, "principal:a")
  assert.equal(await repository.admitDispatch(alpha, { maxActive: 2, maxActivePerPrincipal: 1 }), true)
  assert.equal(await repository.admitDispatch(betaMessage, { maxActive: 2, maxActivePerPrincipal: 1 }), false)
  await repository.completeDispatch(alpha)
  assert.equal(await repository.admitDispatch(betaMessage, { maxActive: 2, maxActivePerPrincipal: 1 }), true)
})

test("queue processing ownership survives producer replay and honors retry delay", async () => {
  const repository = new D1OperationRepository(database())
  const created = await repository.createOrConverge(site, input("dispatch-ownership"))
  const message = await repository.stageDispatch(site, "operation", created.operation.operationId, "principal:a")
  assert.equal(await repository.admitDispatch(message, DEFAULT_RUNTIME_QUEUE_POLICY), true)
  await repository.deliveredDispatch(message)
  assert.equal(await repository.processingDispatch(message), true)
  await repository.deliveredDispatch(message)
  assert.equal(await repository.dispatchState(message), "processing", "a replayed producer send cannot clear processing ownership")
  assert.equal(await repository.processingDispatch(message), false)
  await repository.retryDispatch(message, new Error("retry later"))
  assert.equal(await repository.processingDispatch(message), false, "redelivery cannot bypass durable retry_at")
  assert.equal(await repository.processingDispatch(message, Date.now() + 31_000), true)
})

test("rendered publication dispatches continue as fresh wake-ups", async () => {
  const repository = new D1OperationRepository(database())
  const identity = "sites/alpha/publications/jobs/00000000000000000001-00000000-0000-4000-8000-000000000000.json"
  const message = await repository.stageDispatch(site, "publication", identity, "system:alpha")
  await repository.admitDispatch(message, DEFAULT_RUNTIME_QUEUE_POLICY)
  await repository.deliveredDispatch(message)
  assert.equal(await repository.processingDispatch(message), true)
  await repository.continueDispatch(message)
  await repository.deliveredDispatch(message)
  assert.equal(await repository.processingDispatch(message), true)
})
