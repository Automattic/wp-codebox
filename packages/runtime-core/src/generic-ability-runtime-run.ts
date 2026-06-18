import type { SandboxToolPolicySnapshot } from "./sandbox-tool-policy.js"
import { commandArg, commandJsonArg } from "./command-codecs.js"
import { resolvePluginEntrypointContract, sanitizePluginSlug, type ComponentLoadMode } from "./component-contracts.js"
import { DEFAULT_WORDPRESS_VERSION } from "./runtime-defaults.js"
import type { WorkspaceRecipe, WorkspaceRecipeExtraPlugin, WorkspaceRecipeMount, WorkspaceRecipeRuntimeOverlay, WorkspaceRecipeStagedFile } from "./runtime-contracts.js"
import { componentManifestForRuntimePlugins, runtimeDependencyPlanContract } from "./agent-task-recipe.js"
import { prepareRecipeSourcePackageSync } from "./recipe-source-packages.js"
import { isPlainObject, stringList, stripUndefined } from "./object-utils.js"

export const GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA = "wp-codebox/generic-ability-runtime-run-result/v1" as const

export interface GenericAbilityRuntimeComponentContract {
  source: string
  slug?: string
  pluginFile?: string
  loadAs?: ComponentLoadMode
  activate?: boolean
  originalSource?: string
  metadata?: Record<string, unknown>
}

export interface GenericAbilityRuntimeProviderPluginContract extends GenericAbilityRuntimeComponentContract {}

export interface GenericAbilityRuntimeRunOptions {
  abilityId: string
  abilityInput?: Record<string, unknown>
  expectedResultSchema?: string | Record<string, unknown>
  wordpressVersion?: string
  blueprint?: unknown
  artifactsPath?: string
  components?: GenericAbilityRuntimeComponentContract[]
  providerPluginPaths?: string[]
  providerPlugins?: GenericAbilityRuntimeProviderPluginContract[]
  runtimeOverlays?: WorkspaceRecipeRuntimeOverlay[]
  runtimeEnv?: Record<string, string | number | boolean>
  secretEnv?: string[]
  toolPolicy?: SandboxToolPolicySnapshot
  mounts?: WorkspaceRecipeMount[]
  runtimeStackMounts?: WorkspaceRecipeMount[]
  stagedFiles?: WorkspaceRecipeStagedFile[]
  verifySteps?: WorkspaceRecipe["workflow"]["after"]
}

export function buildGenericAbilityRuntimeRunRecipe(options: GenericAbilityRuntimeRunOptions): WorkspaceRecipe {
  const abilityId = stringValue(options.abilityId)
  if (!abilityId) {
    throw new Error("buildGenericAbilityRuntimeRunRecipe requires abilityId")
  }

  const componentPlugins = runtimePlugins(options.components, "component", options.artifactsPath)
  const explicitProviderPlugins = runtimePlugins(options.providerPlugins, "provider", options.artifactsPath)
  const providerPathPlugins = providerPluginsFromPaths(options.providerPluginPaths, options.artifactsPath)
  const providers = [...explicitProviderPlugins, ...providerPathPlugins]
  const componentManifest = componentManifestForRuntimePlugins(componentPlugins, providers)
  const expectedResultSchema = options.expectedResultSchema
  const abilityInput = stripUndefined({
    ...(isPlainObject(options.abilityInput) ? options.abilityInput : {}),
    runtime_invocation: {
      schema: GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA,
      ability_id: abilityId,
      expected_result_schema: expectedResultSchema,
      component_manifest: componentManifest,
      dependency_plan: runtimeDependencyPlanContract({
        provider_plugin_paths: options.providerPluginPaths,
        provider_plugins: providers,
        component_plugins: componentPlugins,
        runtime_overlays: options.runtimeOverlays,
        secret_env: options.secretEnv,
        runtime_env: options.runtimeEnv,
      }),
      sandbox_tool_policy: options.toolPolicy,
    },
  })

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
      extra_plugins: [...componentPlugins, ...providers],
      component_manifest: componentManifest,
      runtimeEnv: runtimeEnv(options.runtimeEnv),
      secretEnv: stringList(options.secretEnv),
      stagedFiles: Array.isArray(options.stagedFiles) && options.stagedFiles.length > 0 ? options.stagedFiles : undefined,
    }),
    workflow: stripUndefined({
      steps: [{
        command: "wordpress.ability",
        args: [
          commandArg("name", abilityId),
          commandJsonArg("input", abilityInput),
          ...(expectedResultSchema ? [commandJsonArg("expected-result-schema", expectedResultSchema)] : []),
        ],
      }],
      after: Array.isArray(options.verifySteps) && options.verifySteps.length > 0 ? options.verifySteps : undefined,
    }),
  }) as WorkspaceRecipe
}

function runtimePlugins(contracts: GenericAbilityRuntimeComponentContract[] | undefined, role: "component" | "provider", artifactsRoot = ""): WorkspaceRecipeExtraPlugin[] {
  if (!Array.isArray(contracts)) return []
  return contracts.flatMap((contract, index) => {
    const source = stringValue(contract.source)
    if (!source) return []
    const slug = sanitizePluginSlug(stringValue(contract.slug) || slugFromPath(source))
    const preparedSource = prepareRecipeSourcePackageSync({ source, originalSource: contract.originalSource, slug, artifactsRoot, packageRootName: "prepared-plugins" })
    const loadAs = contract.loadAs === "mu-plugin" ? "mu-plugin" : "plugin"
    const entrypoint = resolvePluginEntrypointContract({ source: preparedSource, slug, pluginFile: contract.pluginFile, loadAs })

    return [{
      source: preparedSource,
      slug,
      pluginFile: entrypoint.pluginFile,
      activate: contract.activate ?? role === "provider",
      loadAs,
      metadata: stripUndefined({
        ...contract.metadata,
        componentContract: {
          role,
          index,
          slug,
          requestedPath: source,
          originalPath: contract.originalSource,
          preparedPath: preparedSource,
          pluginFile: entrypoint.pluginFile,
          pluginEntrypointFallback: entrypoint.fallback,
          loadAs,
          activate: contract.activate ?? role === "provider",
        },
      }),
    }]
  })
}

function providerPluginsFromPaths(paths: string[] | undefined, artifactsRoot = ""): WorkspaceRecipeExtraPlugin[] {
  return stringList(paths).flatMap((source) => runtimePlugins([{ source, slug: slugFromPath(source), activate: true }], "provider", artifactsRoot))
}

function runtimeEnv(value: GenericAbilityRuntimeRunOptions["runtimeEnv"]): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined
  const entries = Object.entries(value)
    .map(([name, entry]) => [name.trim(), typeof entry === "boolean" ? (entry ? "1" : "") : String(entry)] as const)
    .filter(([name]) => /^[A-Z_][A-Z0-9_]*$/.test(name))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function slugFromPath(source: string): string {
  return sanitizePluginSlug(source.replace(/\/$/, "").split("/").pop() || "runtime-plugin")
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}
