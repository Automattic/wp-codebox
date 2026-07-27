import assert from "node:assert/strict"
import test from "node:test"
import { dispatchQueueBatch, type QueueDelivery } from "../packages/runtime-cloudflare/src/queue-batch.js"
import { DEFAULT_RUNTIME_QUEUE_POLICY, parseRuntimeQueuePolicy, runtimeQueueMessage } from "../packages/runtime-cloudflare/src/queue-dispatch.js"

function delivery(siteId: string, kind: "operation" | "publication", identity: string): QueueDelivery & { result?: string; delaySeconds?: number } {
  return { body: runtimeQueueMessage({ id: siteId }, 1, kind, identity), attempts: 1, ack() { this.result = "ack" }, retry(options) { this.result = "retry"; this.delaySeconds = options?.delaySeconds } }
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

test("queue batch overlaps unrelated lanes but never overlaps a site lane", async () => {
  const messages = Array.from({ length: 10 }, (_, index) => delivery(`site-${index}`, "operation", id(index)))
  messages.push(delivery("site-0", "operation", id(99)))
  let active = 0; let peak = 0; const siteActive = new Map<string, number>()
  await dispatchQueueBatch(messages, (body) => body as ReturnType<typeof runtimeQueueMessage>, async (_site, lane) => lane[0], async ({ value }) => {
    const current = (siteActive.get(value.siteId) ?? 0) + 1; siteActive.set(value.siteId, current); assert.equal(current, 1)
    active++; peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 15))
    active--; siteActive.set(value.siteId, current - 1)
    return "ack"
  })
  assert.equal(peak, 10)
  assert.equal(messages.at(-1)?.result, "retry")
})

test("persisted lane preference can choose either ready kind without starvation", async () => {
  for (const first of ["operation", "publication"] as const) {
    const operation = delivery("alpha", "operation", id(1))
    const publication = delivery("alpha", "publication", "sites/alpha/publications/jobs/00000000000000000001-00000000-0000-4000-8000-000000000002.json")
    const executed: string[] = []
    await dispatchQueueBatch([operation, publication], (body) => body as ReturnType<typeof runtimeQueueMessage>, async (_site, lane) => lane.find(({ value }) => value.kind === first)!, async ({ value }) => { executed.push(value.kind); return "ack" })
    assert.deepEqual(executed, [first])
    assert.equal(first === "operation" ? publication.result : operation.result, "retry")
  }
})

test("queue policy is explicit and bounded", () => {
  assert.deepEqual(parseRuntimeQueuePolicy(undefined), DEFAULT_RUNTIME_QUEUE_POLICY)
  assert.deepEqual(parseRuntimeQueuePolicy('{"maxActive":20,"maxActivePerPrincipal":4}'), { maxActive: 20, maxActivePerPrincipal: 4 })
  assert.throws(() => parseRuntimeQueuePolicy('{"maxActive":1,"maxActivePerPrincipal":2}'), /invalid/)
})

test("queue execution can request delayed redelivery", async () => {
  const message = delivery("alpha", "operation", id(1))
  await dispatchQueueBatch([message], (body) => body as ReturnType<typeof runtimeQueueMessage>, async (_site, lane) => lane[0], async () => ({ retryAfterSeconds: 30 }))
  assert.equal(message.result, "retry")
  assert.equal(message.delaySeconds, 30)
})
