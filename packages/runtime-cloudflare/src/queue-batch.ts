import type { RuntimeQueueMessage } from "./queue-dispatch.js"

export interface QueueDelivery { body: unknown; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void }
export interface ParsedQueueDelivery { raw: QueueDelivery; value: RuntimeQueueMessage }
export type QueueExecutionResult = "ack" | "retry" | { retryAfterSeconds: number }

/** One heavyweight turn per site keeps a delivery batch fair without cross-site serialization. */
export async function dispatchQueueBatch(
  deliveries: QueueDelivery[],
  parse: (body: unknown) => RuntimeQueueMessage | null,
  select: (siteId: string, deliveries: ParsedQueueDelivery[]) => Promise<ParsedQueueDelivery | null>,
  execute: (delivery: ParsedQueueDelivery) => Promise<QueueExecutionResult>,
): Promise<void> {
  const lanes = new Map<string, ParsedQueueDelivery[]>()
  for (const raw of deliveries) {
    const value = parse(raw.body)
    if (!value) { raw.ack(); continue }
    const lane = lanes.get(value.siteId) ?? []
    lane.push({ raw, value })
    lanes.set(value.siteId, lane)
  }
  await Promise.all([...lanes.entries()].map(async ([siteId, lane]) => {
    const selected = await select(siteId, lane)
    for (const delivery of lane) {
      if (delivery !== selected) delivery.raw.retry()
    }
    if (!selected) return
    const result = await execute(selected)
    if (result === "ack") selected.raw.ack()
    else if (result === "retry") selected.raw.retry()
    else selected.raw.retry({ delaySeconds: result.retryAfterSeconds })
  }))
}
