import type { WorkspaceRecipe, WorkspaceRecipeExtraPlugin, WorkspaceRecipeMount, WorkspaceRecipeStep } from "./runtime-contracts.js"
import { commandArg, commandJsonArg, commandStringListArg } from "./command-codecs.js"
export { buildGenericAbilityRuntimeRunRecipe, GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA, type GenericAbilityRuntimeComponentContract, type GenericAbilityRuntimeProviderPluginContract, type GenericAbilityRuntimeRunOptions } from "./generic-ability-runtime-run.js"
export { buildRuntimePackageRunRecipe, CODEBOX_RUN_RUNTIME_PACKAGE_ABILITY, RUNTIME_PACKAGE_ARTIFACT_DECLARATION_SCHEMA, RUNTIME_PACKAGE_EXECUTION_INPUT_SCHEMA, RUNTIME_PACKAGE_EXECUTION_RESULT_SCHEMA, RUNTIME_PACKAGE_OUTPUT_PROJECTION_SCHEMA, runtimePackageExecutionInput, type RuntimePackageArtifactDeclaration, type RuntimePackageExecutionInput, type RuntimePackageOutputProjection, type RuntimePackageRunRecipeOptions } from "./runtime-package-execution.js"
export { buildWordPressWorkloadRunRecipe, playgroundPreviewUrl, wordpressAbilityStep, wordpressWorkloadRunRecipe, PLAYGROUND_PREVIEW_URL_SCHEMA, WORDPRESS_ABILITY_STEP_SCHEMA, WORDPRESS_WORKLOAD_RUN_SCHEMA, type PlaygroundPreviewUrlContract, type PlaygroundPreviewUrlMode, type PlaygroundPreviewUrlOptions, type WordPressAbilityStepOptions, type WordPressWorkloadRunRecipeOptions } from "./wordpress-workload-primitives.js"
import { normalizeSharedMounts } from "./mount-primitives.js"
import { DEFAULT_WORDPRESS_VERSION } from "./runtime-defaults.js"

type JsonObject = Record<string, unknown>

export interface NormalizeRecipeMountsOptions {
  defaultMode?: WorkspaceRecipeMount["mode"]
}

export interface WordPressPhpunitRecipeOptions {
  wordpressVersion?: string
  blueprint?: unknown
  mounts?: WorkspaceRecipeMount[]
  pluginSource?: string
  pluginSlug: string
  cwd?: string
  selectedTestFile?: string
  changedTestFiles?: string[]
  env?: JsonObject
  wpConfigDefines?: JsonObject
  autoloadFile?: string
  testsDir?: string
  dependencyMounts?: string[]
  bootstrapFiles?: string[]
  phpunitArgs?: string[]
  bootstrapMode?: "managed" | "project" | (string & {})
  projectBootstrap?: string
  multisite?: boolean
  prepareSteps?: WorkspaceRecipeStep[]
}

export interface WordPressBenchRecipeOptions {
  wordpressVersion?: string
  blueprint?: unknown
  mounts?: WorkspaceRecipeMount[]
  extra_plugins?: WorkspaceRecipeExtraPlugin[]
  componentId?: string
  pluginSlug: string
  iterations?: number
  warmupIterations?: number
  dependencySlugs?: string[]
  env?: JsonObject
  wpConfigDefines?: JsonObject
  bootstrapFiles?: string[]
  workloads?: unknown[]
  scenarioIds?: string[]
  lifecycle?: JsonObject
  resetPolicy?: JsonObject
  prepareSteps?: WorkspaceRecipeStep[]
  postSteps?: WorkspaceRecipeStep[]
}

export function normalizeRecipeMounts(mounts: readonly WorkspaceRecipeMount[] = [], options: NormalizeRecipeMountsOptions = {}): WorkspaceRecipeMount[] {
  return normalizeSharedMounts(mounts, { defaultMode: options.defaultMode ?? "readwrite", label: "Recipe mount" })
}

export function buildWordPressPhpunitRecipe(options: WordPressPhpunitRecipeOptions): WorkspaceRecipe {
  const pluginSlug = requiredPluginSlug(options.pluginSlug, "buildWordPressPhpunitRecipe")
  const pluginTarget = `/wordpress/wp-content/plugins/${pluginSlug}`

  return {
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: {
      wp: options.wordpressVersion ?? DEFAULT_WORDPRESS_VERSION,
      blueprint: options.blueprint ?? { steps: [] },
    },
    inputs: {
      mounts: normalizeRecipeMounts([
        ...(options.pluginSource ? [{ source: options.pluginSource, target: pluginTarget } satisfies WorkspaceRecipeMount] : []),
        ...(options.mounts ?? []),
      ]),
    },
    workflow: {
      ...(options.prepareSteps && options.prepareSteps.length > 0 ? { before: normalizeRecipeSteps(options.prepareSteps, "prepareSteps") } : {}),
      steps: [{
        command: "wordpress.phpunit",
        args: [
          commandArg("plugin-slug", pluginSlug),
          commandArg("cwd", options.cwd ?? pluginTarget),
          commandArg("test-file", options.selectedTestFile ?? ""),
          commandJsonArg("changed-tests-json", options.changedTestFiles ?? []),
          commandJsonArg("env-json", options.env ?? {}),
          commandJsonArg("wp-config-defines-json", options.wpConfigDefines ?? {}),
          commandArg("autoload-file", options.autoloadFile ?? "/wp-codebox-vendor/autoload.php"),
          commandArg("tests-dir", options.testsDir ?? "/wp-codebox-vendor/wp-phpunit/wp-phpunit"),
          commandStringListArg("dependency-mounts", options.dependencyMounts ?? []),
          commandJsonArg("bootstrap-files-json", options.bootstrapFiles ?? []),
          commandJsonArg("phpunit-args-json", options.phpunitArgs ?? []),
          commandArg("bootstrap-mode", options.bootstrapMode ?? "managed"),
          commandArg("project-bootstrap", options.projectBootstrap ?? ""),
          commandArg("multisite", options.multisite ? "1" : "0"),
        ],
      }],
    },
  }
}

