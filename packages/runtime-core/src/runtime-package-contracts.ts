import { isPlainObject, normalizeJsonValue, stringList, stringValue, stripUndefined } from "./object-utils.js"
import { normalizeRuntimePackageArtifactDeclarations, normalizeRuntimePackageOutputProjections, RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA, type RuntimePackageArtifactDeclaration, type RuntimePackageOutputProjection } from "./runtime-package-execution.js"

export const RUNTIME_PACKAGE_TASK_SCHEMA = "wp-codebox/runtime-package-task/v1" as const
export const RUNTIME_PACKAGE_RESULT_SCHEMA = "wp-codebox/runtime-package-result/v1" as const
export const RUNTIME_PACKAGE_DIAGNOSTIC_SCHEMA = "wp-codebox/runtime-package-diagnostic/v1" as const

export type RuntimePackageDiagnosticSeverity = "info" | "warning" | "error"
export type RuntimePackageResultStatus = "success" | "failed"

export interface RuntimePackageDescriptor {
  slug: string
  source: string
  external_source?: RuntimePackageExternalSource
}

export interface RuntimePackageExternalSource {
  repository: string
  revision: string
  path: string
  digest: string
}

export interface RuntimePackageWorkflowDescriptor {
  id?: string
  spec?: Record<string, unknown>
}

export interface RuntimePackageDiagnostic {
  schema: typeof RUNTIME_PACKAGE_DIAGNOSTIC_SCHEMA
  code: string
  message: string
  severity: RuntimePackageDiagnosticSeverity
  path?: string
  details?: Record<string, unknown>
}

export interface RuntimePackageTask {
  schema: typeof RUNTIME_PACKAGE_TASK_SCHEMA
  package: RuntimePackageDescriptor
  workflow?: RuntimePackageWorkflowDescriptor
  input: Record<string, unknown>
  artifact_declarations: RuntimePackageArtifactDeclaration[]
  output_projections: RuntimePackageOutputProjection[]
  required_artifacts: string[]
  metadata: Record<string, unknown>
}

export interface RuntimePackageResultArtifact {
  name: string
  type?: string
  path?: string
  contentType?: string
  payload?: unknown
  metadata?: Record<string, unknown>
}

export interface RuntimePackageResult {
  schema: typeof RUNTIME_PACKAGE_RESULT_SCHEMA
  status: RuntimePackageResultStatus
  success: boolean
  package?: RuntimePackageDescriptor
  outputs: Record<string, unknown>
  artifacts: RuntimePackageResultArtifact[]
  diagnostics: RuntimePackageDiagnostic[]
  metadata: Record<string, unknown>
}

export interface RuntimePackageTaskOptions {
  package?: unknown
  workflow?: unknown
  input?: unknown
  artifact_declarations?: unknown
  output_projections?: unknown
  required_artifacts?: unknown
  metadata?: unknown
  workspaceRoot?: string
}

export interface RuntimePackageTaskValidationResult {
  valid: boolean
  task?: RuntimePackageTask
  diagnostics: RuntimePackageDiagnostic[]
}

export function normalizeRuntimePackageTask(options: RuntimePackageTaskOptions): RuntimePackageTask {
  const metadata = isPlainObject(options.metadata) ? options.metadata : {}
  const descriptor = runtimePackageDescriptor(options.package)
  const packageSlug = stringValue(descriptor.slug)
  if (!packageSlug) {
    throw new Error("normalizeRuntimePackageTask requires package.slug")
  }

  const normalizedPackage = stripUndefined({
    slug: packageSlug,
    source: normalizePackageSource(stringValue(descriptor.source), options.workspaceRoot),
    external_source: runtimePackageExternalSource(descriptor.external_source),
  })

  return stripUndefined({
    schema: RUNTIME_PACKAGE_TASK_SCHEMA,
    package: normalizedPackage,
    workflow: runtimePackageWorkflow(options.workflow, normalizedPackage.slug),
    input: isPlainObject(options.input) ? options.input : {},
    artifact_declarations: normalizeRuntimePackageArtifactDeclarations(options.artifact_declarations),
    output_projections: normalizeRuntimePackageOutputProjections(options.output_projections),
    required_artifacts: runtimePackageRequiredArtifacts(options.required_artifacts, options.artifact_declarations),
    metadata,
  }) as RuntimePackageTask
}

function runtimePackageExternalSource(value: unknown): RuntimePackageExternalSource | undefined {
  if (!isPlainObject(value)) return undefined
  const repository = stringValue(value.repository)
  const revision = stringValue(value.revision)
  const path = stringValue(value.path)
  const digest = stringValue(value.digest)
  return repository && revision && path && digest ? { repository, revision, path, digest } : undefined
}

