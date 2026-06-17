import { createHmac, timingSafeEqual } from "node:crypto"
import { browserArtifactPersistenceProjection, normalizeMaterializationResultEnvelope, type MaterializationArtifactRef, type MaterializationResultEnvelope } from "./materialization-contracts.js"

export const BROWSER_CALLBACK_RESULT_SCHEMA = "wp-codebox/browser-callback-result/v1" as const
export const BROWSER_CALLBACK_SIGNATURE_ALGORITHM = "sha256" as const

export interface BrowserCallbackCapabilityInput {
  capability: string
  ability: string
  caller: string
  scope: string
  allowedOrigins?: string[]
  signatureHeader?: string
  timestampHeader?: string
  maxAgeSeconds?: number
  metadata?: Record<string, unknown>
}

export interface BrowserCallbackCapability {
  schema: "wp-codebox/browser-callback-capability/v1"
  capability: string
  ability: string
  authorization: {
    schema: "wp-codebox/trusted-orchestrator-authorization/v1"
    caller: string
    scope: string
  }
  allowedOrigins: string[]
  signatureHeader: string
  timestampHeader: string
  maxAgeSeconds: number
  metadata?: Record<string, unknown>
}

export interface BrowserCallbackResultInput {
  capability: string
  ability: string
  result: unknown
  task?: string
  materialization?: unknown
}

export interface BrowserCallbackResultEnvelope {
  schema: typeof BROWSER_CALLBACK_RESULT_SCHEMA
  success: true
  capability: string
  ability: string
  result: unknown
  materialization: MaterializationResultEnvelope
  artifactRefs: MaterializationArtifactRef[]
}

export function browserCallbackCapability(input: BrowserCallbackCapabilityInput): BrowserCallbackCapability {
  const capability = requiredString(input.capability, "capability")
  const ability = requiredString(input.ability, "ability")
  const caller = requiredString(input.caller, "caller")
  const scope = requiredString(input.scope, "scope")
  return stripUndefined({
    schema: "wp-codebox/browser-callback-capability/v1" as const,
    capability,
    ability,
    authorization: {
      schema: "wp-codebox/trusted-orchestrator-authorization/v1" as const,
      caller,
      scope,
    },
    allowedOrigins: normalizeOrigins(input.allowedOrigins),
    signatureHeader: optionalString(input.signatureHeader) ?? "x-wp-codebox-callback-signature",
    timestampHeader: optionalString(input.timestampHeader) ?? "x-wp-codebox-callback-timestamp",
    maxAgeSeconds: input.maxAgeSeconds ?? 300,
    metadata: input.metadata,
  })
}

export function browserCallbackSignature(body: string, secret: string, timestamp?: string): string {
  const key = requiredString(secret, "secret")
  const signedPayload = timestamp && timestamp.trim() ? `${timestamp.trim()}.${body}` : body
  return `${BROWSER_CALLBACK_SIGNATURE_ALGORITHM}=${createHmac(BROWSER_CALLBACK_SIGNATURE_ALGORITHM, key).update(signedPayload).digest("hex")}`
}

export function verifyBrowserCallbackSignature(input: { body: string; secret: string; signature: string; timestamp?: string }): boolean {
  const expected = browserCallbackSignature(input.body, input.secret, input.timestamp)
  const actual = input.signature.trim()
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
}

export function browserCallbackResultEnvelope(input: BrowserCallbackResultInput): BrowserCallbackResultEnvelope {
  const materialization = normalizeMaterializationResultEnvelope(input.materialization ?? {
    response: {
      schema: "wp-codebox/materialization-result/v1",
      task: input.task ?? input.ability,
      success: true,
      response: {
        success: true,
        result: input.result,
      },
    },
  })
  const projection = browserArtifactPersistenceProjection(materialization)

  return {
    schema: BROWSER_CALLBACK_RESULT_SCHEMA,
    success: true,
    capability: requiredString(input.capability, "capability"),
    ability: requiredString(input.ability, "ability"),
    result: input.result,
    materialization,
    artifactRefs: projection.artifactRefs,
  }
}

function normalizeOrigins(origins: string[] | undefined): string[] {
  return [...new Set((origins ?? []).map((origin) => new URL(origin).origin))]
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new Error(`Browser callback ${field} is required`)
  }
  return normalized
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
