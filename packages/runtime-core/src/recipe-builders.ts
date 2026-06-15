import type { WorkspaceRecipe, WorkspaceRecipeExtraPlugin, WorkspaceRecipeMount, WorkspaceRecipeStep } from "./runtime-contracts.js"
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
}

export function normalizeRecipeMounts(mounts: readonly WorkspaceRecipeMount[] = [], options: NormalizeRecipeMountsOptions = {}): WorkspaceRecipeMount[] {
  const defaultMode = options.defaultMode ?? "readwrite"
  return mounts.map((mount, index) => {
    if (!mount.source || typeof mount.source !== "string") {
      throw new Error(`Recipe mount ${index} requires source`)
    }
    if (!mount.target || typeof mount.target !== "string" || !mount.target.startsWith("/")) {
      throw new Error(`Recipe mount ${index} requires an absolute target`)
    }

    const normalized: WorkspaceRecipeMount = {
      source: mount.source,
      target: mount.target,
      mode: mount.mode ?? defaultMode,
    }
    if (mount.type !== undefined) {
      normalized.type = mount.type
    }
    if (mount.metadata !== undefined) {
      normalized.metadata = mount.metadata
    }

    return normalized
  })
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
          `plugin-slug=${pluginSlug}`,
          `cwd=${options.cwd ?? pluginTarget}`,
          `test-file=${options.selectedTestFile ?? ""}`,
          `changed-tests-json=${JSON.stringify(options.changedTestFiles ?? [])}`,
          `env-json=${JSON.stringify(options.env ?? {})}`,
          `wp-config-defines-json=${JSON.stringify(options.wpConfigDefines ?? {})}`,
          `autoload-file=${options.autoloadFile ?? "/wp-codebox-vendor/autoload.php"}`,
          `tests-dir=${options.testsDir ?? "/wp-codebox-vendor/wp-phpunit/wp-phpunit"}`,
          `dependency-mounts=${(options.dependencyMounts ?? []).filter(Boolean).join(",")}`,
          `bootstrap-files-json=${JSON.stringify(options.bootstrapFiles ?? [])}`,
          `phpunit-args-json=${JSON.stringify(options.phpunitArgs ?? [])}`,
          `bootstrap-mode=${options.bootstrapMode ?? "managed"}`,
          `project-bootstrap=${options.projectBootstrap ?? ""}`,
          `multisite=${options.multisite ? "1" : "0"}`,
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
      steps: [{
        command: "wordpress.bench",
        args: [
          `component-id=${componentId}`,
          `plugin-slug=${pluginSlug}`,
          `iterations=${positiveInteger(options.iterations, 3)}`,
          `warmup=${nonNegativeInteger(options.warmupIterations, 1)}`,
          `dependency-slugs=${(options.dependencySlugs ?? []).filter(Boolean).join(",")}`,
          `env-json=${JSON.stringify(options.env ?? {})}`,
          `bootstrap-files-json=${JSON.stringify(options.bootstrapFiles ?? [])}`,
          `workloads-json=${JSON.stringify(options.workloads ?? [])}`,
          `scenario-ids-json=${JSON.stringify(normalizeScenarioIds(options.scenarioIds ?? []))}`,
          `lifecycle-json=${JSON.stringify(options.lifecycle ?? {})}`,
          `reset-policy-json=${JSON.stringify(options.resetPolicy ?? {})}`,
        ],
      }],
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
