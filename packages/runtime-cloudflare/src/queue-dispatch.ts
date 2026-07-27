import type { SiteContext } from "./site-context.js"

export const RUNTIME_QUEUE_MESSAGE_SCHEMA = "wp-codebox/runtime-dispatch/v1"
export const RUNTIME_QUEUE_MAX_ATTEMPTS = 3
export const DEFAULT_RUNTIME_QUEUE_POLICY: RuntimeQueuePolicy = { maxActive: 100, maxActivePerPrincipal: 10 }

/** Queue messages wake durable work; they never own canonical state. */
export type RuntimeQueueMessage = { schema: typeof RUNTIME_QUEUE_MESSAGE_SCHEMA; siteId: string; generation: number; kind: "operation" | "publication"; identity: string }
export interface RuntimeQueuePolicy { maxActive: number; maxActivePerPrincipal: number }

const operationIdentity = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const publicationIdentity = /^sites\/([a-z0-9][a-z0-9-]{0,127})\/publications\/jobs\/[0-9]{20}-[a-f0-9-]{36}\.json$/

export function validRuntimeQueueIdentity(siteId: string, kind: RuntimeQueueMessage["kind"], identity: string): boolean {
  if (kind === "operation") return operationIdentity.test(identity)
  return publicationIdentity.test(identity) && publicationIdentity.exec(identity)?.[1] === siteId
}

export function runtimeQueueMessage(site: Pick<SiteContext, "id">, generation: number, kind: RuntimeQueueMessage["kind"], identity: string): RuntimeQueueMessage {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(site.id) || !Number.isSafeInteger(generation) || generation < 1 || !validRuntimeQueueIdentity(site.id, kind, identity)) throw new Error("Runtime queue dispatch identity is invalid.")
  return { schema: RUNTIME_QUEUE_MESSAGE_SCHEMA, siteId: site.id, generation, kind, identity }
}

export function parseRuntimeQueueMessage(value: unknown): RuntimeQueueMessage | null {
  if (!value || typeof value !== "object") return null
  const message = value as Partial<RuntimeQueueMessage>
  if (message.schema !== RUNTIME_QUEUE_MESSAGE_SCHEMA || (message.kind !== "operation" && message.kind !== "publication") || typeof message.siteId !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(message.siteId) || !Number.isSafeInteger(message.generation) || message.generation! < 1 || typeof message.identity !== "string" || !validRuntimeQueueIdentity(message.siteId, message.kind, message.identity)) return null
  return message as RuntimeQueueMessage
}

export interface RuntimeQueue { send(message: RuntimeQueueMessage): Promise<void> }

export function parseRuntimeQueuePolicy(value: string | undefined): RuntimeQueuePolicy {
  if (!value) return DEFAULT_RUNTIME_QUEUE_POLICY
  let policy: Partial<RuntimeQueuePolicy>
  try { policy = JSON.parse(value) as Partial<RuntimeQueuePolicy> } catch { throw new Error("Runtime queue policy is invalid.") }
  if (!Number.isSafeInteger(policy.maxActive) || !Number.isSafeInteger(policy.maxActivePerPrincipal)
    || policy.maxActive! < 1 || policy.maxActive! > 10_000 || policy.maxActivePerPrincipal! < 1 || policy.maxActivePerPrincipal! > policy.maxActive!) {
    throw new Error("Runtime queue policy is invalid.")
  }
  return policy as RuntimeQueuePolicy
}
