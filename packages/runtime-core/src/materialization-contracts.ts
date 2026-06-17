import type { RuntimeRunArtifactRef } from "./run-registry.js"

export interface MaterializationArtifactRef {
  kind: string
  path?: string
  id?: string
  digest?: {
    algorithm: "sha256" | (string & {})
    value: string
  }
}

export interface MaterializationPhaseResult {
  schema: "wp-codebox/materialization-phase-result/v1"
  phase: string
  status: "completed" | "failed" | "skipped"
  artifactRefs: MaterializationArtifactRef[]
  metadata?: Record<string, unknown>
  error?: {
    name: string
    message: string
    code?: string
  }
}

export function materializationPhaseResult(input: Omit<MaterializationPhaseResult, "schema" | "artifactRefs"> & { artifactRefs?: MaterializationArtifactRef[] }): MaterializationPhaseResult {
  return stripUndefined({
    schema: "wp-codebox/materialization-phase-result/v1" as const,
    ...input,
    artifactRefs: input.artifactRefs ?? [],
  })
}

export function materializationRunArtifactRefs(results: MaterializationPhaseResult[]): RuntimeRunArtifactRef[] {
  return results.flatMap((result) =>
    result.artifactRefs.map((ref) =>
      stripUndefined({
        kind: `materialization:${ref.kind}`,
        path: ref.path,
        id: ref.id,
        digest: ref.digest,
      }),
    ),
  )
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
