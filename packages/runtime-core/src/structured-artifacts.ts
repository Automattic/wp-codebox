import { isPlainObject } from "./object-utils.js"

export const STRUCTURED_ARTIFACT_SCHEMA = "wp-codebox/structured-artifact/v1" as const
export const STRUCTURED_ARTIFACT_INDEX_SCHEMA = "wp-codebox/structured-artifacts-index/v1" as const

export type StructuredArtifactDirection = "input" | "output"

export interface StructuredArtifactPayload {
  schema: typeof STRUCTURED_ARTIFACT_SCHEMA
  name: string
  type: string
  payload_schema?: string | Record<string, unknown>
  payload: unknown
  metadata: Record<string, unknown>
  provenance: {
    direction: StructuredArtifactDirection
    source?: string
  }
}

export interface StructuredArtifactRef extends StructuredArtifactPayload {
  artifact?: {
    path: string
    kind: "structured-artifact"
    contentType: "application/json"
    sha256: string
  }
}

export interface StructuredArtifactIndex {
  schema: typeof STRUCTURED_ARTIFACT_INDEX_SCHEMA
  direction: StructuredArtifactDirection
  artifacts: StructuredArtifactRef[]
}

export function normalizeStructuredArtifacts(value: unknown, direction: StructuredArtifactDirection): StructuredArtifactPayload[] {
  const entries = Array.isArray(value) ? value : []
  return entries.flatMap((entry): StructuredArtifactPayload[] => {
    if (!isPlainObject(entry)) return []

    const name = stringValue(entry.name)
    const type = stringValue(entry.type)
    if (!name || !type) return []

    const metadata = isPlainObject(entry.metadata) ? entry.metadata : {}
    const provenance = isPlainObject(entry.provenance) ? entry.provenance : {}
    const payloadSchema = structuredPayloadSchema(entry.payload_schema ?? entry.payloadSchema ?? entry.artifact_schema ?? entry.artifactSchema)

    return [{
      schema: STRUCTURED_ARTIFACT_SCHEMA,
      name,
      type,
      ...(payloadSchema !== undefined ? { payload_schema: payloadSchema } : {}),
      payload: entry.payload,
      metadata,
      provenance: {
        ...provenance,
        direction,
        ...(typeof provenance.source === "string" && provenance.source.trim() ? { source: provenance.source.trim() } : {}),
      },
    }]
  })
}

function structuredPayloadSchema(value: unknown): string | Record<string, unknown> | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (isPlainObject(value)) return value
  return undefined
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
