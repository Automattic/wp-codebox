import { commandArg, commandJsonArg } from "./command-codecs.js"
import type { WorkspaceRecipe, WorkspaceRecipeMount, WorkspaceRecipeRuntimeOverlay, WorkspaceRecipeStagedFile } from "./runtime-contracts.js"
import { DEFAULT_WORDPRESS_VERSION } from "./runtime-defaults.js"
import { isPlainObject, stringList, stringValue, stripUndefined } from "./object-utils.js"

export const CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY = "wp-codebox/run-runtime-package" as const
export const RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA = "wp-codebox/runtime-package-execution-input/v1" as const
export const RUNTIME_PACKAGE_EXECUTION_RESULT_SCHEMA = "wp-codebox/runtime-package-execution-result/v1" as const
export const RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA = "wp-codebox/runtime-package-artifact-declaration/v1" as const
export const RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA = "wp-codebox/runtime-package-output-projection/v1" as const

export type RuntimePackageArtifactDirection = "input" | "output"

export interface RuntimePackageArtifactDeclaration {
  schema?: typeof RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA
  name: string
  type: string
  direction?: RuntimePackageArtifactDirection
  required?: boolean
  path?: string
  contentType?: string
  payloadSchema?: string | Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface RuntimePackageOutputProjection {
  schema?: typeof RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA
  name: string
  source: string
  path?: string
  type?: string
  required?: boolean
  metadata?: Record<string, unknown>
}

export interface RuntimePackageExecutionInput {
  schema: typeof RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA
  runtime_package: string
  input: Record<string, unknown>
  expected_result_schema?: string | Record<string, unknown>
  artifact_declarations: RuntimePackageArtifactDeclaration[]
  output_projections: RuntimePackageOutputProjection[]
  metadata: Record<string, unknown>
}

export interface RuntimePackageRunRecipeOptions {
  runtimePackage: string
  input?: Record<string, unknown>
  expectedResultSchema?: string | Record<string, unknown>
  artifactDeclarations?: RuntimePackageArtifactDeclaration[]
  outputProjections?: RuntimePackageOutputProjection[]
  metadata?: Record<string, unknown>
  wordpressVersion?: string
  blueprint?: unknown
  mounts?: WorkspaceRecipeMount[]
  runtimeStackMounts?: WorkspaceRecipeMount[]
  runtimeOverlays?: WorkspaceRecipeRuntimeOverlay[]
  runtimeEnv?: Record<string, string | number | boolean>
  secretEnv?: string[]
  stagedFiles?: WorkspaceRecipeStagedFile[]
}

export function runtimePackageExecutionInput(options: RuntimePackageRunRecipeOptions): RuntimePackageExecutionInput {
  const runtimePackage = stringValue(options.runtimePackage)
  if (!runtimePackage) {
    throw new Error("runtimePackageExecutionInput requires runtimePackage")
  }

  return stripUndefined({
    schema: RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA,
    runtime_package: runtimePackage,
    input: isPlainObject(options.input) ? options.input : {},
    expected_result_schema: options.expectedResultSchema,
    artifact_declarations: normalizeRuntimePackageArtifactDeclarations(options.artifactDeclarations),
    output_projections: normalizeRuntimePackageOutputProjections(options.outputProjections),
    metadata: isPlainObject(options.metadata) ? options.metadata : {},
  })
}

export function buildRuntimePackageRunRecipe(options: RuntimePackageRunRecipeOptions): WorkspaceRecipe {
  const input = runtimePackageExecutionInput(options)

  return stripUndefined({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: stripUndefined({
      backend: "wordpress-playground",
      wp: options.wordpressVersion ?? DEFAULT_WORDPRESS_VERSION,
      blueprint: options.blueprint ?? { steps: [] },
      stack: Array.isArray(options.runtimeStackMounts) && options.runtimeStackMounts.length > 0 ? { mounts: options.runtimeStackMounts } : undefined,
      overlays: Array.isArray(options.runtimeOverlays) && options.runtimeOverlays.length > 0 ? options.runtimeOverlays : undefined,
    }),
    inputs: stripUndefined({
      mounts: Array.isArray(options.mounts) ? options.mounts : [],
      runtimeEnv: runtimeEnv(options.runtimeEnv),
      secretEnv: stringList(options.secretEnv),
      stagedFiles: Array.isArray(options.stagedFiles) && options.stagedFiles.length > 0 ? options.stagedFiles : undefined,
    }),
    workflow: {
      steps: [{
        command: "wordpress.ability",
        args: [
          commandArg("name", CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY),
          commandJsonArg("input", input),
          ...(input.expected_result_schema ? [commandJsonArg("expected-result-schema", input.expected_result_schema)] : []),
        ],
      }],
    },
  }) as WorkspaceRecipe
}

export function normalizeRuntimePackageArtifactDeclarations(value: unknown): RuntimePackageArtifactDeclaration[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry): RuntimePackageArtifactDeclaration[] => {
    if (!isPlainObject(entry)) return []
    const name = stringValue(entry.name)
    const type = stringValue(entry.type)
    if (!name || !type) return []
    const direction: RuntimePackageArtifactDirection = entry.direction === "input" ? "input" : "output"

    return [stripUndefined({
      schema: RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA,
      name,
      type,
      direction,
      required: typeof entry.required === "boolean" ? entry.required : undefined,
      path: stringValue(entry.path) || undefined,
      contentType: stringValue(entry.contentType ?? entry.content_type) || undefined,
      payloadSchema: payloadSchema(entry.payloadSchema ?? entry.artifact_schema),
      metadata: isPlainObject(entry.metadata) ? entry.metadata : {},
    })]
  })
}

export function normalizeRuntimePackageOutputProjections(value: unknown): RuntimePackageOutputProjection[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry): RuntimePackageOutputProjection[] => {
    if (!isPlainObject(entry)) return []
    const name = stringValue(entry.name)
    const source = stringValue(entry.source)
    if (!name || !source) return []

    return [stripUndefined({
      schema: RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA,
      name,
      source,
      path: stringValue(entry.path) || undefined,
      type: stringValue(entry.type) || undefined,
      required: typeof entry.required === "boolean" ? entry.required : undefined,
      metadata: isPlainObject(entry.metadata) ? entry.metadata : {},
    })]
  })
}

function runtimeEnv(value: RuntimePackageRunRecipeOptions["runtimeEnv"]): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined
  const entries = Object.entries(value)
    .map(([name, entry]) => [name.trim(), typeof entry === "boolean" ? (entry ? "1" : "") : String(entry)] as const)
    .filter(([name]) => /^[A-Z_][A-Z0-9_]*$/.test(name))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function payloadSchema(value: unknown): string | Record<string, unknown> | undefined {
  const schema = stringValue(value)
  if (schema) return schema
  if (isPlainObject(value)) return value
  return undefined
}
