import { safeArtifactRelativePath } from "./artifact-paths.js"
import type { AgentTaskRunArtifactRef, AgentTaskRunResultSummary } from "./agent-task-run-result.js"
import { stripUndefined } from "./object-utils.js"

export const WORKSPACE_DELTA_SCHEMA = "wp-codebox/workspace-delta/v1" as const

export interface WorkspaceDeltaArtifactRef {
  kind: "codebox-changed-files" | "codebox-patch"
  path: string
  sha256?: string
  size_bytes?: number
}

export interface WorkspaceDeltaDiagnostic extends Record<string, unknown> {
  code: "workspace_delta.artifact_not_portable" | "workspace_delta.incomplete"
  message: string
}

export interface WorkspaceDelta {
  schema: typeof WORKSPACE_DELTA_SCHEMA
  status: "changed" | "no_op" | "unavailable"
  changed_files_count?: number
  patch_bytes?: number
  changed_files?: WorkspaceDeltaArtifactRef
  patch?: WorkspaceDeltaArtifactRef
  diagnostics: WorkspaceDeltaDiagnostic[]
}

export const WORKSPACE_DELTA_JSON_SCHEMA = {
  $id: WORKSPACE_DELTA_SCHEMA,
  type: "object",
  required: ["schema", "status", "diagnostics"],
  additionalProperties: false,
  properties: {
    schema: { const: WORKSPACE_DELTA_SCHEMA },
    status: { enum: ["changed", "no_op", "unavailable"] },
    changed_files_count: { type: "integer", minimum: 0 },
    patch_bytes: { type: "integer", minimum: 0 },
    changed_files: workspaceDeltaArtifactJsonSchema("codebox-changed-files"),
    patch: workspaceDeltaArtifactJsonSchema("codebox-patch"),
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        required: ["code", "message"],
        additionalProperties: false,
        properties: {
          code: { enum: ["workspace_delta.artifact_not_portable", "workspace_delta.incomplete"] },
          message: { type: "string" },
        },
      },
    },
  },
} as const

/**
 * Produces the Codebox-owned change handoff. Consumers apply it; Codebox never
 * exposes the sandbox's host paths as part of that handoff.
 */
export function workspaceDeltaFromAgentTaskRunResult(result: AgentTaskRunResultSummary): WorkspaceDelta {
  const changedFiles = portableWorkspaceArtifact(result.refs.changed_files[0], "codebox-changed-files")
  const patch = portableWorkspaceArtifact(result.refs.patches[0], "codebox-patch")
  const diagnostics: WorkspaceDeltaDiagnostic[] = []

  for (const artifact of [changedFiles, patch]) {
    if (artifact.diagnostic) diagnostics.push(artifact.diagnostic)
  }

  if (result.no_op.detected) {
    return { schema: WORKSPACE_DELTA_SCHEMA, status: "no_op", changed_files_count: 0, patch_bytes: 0, diagnostics }
  }

  if (!changedFiles.ref || !patch.ref) {
    diagnostics.push({
      code: "workspace_delta.incomplete",
      message: "Workspace delta requires portable changed-files and patch artifacts.",
    })
    return { schema: WORKSPACE_DELTA_SCHEMA, status: "unavailable", diagnostics }
  }

  return stripUndefined({
    schema: WORKSPACE_DELTA_SCHEMA,
    status: "changed" as const,
    changed_files_count: nonNegativeInteger(result.no_op.changed_files_count),
    patch_bytes: nonNegativeInteger(result.no_op.patch_bytes),
    changed_files: changedFiles.ref,
    patch: patch.ref,
    diagnostics,
  }) as WorkspaceDelta
}

function portableWorkspaceArtifact(artifact: AgentTaskRunArtifactRef | undefined, kind: WorkspaceDeltaArtifactRef["kind"]): { ref?: WorkspaceDeltaArtifactRef; diagnostic?: WorkspaceDeltaDiagnostic } {
  if (!artifact?.path) return {}

  try {
    const path = artifact.path.trim().replace(/\\/g, "/")
    if (path.startsWith("/") || /^[A-Za-z]:($|\/)/.test(path)) {
      throw new Error("Workspace delta artifact paths must be relative.")
    }
    return {
      ref: stripUndefined({
        kind,
        path: safeArtifactRelativePath(path),
        sha256: artifact.sha256,
        size_bytes: nonNegativeInteger(artifact.size_bytes),
      }) as WorkspaceDeltaArtifactRef,
    }
  } catch {
    return {
      diagnostic: {
        code: "workspace_delta.artifact_not_portable",
        message: `Codebox emitted a non-portable ${kind} artifact reference.`,
      },
    }
  }
}

function workspaceDeltaArtifactJsonSchema(kind: WorkspaceDeltaArtifactRef["kind"]) {
  return {
    type: "object",
    required: ["kind", "path"],
    additionalProperties: false,
    properties: {
      kind: { const: kind },
      path: { type: "string", minLength: 1 },
      sha256: { type: "string", minLength: 1 },
      size_bytes: { type: "integer", minimum: 0 },
    },
  }
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}