export function validateRuntimePackageTask(value: unknown): RuntimePackageTaskValidationResult {
  const diagnostics: RuntimePackageDiagnostic[] = []
  if (!isPlainObject(value)) {
    return { valid: false, diagnostics: [runtimePackageDiagnostic("invalid_task", "Runtime package task must be an object.")] }
  }

  if (value.schema !== RUNTIME_PACKAGE_TASK_SCHEMA) {
    diagnostics.push(runtimePackageDiagnostic("invalid_schema", `Runtime package task schema must be ${RUNTIME_PACKAGE_TASK_SCHEMA}.`, { path: "schema" }))
  }
  if (!isPlainObject(value.package)) {
    diagnostics.push(runtimePackageDiagnostic("missing_package", "Runtime package task requires package.", { path: "package" }))
  } else {
    if (!stringValue(value.package.slug)) {
      diagnostics.push(runtimePackageDiagnostic("missing_package_slug", "Runtime package task requires package.slug.", { path: "package.slug" }))
    }
    if (!stringValue(value.package.source)) {
      diagnostics.push(runtimePackageDiagnostic("missing_package_source", "Runtime package task requires package.source.", { path: "package.source" }))
    }
  }
  if (!isPlainObject(value.workflow) || !stringValue(value.workflow.id)) {
    diagnostics.push(runtimePackageDiagnostic("missing_workflow_id", "Runtime package task requires workflow.id.", { path: "workflow.id" }))
  }
  if (!isPlainObject(value.input)) {
    diagnostics.push(runtimePackageDiagnostic("missing_input", "Runtime package task requires input object.", { path: "input" }))
  }
  if (!Array.isArray(value.artifact_declarations)) {
    diagnostics.push(runtimePackageDiagnostic("missing_artifact_declarations", "Runtime package task requires artifact_declarations array.", { path: "artifact_declarations" }))
  }
  if (!Array.isArray(value.required_artifacts)) {
    diagnostics.push(runtimePackageDiagnostic("missing_required_artifacts", "Runtime package task requires required_artifacts array.", { path: "required_artifacts" }))
  }
  if (isPlainObject(value.package) && stringValue(value.package.source) && isWorkspaceRelativePackageSource(stringValue(value.package.source))) {
    diagnostics.push(runtimePackageDiagnostic("workspace_root_required", "Workspace-relative package.source requires explicit workspace root normalization before execution.", { path: "package.source" }))
  }

  const task = diagnostics.length === 0 ? value as unknown as RuntimePackageTask : undefined
  return { valid: diagnostics.length === 0, task, diagnostics }
}

export function normalizeRuntimePackageResult(value: unknown): RuntimePackageResult {
  const record = isPlainObject(value) ? value : {}
  const diagnostics = normalizeRuntimePackageDiagnostics(record.diagnostics)
  const failed = record.status === "failed" || record.success === false || diagnostics.some((diagnostic) => diagnostic.severity === "error")
  return {
    schema: RUNTIME_PACKAGE_RESULT_SCHEMA,
    status: failed ? "failed" : "success",
    success: !failed,
    package: isPlainObject(record.package) ? runtimePackageDescriptor(record.package) : undefined,
    outputs: isPlainObject(record.outputs) ? record.outputs : semanticOutputs(record),
    artifacts: normalizeRuntimePackageResultArtifacts(record.artifacts),
    diagnostics,
    metadata: isPlainObject(record.metadata) ? record.metadata : {},
  }
}

export function runtimePackageImportFailureResult(packageDescriptor: RuntimePackageDescriptor, error: unknown): RuntimePackageResult {
  return normalizeRuntimePackageResult({
    status: "failed",
    success: false,
    package: packageDescriptor,
    diagnostics: [runtimePackageDiagnostic("runtime_package_import_failed", "Runtime package import failed.", { details: { error: normalizeJsonValue(error) as Record<string, unknown> } })],
  })
}

function runtimePackageDescriptor(value: unknown): RuntimePackageDescriptor {
  const record = isPlainObject(value) ? value : undefined
  if (record) {
    return { slug: stringValue(record.slug), source: stringValue(record.source) }
  }
  return { slug: "", source: "" }
}

function runtimePackageWorkflow(value: unknown, fallbackId: string): RuntimePackageWorkflowDescriptor | undefined {
  if (isPlainObject(value) && (stringValue(value.id) || isPlainObject(value.spec))) {
    return stripUndefined({ id: stringValue(value.id) || undefined, spec: isPlainObject(value.spec) ? value.spec : undefined })
  }
  return fallbackId ? { id: fallbackId } : undefined
}

