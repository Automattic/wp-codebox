import { createHash } from "node:crypto"

import { stripUndefined } from "./object-utils.js"

export const SANDBOX_ISOLATION_PROOF_SCHEMA = "wp-codebox/sandbox-isolation-proof/v1" as const
export const SANDBOX_ISOLATION_PROOF_ARTIFACT_KIND = "sandbox-isolation-proof" as const

export type SandboxIsolationProofStatus = "passed" | "failed"
export type SandboxIsolationProofLifecycleStatus = "created" | "mutated" | "restored" | "destroyed" | "discarded" | "failed"
export type SandboxIsolationProofDiffStatus = "clean-after-restore" | "dirty-after-restore" | "not-validated" | "not-required-disposable-sandbox"

export interface SandboxIsolationProofStepEvidence {
  status: SandboxIsolationProofLifecycleStatus
  command?: string
  stepId?: string
  executionId?: string
  exitCode?: number
  artifactRefs?: SandboxIsolationProofArtifactRef[]
  metadata?: Record<string, unknown>
}

export interface SandboxIsolationProofArtifactRef {
  path: string
  kind: string
  sha256?: string
  bytes?: number
  name?: string
  metadata?: Record<string, unknown>
}

export interface SandboxIsolationProofDiffEvidence {
  status: SandboxIsolationProofDiffStatus
  changed: boolean
  changedOptions?: string[]
  changedTables?: string[]
  changedObjects?: Array<{ kind: string; id?: string | number; source?: string }>
  restoreMismatches?: Array<{ kind: string; id: string; path?: string }>
  metadata?: Record<string, unknown>
}

export interface SandboxIsolationProofRuntimeBoundary {
  runtimeId?: string
  backend: string
  environment: "wordpress" | (string & {})
  disposable: true
  hostAccess: "declared-mounts-only"
  destroy: SandboxIsolationProofStepEvidence & { status: "destroyed" | "discarded" }
  metadata?: Record<string, unknown>
}

export interface SandboxIsolationProof {
  schema: typeof SANDBOX_ISOLATION_PROOF_SCHEMA
  artifactKind: typeof SANDBOX_ISOLATION_PROOF_ARTIFACT_KIND
  version: 1
  status: SandboxIsolationProofStatus
  baseline: SandboxIsolationProofStepEvidence & { status: "created" }
  mutation: SandboxIsolationProofStepEvidence & { status: "mutated" }
  restore?: SandboxIsolationProofStepEvidence & { status: "restored" | "failed" }
  diff?: SandboxIsolationProofDiffEvidence
  runtimeBoundary: SandboxIsolationProofRuntimeBoundary
  artifacts: SandboxIsolationProofArtifactRef[]
  generatedAt: string
  artifactPath?: string
  sha256?: string
  bytes?: number
  metadata?: Record<string, unknown>
}

export const SANDBOX_ISOLATION_PROOF_REQUIRED_ARTIFACT_FIELDS = [
  "schema",
  "artifactKind",
  "version",
  "status",
  "baseline",
  "mutation",
  "runtimeBoundary",
  "runtimeBoundary.destroy",
  "artifacts",
  "generatedAt",
] as const

export function sandboxIsolationProof(input: Omit<SandboxIsolationProof, "schema" | "artifactKind" | "version" | "generatedAt"> & { generatedAt?: string }): SandboxIsolationProof {
  assertSandboxIsolationProofInput(input)
  return stripUndefined({
    schema: SANDBOX_ISOLATION_PROOF_SCHEMA as typeof SANDBOX_ISOLATION_PROOF_SCHEMA,
    artifactKind: SANDBOX_ISOLATION_PROOF_ARTIFACT_KIND,
    version: 1 as const,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...input,
  }) as SandboxIsolationProof
}

export function sandboxIsolationProofDigest(proof: SandboxIsolationProof): string {
  return createHash("sha256").update(`${JSON.stringify(proof)}\n`).digest("hex")
}

function assertSandboxIsolationProofInput(input: Omit<SandboxIsolationProof, "schema" | "artifactKind" | "version" | "generatedAt"> & { generatedAt?: string }): void {
  if (input.baseline?.status !== "created") throw new Error("Sandbox isolation proof requires baseline.status=created")
  if (input.mutation?.status !== "mutated") throw new Error("Sandbox isolation proof requires mutation.status=mutated")
  if (input.restore && input.restore.status !== "restored" && input.restore.status !== "failed") throw new Error("Sandbox isolation proof restore.status must be restored or failed when restore evidence is supplied")
  if (!hasStepEvidence(input.baseline)) throw new Error("Sandbox isolation proof requires baseline command or execution evidence")
  if (!hasStepEvidence(input.mutation)) throw new Error("Sandbox isolation proof requires mutation command or execution evidence")
  if (input.restore && !hasStepEvidence(input.restore)) throw new Error("Sandbox isolation proof restore evidence requires command or execution evidence")
  if (input.diff && typeof input.diff.changed !== "boolean") throw new Error("Sandbox isolation proof diff evidence requires a changed boolean")
  if (!input.runtimeBoundary || input.runtimeBoundary.disposable !== true) throw new Error("Sandbox isolation proof requires a disposable runtime boundary")
  if (input.runtimeBoundary.hostAccess !== "declared-mounts-only") throw new Error("Sandbox isolation proof requires declared-mounts-only host access")
  if (input.runtimeBoundary.destroy?.status !== "destroyed" && input.runtimeBoundary.destroy?.status !== "discarded") throw new Error("Sandbox isolation proof requires runtimeBoundary.destroy.status destroyed or discarded")
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0) throw new Error("Sandbox isolation proof requires artifact refs")
  for (const artifact of input.artifacts) {
    if (!artifact.path || !artifact.kind) throw new Error("Sandbox isolation proof artifact refs require path and kind")
  }
}

function hasStepEvidence(step: SandboxIsolationProofStepEvidence | undefined): boolean {
  return Boolean(step?.command || step?.stepId || step?.executionId || step?.artifactRefs?.length)
}
