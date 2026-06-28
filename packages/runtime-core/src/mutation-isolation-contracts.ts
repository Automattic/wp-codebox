import { createHash } from "node:crypto"

import { stripUndefined } from "./object-utils.js"

export const MUTATION_ISOLATION_ARTIFACT_SCHEMA = "wp-codebox/mutation-isolation-artifact/v1" as const
export const DELETE_BOUNDARY_ARTIFACT_SCHEMA = "wp-codebox/delete-boundary-artifact/v1" as const
export const WORDPRESS_ROLLBACK_ARTIFACT_SCHEMA = "wp-codebox/wordpress-rollback-artifact/v1" as const
export const MUTATION_ISOLATION_ARTIFACT_KIND = "mutation-isolation" as const
export const DELETE_BOUNDARY_ARTIFACT_KIND = "delete-boundary" as const
export const WORDPRESS_ROLLBACK_ARTIFACT_KIND = "wordpress-rollback" as const

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
  rollback?: WordPressRollbackArtifact
  affectedIdentifiers?: MutationAffectedIdentifier[]
  artifactKind: typeof MUTATION_ISOLATION_ARTIFACT_KIND
  artifactPath?: string
  sha256?: string
  bytes?: number
  generatedAt: string
  metadata?: Record<string, unknown>
}

export interface DeleteBoundaryArtifact extends Omit<MutationIsolationArtifact, "schema" | "artifactKind"> {
  schema: typeof DELETE_BOUNDARY_ARTIFACT_SCHEMA
  artifactKind: typeof DELETE_BOUNDARY_ARTIFACT_KIND
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

export type WordPressRollbackLifecycleStatus = "captured" | "restored" | "failed" | "unsupported" | (string & {})

export interface WordPressRollbackArtifact {
  schema: typeof WORDPRESS_ROLLBACK_ARTIFACT_SCHEMA
  artifactKind: typeof WORDPRESS_ROLLBACK_ARTIFACT_KIND
  operation: MutationIsolationOperation
  target: string
  lifecycle: {
    before: WordPressRollbackCaptureEvidence
    after: WordPressRollbackCaptureEvidence
    restore: WordPressRollbackCaptureEvidence
  }
  result: {
    status: MutationRestoreStatus
    restored: boolean
    validation: "matched-before" | "mismatch" | "not-validated" | (string & {})
  }
  diff: {
    options?: WordPressRollbackOptionDiff[]
    tables?: WordPressRollbackTableDiff[]
    objects?: WordPressRollbackObjectDiff[]
  }
  changedOptions?: string[]
  changedTables?: string[]
  changedObjects?: MutationAffectedIdentifier[]
  diagnostics?: Array<{ severity: "error" | "warning" | "info"; code: string; message: string; metadata?: Record<string, unknown> }>
  generatedAt: string
  metadata?: Record<string, unknown>
}

export interface WordPressRollbackCaptureEvidence extends MutationIsolationStepEvidence {
  capture?: Record<string, unknown>
}

export interface WordPressRollbackOptionDiff {
  name: string
  changed: boolean
  before?: unknown
  after?: unknown
  restored?: unknown
  restoreMatchesBefore: boolean
}

export interface WordPressRollbackTableDiff {
  table: string
  changed: boolean
  before?: unknown
  after?: unknown
  restored?: unknown
  restoreMatchesBefore: boolean
}

export interface WordPressRollbackObjectDiff {
  kind: string
  id?: string | number
  changed: boolean
  before?: unknown
  after?: unknown
  restored?: unknown
  restoreMatchesBefore: boolean
}

export function isRestMutationMethod(method: unknown): boolean {
  return typeof method === "string" && ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())
}

export function mutationIsolationArtifact(input: Omit<MutationIsolationArtifact, "schema" | "artifactKind" | "generatedAt"> & { generatedAt?: string }): MutationIsolationArtifact {
  return stripUndefined({
    schema: MUTATION_ISOLATION_ARTIFACT_SCHEMA as typeof MUTATION_ISOLATION_ARTIFACT_SCHEMA,
    artifactKind: MUTATION_ISOLATION_ARTIFACT_KIND,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...input,
    method: input.method.toUpperCase(),
  }) as MutationIsolationArtifact
}

export function deleteBoundaryArtifact(input: Omit<DeleteBoundaryArtifact, "schema" | "artifactKind" | "generatedAt"> & { generatedAt?: string }): DeleteBoundaryArtifact {
  return stripUndefined({
    schema: DELETE_BOUNDARY_ARTIFACT_SCHEMA as typeof DELETE_BOUNDARY_ARTIFACT_SCHEMA,
    artifactKind: DELETE_BOUNDARY_ARTIFACT_KIND,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...input,
    method: input.method.toUpperCase(),
  }) as DeleteBoundaryArtifact
}

export function wordpressRollbackArtifact(input: Omit<WordPressRollbackArtifact, "schema" | "artifactKind" | "generatedAt"> & { generatedAt?: string }): WordPressRollbackArtifact {
  return stripUndefined({
    schema: WORDPRESS_ROLLBACK_ARTIFACT_SCHEMA as typeof WORDPRESS_ROLLBACK_ARTIFACT_SCHEMA,
    artifactKind: WORDPRESS_ROLLBACK_ARTIFACT_KIND,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...input,
  }) as WordPressRollbackArtifact
}

export function mutationArtifactDigest(artifact: MutationIsolationArtifact | DeleteBoundaryArtifact): string {
  return createHash("sha256").update(`${JSON.stringify(artifact)}\n`).digest("hex")
}
