import { commandArg, commandJsonArg } from "./command-codecs.js"
import { DEFAULT_WORDPRESS_VERSION } from "./runtime-defaults.js"
import type { RuntimePreviewSpec, WorkspaceRecipe, WorkspaceRecipeMount, WorkspaceRecipeRuntimeOverlay, WorkspaceRecipeStagedFile, WorkspaceRecipeStep } from "./runtime-contracts.js"
import { isPlainObject, stripUndefined } from "./object-utils.js"
import { performanceObservationCaptureRequest, type PerformanceObservationCaptureRequest } from "./performance-observation.js"

export const WORDPRESS_WORKLOAD_RUN_SCHEMA = "wp-codebox/wordpress-workload-run/v1" as const
export const WORDPRESS_ABILITY_STEP_SCHEMA = "wp-codebox/wordpress-ability-step/v1" as const
export const PLAYGROUND_PREVIEW_URL_SCHEMA = "wp-codebox/playground-preview-url/v1" as const

export type PlaygroundPreviewUrlMode = "local" | "public" | "secure"

export interface WordPressAbilityStepOptions {
  name: string
  input?: Record<string, unknown>
  expectedResultSchema?: string | Record<string, unknown>
  allowFailure?: boolean
  advisory?: boolean
}

export interface WordPressWorkloadRunRecipeOptions {
  wordpressVersion?: string
  /** Local WordPress core source mounted at /wordpress before Playground starts. */
  wordpressDirectory?: string
  blueprint?: unknown
  preview?: RuntimePreviewSpec
  mounts?: WorkspaceRecipeMount[]
  runtimeStackMounts?: WorkspaceRecipeMount[]
  runtimeOverlays?: WorkspaceRecipeRuntimeOverlay[]
  runtimeEnv?: Record<string, string | number | boolean>
  secretEnv?: string[]
  stagedFiles?: WorkspaceRecipeStagedFile[]
  before?: WorkspaceRecipeStep[]
  steps: WorkspaceRecipeStep[]
  after?: WorkspaceRecipeStep[]
  metadata?: Record<string, unknown>
  capture?: PerformanceObservationCaptureRequest
  enableQueryCapture?: boolean
}

export interface PlaygroundPreviewUrlOptions {
  localUrl: string
  publicUrl?: string
  path?: string
  mode?: PlaygroundPreviewUrlMode
}

export interface PlaygroundPreviewUrlContract {
  schema: typeof PLAYGROUND_PREVIEW_URL_SCHEMA
  mode: PlaygroundPreviewUrlMode
  localUrl: string
  effectiveUrl: string
  publicUrl?: string
  diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>
}

export function wordpressAbilityStep(options: WordPressAbilityStepOptions): WorkspaceRecipeStep {
  const name = stringValue(options.name)
  if (!name) {
    throw new Error("wordpressAbilityStep requires name")
  }

  return stripUndefined({
    command: "wordpress.ability",
    args: [
      commandArg("name", name),
      commandJsonArg("input", isPlainObject(options.input) ? options.input : {}),
      ...(options.expectedResultSchema ? [commandJsonArg("expected-result-schema", options.expectedResultSchema)] : []),
    ],
    allowFailure: options.allowFailure,
    advisory: options.advisory,
  }) as WorkspaceRecipeStep
}

export function wordpressWorkloadRunRecipe(options: WordPressWorkloadRunRecipeOptions): WorkspaceRecipe {
  if (!Array.isArray(options.steps) || options.steps.length === 0) {
    throw new Error("wordpressWorkloadRunRecipe requires at least one step")
  }

  return stripUndefined({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: stripUndefined({
      backend: "wordpress-playground",
      wp: options.wordpressVersion ?? DEFAULT_WORDPRESS_VERSION,
      assets: options.wordpressDirectory ? { wordpressDirectory: options.wordpressDirectory } : undefined,
      blueprint: options.blueprint ?? { steps: [] },
      preview: options.preview,
      stack: Array.isArray(options.runtimeStackMounts) && options.runtimeStackMounts.length > 0 ? { mounts: options.runtimeStackMounts } : undefined,
      overlays: Array.isArray(options.runtimeOverlays) && options.runtimeOverlays.length > 0 ? options.runtimeOverlays : undefined,
    }),
    inputs: stripUndefined({
      mounts: Array.isArray(options.mounts) ? options.mounts : [],
      runtimeEnv: runtimeEnv(options.runtimeEnv),
      secretEnv: stringList(options.secretEnv),
      stagedFiles: Array.isArray(options.stagedFiles) && options.stagedFiles.length > 0 ? options.stagedFiles : undefined,
    }),
    workflow: stripUndefined({
      before: normalizeRecipeSteps(options.before),
      steps: normalizeRecipeSteps(options.steps),
      after: normalizeRecipeSteps(options.after),
    }),
    metadata: stripUndefined({
      ...options.metadata,
      public_contract: WORDPRESS_WORKLOAD_RUN_SCHEMA,
      capture: normalizedCapture(options),
    }),
  }) as WorkspaceRecipe
}

