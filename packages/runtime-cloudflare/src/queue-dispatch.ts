import type { SiteContext } from "./site-context.js"

export const RUNTIME_QUEUE_MESSAGE_SCHEMA = "wp-codebox/runtime-dispatch/v1"
export const RUNTIME_QUEUE_MAX_ATTEMPTS = 3

/** Queue messages wake durable work; they never own canonical state. */
export type RuntimeQueueMessage = { schema: typeof RUNTIME_QUEUE_MESSAGE_SCHEMA; siteId: string; generation: number; kind: "operation" | "publication"; identity: string }

export function runtimeQueueMessage(site: Pick<SiteContext, "id">, generation: number, kind: RuntimeQueueMessage["kind"], identity: string): RuntimeQueueMessage {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(site.id) || !Number.isSafeInteger(generation) || generation < 1 || !identity || identity.length > 1024) throw new Error("Runtime queue dispatch identity is invalid.")
  return { schema: RUNTIME_QUEUE_MESSAGE_SCHEMA, siteId: site.id, generation, kind, identity }
}

export function parseRuntimeQueueMessage(value: unknown): RuntimeQueueMessage | null {
  if (!value || typeof value !== "object") return null
  const message = value as Partial<RuntimeQueueMessage>
  if (message.schema !== RUNTIME_QUEUE_MESSAGE_SCHEMA || (message.kind !== "operation" && message.kind !== "publication") || typeof message.siteId !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(message.siteId) || !Number.isSafeInteger(message.generation) || message.generation! < 1 || typeof message.identity !== "string" || !message.identity || message.identity.length > 1024) return null
  return message as RuntimeQueueMessage
}

export interface RuntimeQueue { send(message: RuntimeQueueMessage): Promise<void> }