function normalizeRecipeSteps(steps: readonly WorkspaceRecipeStep[], label: string): WorkspaceRecipeStep[] {
  return steps.map((step, index) => {
    if (!step.command || typeof step.command !== "string") {
      throw new Error(`${label}[${index}] requires command`)
    }

    return {
      command: step.command,
      ...(step.args !== undefined ? { args: step.args } : {}),
      ...(step.allowFailure !== undefined ? { allowFailure: step.allowFailure } : {}),
      ...(step.advisory !== undefined ? { advisory: step.advisory } : {}),
    }
  })
}

export function buildWordPressBenchRecipe(options: WordPressBenchRecipeOptions): WorkspaceRecipe {
  const pluginSlug = requiredPluginSlug(options.pluginSlug, "buildWordPressBenchRecipe")
  const componentId = options.componentId?.trim() || pluginSlug

  return {
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: {
      wp: options.wordpressVersion ?? DEFAULT_WORDPRESS_VERSION,
      blueprint: blueprintWithWpConfigDefines(options.blueprint ?? {}, options.wpConfigDefines ?? {}),
    },
    inputs: {
      extra_plugins: normalizeExtraPlugins(options.extra_plugins),
      mounts: normalizeRecipeMounts(options.mounts, { defaultMode: "readonly" }),
    },
    workflow: {
      ...(options.prepareSteps && options.prepareSteps.length > 0 ? { before: normalizeRecipeSteps(options.prepareSteps, "prepareSteps") } : {}),
      steps: [{
        command: "wordpress.bench",
        args: [
          commandArg("component-id", componentId),
          commandArg("plugin-slug", pluginSlug),
          commandArg("iterations", positiveInteger(options.iterations, 3)),
          commandArg("warmup", nonNegativeInteger(options.warmupIterations, 1)),
          commandStringListArg("dependency-slugs", options.dependencySlugs ?? []),
          commandJsonArg("env-json", options.env ?? {}),
          commandJsonArg("bootstrap-files-json", options.bootstrapFiles ?? []),
          commandJsonArg("workloads-json", options.workloads ?? []),
          commandJsonArg("scenario-ids-json", normalizeScenarioIds(options.scenarioIds ?? [])),
          commandJsonArg("lifecycle-json", options.lifecycle ?? {}),
          commandJsonArg("reset-policy-json", options.resetPolicy ?? {}),
        ],
      }, ...normalizeRecipeSteps(options.postSteps ?? [], "postSteps")],
    },
  }
}

function normalizeExtraPlugins(plugins: readonly WorkspaceRecipeExtraPlugin[] = []): WorkspaceRecipeExtraPlugin[] {
  return plugins.map((plugin, index) => {
    if (!plugin.source || typeof plugin.source !== "string") {
      throw new Error(`Recipe extra plugin ${index} requires source`)
    }

    const normalized: WorkspaceRecipeExtraPlugin = {
      source: plugin.source,
    }
    if (plugin.slug !== undefined) {
      normalized.slug = plugin.slug
    }
    if (plugin.pluginFile !== undefined) {
      normalized.pluginFile = plugin.pluginFile
    }
    if (plugin.activate !== undefined) {
      normalized.activate = plugin.activate
    }
    if (plugin.sha256 !== undefined) {
      normalized.sha256 = plugin.sha256
    }
    if (plugin.loadAs !== undefined) {
      normalized.loadAs = plugin.loadAs
    }

    return normalized
  })
}

function blueprintWithWpConfigDefines(blueprint: unknown, defines: JsonObject): unknown {
  const defineKeys = Object.keys(defines)
  if (defineKeys.length === 0) {
    return blueprint
  }

  if (!isPlainObject(blueprint)) {
    return { steps: [{ step: "defineWpConfigConsts", consts: defines }] }
  }

  const existingSteps = Array.isArray(blueprint.steps) ? blueprint.steps : []
  return {
    ...blueprint,
    steps: [...existingSteps, { step: "defineWpConfigConsts", consts: defines }],
  }
}

function requiredPluginSlug(value: string, caller: string): string {
  const slug = value.trim()
  if (!slug) {
    throw new Error(`${caller} requires pluginSlug`)
  }
  return slug
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function normalizeScenarioIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