export const buildWordPressWorkloadRunRecipe = wordpressWorkloadRunRecipe

export function playgroundPreviewUrl(options: PlaygroundPreviewUrlOptions): PlaygroundPreviewUrlContract {
  const localUrl = normalizedHttpUrl(options.localUrl, "localUrl")
  const publicUrl = options.publicUrl ? normalizedHttpUrl(options.publicUrl, "publicUrl") : undefined
  const mode = options.mode ?? (publicUrl ? "public" : "local")
  if (mode !== "local" && mode !== "public" && mode !== "secure") {
    throw new Error(`playgroundPreviewUrl mode must be local, public, or secure: ${String(options.mode)}`)
  }

  const diagnostics: PlaygroundPreviewUrlContract["diagnostics"] = []
  if ((mode === "public" || mode === "secure") && !publicUrl) {
    diagnostics.push({ code: "preview-public-url-missing", severity: "error", message: `playgroundPreviewUrl mode=${mode} requires publicUrl` })
  }
  if (mode === "secure" && publicUrl && new URL(publicUrl).protocol !== "https:") {
    diagnostics.push({ code: "preview-public-url-not-https", severity: "error", message: "playgroundPreviewUrl mode=secure requires an HTTPS publicUrl" })
  }

  const baseUrl = diagnostics.some((diagnostic) => diagnostic.severity === "error") || mode === "local" ? localUrl : publicUrl ?? localUrl
  return stripUndefined({
    schema: PLAYGROUND_PREVIEW_URL_SCHEMA,
    mode,
    localUrl,
    publicUrl,
    effectiveUrl: resolveUrl(options.path ?? "/", baseUrl),
    diagnostics,
  }) as PlaygroundPreviewUrlContract
}

function normalizeRecipeSteps(steps: WorkspaceRecipeStep[] | undefined): WorkspaceRecipeStep[] | undefined {
  if (!Array.isArray(steps) || steps.length === 0) return undefined
  return steps.map((step, index) => {
    const command = stringValue(step.command)
    if (!command) {
      throw new Error(`wordpressWorkloadRunRecipe step ${index} requires command`)
    }
    return stripUndefined({
      command,
      args: Array.isArray(step.args) ? step.args.map((arg) => String(arg)) : undefined,
      allowFailure: step.allowFailure,
      advisory: step.advisory,
    }) as WorkspaceRecipeStep
  })
}

function runtimeEnv(value: WordPressWorkloadRunRecipeOptions["runtimeEnv"]): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined
  const entries = Object.entries(value)
    .map(([name, entry]) => [name.trim(), typeof entry === "boolean" ? (entry ? "1" : "") : String(entry)] as const)
    .filter(([name]) => /^[A-Z_][A-Z0-9_]*$/.test(name))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function normalizedHttpUrl(value: string, label: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol")
    }
    return url.toString()
  } catch (error) {
    throw new Error(`${label} must be an http(s) URL: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function resolveUrl(pathOrUrl: string, baseUrl: string): string {
  try {
    return normalizedHttpUrl(pathOrUrl, "path")
  } catch {
    return new URL(pathOrUrl, baseUrl).toString()
  }
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
  return items.length > 0 ? items : undefined
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}

function normalizedCapture(options: Pick<WordPressWorkloadRunRecipeOptions, "capture" | "enableQueryCapture">): PerformanceObservationCaptureRequest | undefined {
  const capture = performanceObservationCaptureRequest(options.capture)
  if (typeof options.enableQueryCapture === "boolean") {
    capture.queries = options.enableQueryCapture
  }
  return Object.keys(capture).length > 0 ? capture : undefined
}