function runtimePackageRequiredArtifacts(value: unknown, declarations: unknown): string[] {
  const explicit = stringList(value)
  if (explicit.length > 0) return explicit
  return normalizeRuntimePackageArtifactDeclarations(declarations)
    .filter((artifact) => artifact.direction !== "input" && artifact.required === true)
    .map((artifact) => artifact.name)
}

function normalizePackageSource(source: string, workspaceRoot?: string): string | undefined {
  if (!source) return undefined
  if (!isWorkspaceRelativePackageSource(source)) return source
  const root = stringValue(workspaceRoot)
  return root ? `${root.replace(/[\\/]+$/, "")}/${source.replace(/^[\\/]+/, "")}` : source
}

function isWorkspaceRelativePackageSource(source: string): boolean {
  return source !== "" && isPathLikePackageSource(source) && !isAbsolutePackageSource(source)
}

function isPathLikePackageSource(source: string): boolean {
  return source.includes("/") || source.includes("\\") || isAbsolutePackageSource(source)
}

function isAbsolutePackageSource(source: string): boolean {
  return source.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(source) || /^[A-Za-z]:[\\/]/.test(source)
}

function runtimePackageSlug(runtimePackage: string): string {
  const normalized = runtimePackage.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized.split("/").pop() || runtimePackage
}

function normalizeRuntimePackageDiagnostics(value: unknown): RuntimePackageDiagnostic[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => isPlainObject(entry) ? [runtimePackageDiagnostic(stringValue(entry.code) || "runtime_package_diagnostic", stringValue(entry.message) || "Runtime package diagnostic.", {
    severity: entry.severity === "info" || entry.severity === "warning" || entry.severity === "error" ? entry.severity : undefined,
    path: stringValue(entry.path) || undefined,
    details: isPlainObject(entry.details) ? entry.details : undefined,
  })] : [])
}

function normalizeRuntimePackageResultArtifacts(value: unknown): RuntimePackageResultArtifact[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isPlainObject(entry)) return []
    const name = stringValue(entry.name)
    if (!name) return []
    return [stripUndefined({
      name,
      type: stringValue(entry.type) || undefined,
      path: stringValue(entry.path) || undefined,
      contentType: stringValue(entry.contentType ?? entry.content_type) || undefined,
      payload: entry.payload,
      metadata: isPlainObject(entry.metadata) ? entry.metadata : undefined,
    })]
  })
}

function semanticOutputs(record: Record<string, unknown>): Record<string, unknown> {
  const outputs: Record<string, unknown> = {}
  for (const key of ["result", "summary", "data", "semantic_outputs", "structured_outputs"]) {
    if (key in record) outputs[key] = record[key]
  }
  return outputs
}

function runtimePackageDiagnostic(code: string, message: string, options: { severity?: RuntimePackageDiagnosticSeverity, path?: string, details?: Record<string, unknown> } = {}): RuntimePackageDiagnostic {
  return stripUndefined({
    schema: RUNTIME_PACKAGE_DIAGNOSTIC_SCHEMA,
    code,
    message,
    severity: options.severity ?? "error",
    path: options.path,
    details: options.details,
  }) as RuntimePackageDiagnostic
}

export const RUNTIME_PACKAGE_TASK_JSON_SCHEMA = {
  $id: RUNTIME_PACKAGE_TASK_SCHEMA,
  type: "object",
  required: ["schema", "package", "workflow", "input", "artifact_declarations", "required_artifacts"],
  properties: {
    schema: { const: RUNTIME_PACKAGE_TASK_SCHEMA },
    package: { type: "object", required: ["slug", "source"], properties: { slug: { type: "string", minLength: 1 }, source: { type: "string", minLength: 1 } } },
    workflow: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 }, spec: { type: "object" } } },
    input: { type: "object" },
    artifact_declarations: { type: "array", items: { $ref: RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA } },
    required_artifacts: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const

export const RUNTIME_PACKAGE_RESULT_JSON_SCHEMA = {
  $id: RUNTIME_PACKAGE_RESULT_SCHEMA,
  type: "object",
  required: ["schema", "status", "success", "outputs", "artifacts", "diagnostics"],
  properties: {
    schema: { const: RUNTIME_PACKAGE_RESULT_SCHEMA },
    status: { enum: ["success", "failed"] },
    success: { type: "boolean" },
    artifacts: { type: "array" },
    diagnostics: { type: "array" },
  },
} as const
