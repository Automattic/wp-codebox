import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { D1RevisionCoordinator } from "../src/d1-revision-coordinator.js"
import { WordPressStateCoordinator } from "../src/state-coordinator.js"

function d1Database(): D1Database {
  const database = new DatabaseSync(":memory:")
  return {
    prepare(query: string) {
      const statement = database.prepare(query)
      let values: unknown[] = []
      return {
        bind(...next: unknown[]) {
          values = next
          return this
        },
        async run() {
          return { meta: { changes: statement.run(...values).changes } }
        },
        async first<T>() {
          return statement.get(...values) as T | null
        },
      }
    },
    async batch(statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) {
      return Promise.all(statements.map((statement) => statement.run()))
    },
  } as unknown as D1Database
}

function pointer(siteId: string, revision: string) {
  return {
    revision,
    manifestKey: `sites/${siteId}/markdown/revisions/${revision}.json`,
    persistedAt: "2026-07-23T00:00:00.000Z",
  }
}

test("D1 coordinator partitions state, leases, fences, and commit receipts by site ID", async () => {
  const database = d1Database()
  const defaultSite = new D1RevisionCoordinator(database, "default")
  const alpha = new D1RevisionCoordinator(database, "alpha")
  const beta = new D1RevisionCoordinator(database, "beta")

  const [alphaFence, betaFence] = await Promise.all([alpha.acquireFence(30_000), beta.acquireFence(30_000)])
  assert.notEqual(alphaFence.token, betaFence.token)
  assert.deepEqual(await defaultSite.fenceStatus(), { active: false })
  await Promise.all([alpha.releaseFence(alphaFence.token), beta.releaseFence(betaFence.token)])

  const [alphaLease, betaLease] = await Promise.all([alpha.acquire(), beta.acquire()])
  assert.equal(alphaLease.version, 0)
  assert.equal(betaLease.version, 0)
  await alpha.commit(alphaLease, pointer("alpha", "alpha-revision"))
  await beta.commit(betaLease, pointer("beta", "beta-revision"))

  assert.deepEqual(await alpha.committed(1), pointer("alpha", "alpha-revision"))
  assert.deepEqual(await beta.committed(1), pointer("beta", "beta-revision"))
  assert.deepEqual(await defaultSite.state(), {
    schema: "wp-codebox/cloudflare-wordpress-state/v2",
    store: "d1",
    pointer: null,
    version: 0,
  })
})

test("D1 adoption accepts monotonic forward state and requires an active fence token", async () => {
  const coordinator = new D1RevisionCoordinator(d1Database(), "default")
  const retained = pointer("default", "retained")
  const current = pointer("default", "current")
  const later = pointer("default", "later")

  await coordinator.adopt(retained, 35)
  assert.deepEqual(await coordinator.adopt(current, 36), { pointer: current, version: 36 })
  await assert.rejects(() => coordinator.adopt(retained, 35), /monotonic forward/)
  await assert.rejects(() => coordinator.adopt({ ...current, revision: "divergent" }, 36), /monotonic forward/)

  const fence = await coordinator.acquireFence(30_000)
  await assert.rejects(() => coordinator.adopt(later, 37), /unmatched fence/)
  assert.deepEqual(await coordinator.adopt(later, 37, fence.token, true), { pointer: later, version: 37 })
  await coordinator.releaseFence(fence.token)
  await assert.rejects(() => coordinator.adopt(pointer("default", "required-fence"), 38, fence.token, true), /requires an active cutover fence/)
})

test("Durable Object coordinator writes the matching site pointer and preserves default compatibility", async () => {
  const objects = new Map<string, string>()
  const coordinator = (values: Map<string, unknown>) => new WordPressStateCoordinator({
    id: { toString: () => "test-do" },
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value) },
      delete: async (key: string) => { values.delete(key) },
      transaction: async (callback: (transaction: { put: (key: string, value: unknown) => Promise<void> }) => Promise<void>) => callback({ put: async (key, value) => { values.set(key, value) } }),
    },
  } as never, {
    WORDPRESS_STATE_BUCKET: {
      get: async (key: string) => objects.has(key) ? { json: async <T>() => JSON.parse(objects.get(key)!) as T } : null,
      put: async (key: string, value: string) => { objects.set(key, value) },
      delete: async (key: string) => { objects.delete(key) },
    } as never,
  })
  const call = async (target: WordPressStateCoordinator, siteId: string | undefined, action: string, body: Record<string, unknown> = {}) => {
    const url = new URL(`https://worker.example/?__wp_codebox_coordinator=${action}`)
    if (siteId) url.searchParams.set("siteId", siteId)
    return target.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
  }
  const commit = async (target: WordPressStateCoordinator, siteId: string | undefined, value: ReturnType<typeof pointer>) => {
    const lease = await (await call(target, siteId, "begin")).json() as { token: string; version: number }
    assert.equal((await call(target, siteId, "commit", { token: lease.token, baseRevision: null, version: lease.version, pointer: value })).status, 200)
  }

  await commit(coordinator(new Map()), undefined, pointer("default", "default-revision"))
  await commit(coordinator(new Map()), "alpha", pointer("alpha", "alpha-revision"))

  assert.deepEqual(JSON.parse(objects.get("sites/default/markdown/current.json")!), pointer("default", "default-revision"))
  assert.deepEqual(JSON.parse(objects.get("sites/alpha/markdown/current.json")!), pointer("alpha", "alpha-revision"))
})
