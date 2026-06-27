import { createHash } from "node:crypto"

import { stripUndefined } from "./object-utils.js"

export const MUTATION_ISOLATION_ARTIFACT_SCHEMA = "wp-codebox/mutation-isolation-artifact/v1" as const
export const DELETE_BOUNDARY_ARTIFACT_SCHEMA = "wp-codebox/delete-boundary-artifact/v1" as const

export type MutationIsolationOperation = "rest_request" | (string & {})
export type MutationRestoreStatus = "passed" | "failed" | "unsupported" | "not-required" | (string & {})

export interface MutationIsolationArtifact {
  schema: typeof MUTATION_ISOLATION_ARTIFACT_SCHEMA
  operation: MutationIsolationOperation
  target: string
  method: string
  status?: number
  checkpointName?: string
  beforeCheckpoint?: MutationIsolationStepEvidence
  afterObservation?: MutationIsolationStepEvidence
  restore?: MutationRestoreEvidence
  affectedIdentifiers?: MutationAffectedIdentifier[]
  artifactKind: "mutation-isolation"
  artifactPath?: string
  sha256?: string
  bytes?: number
  generatedAt: string
  metadata?: Record<string, unknown>
}

export interface DeleteBoundaryArtifact extends Omit<MutationIsolationArtifact, "schema" | "artifactKind"> {
  schema: typeof DELETE_BOUNDARY_ARTIFACT_SCHEMA
  artifactKind: "delete-boundary"
}

export interface MutationIsolationStepEvidence {
  status: "created" | "observed" | "restored" | "failed" | (string & {})
  stepId?: string
  executionId?: string
  exitCode?: number
  command?: string
  artifactRefs?: MutationArtifactReference[]
}

export interface MutationRestoreEvidence extends MutationIsolationStepEvidence {
  status: MutationRestoreStatus
}

export interface MutationAffectedIdentifier {
  kind?: string
  id: string | number
  source?: string
}

export interface MutationArtifactReference {
  path: string
  kind: string
  sha256?: string
  bytes?: number
  name?: string
  metadata?: Record<string, unknown>
}

export function isRestMutationMethod(method: unknown): boolean {
  return typeof method === "string" && ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())
}

export function mutationIsolationArtifact(input: Omit<MutationIsolationArtifact, "schema" | "artifactKind" | "generatedAt"> & { generatedAt?: string }): MutationIsolationArtifact {
  return stripUndefined({
    schema: MUTATION_ISOLATION_ARTIFACT_SCHEMA as typeof MUTATION_ISOLATION_ARTIFACT_SCHEMA,
    artifactKind: "mutation-isolation" as const,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...input,
    method: input.method.toUpperCase(),
  }) as MutationIsolationArtifact
}

export function deleteBoundaryArtifact(input: Omit<DeleteBoundaryArtifact, "schema" | "artifactKind" | "generatedAt"> & { generatedAt?: string }): DeleteBoundaryArtifact {
  return stripUndefined({
    schema: DELETE_BOUNDARY_ARTIFACT_SCHEMA as typeof DELETE_BOUNDARY_ARTIFACT_SCHEMA,
    artifactKind: "delete-boundary" as const,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...input,
    method: input.method.toUpperCase(),
  }) as DeleteBoundaryArtifact
}

export function mutationArtifactDigest(artifact: MutationIsolationArtifact | DeleteBoundaryArtifact): string {
  return createHash("sha256").update(`${JSON.stringify(artifact)}\n`).digest("hex")
}
