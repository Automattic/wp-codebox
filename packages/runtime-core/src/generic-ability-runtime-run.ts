import type { SandboxToolPolicySnapshot } from "./sandbox-tool-policy.js"
import { commandArg, commandJsonArg } from "./command-codecs.js"
import { resolvePluginEntrypointContract, sanitizePluginSlug, type ComponentLoadMode } from "./component-contracts.js"
import { providerRuntimeInvocationContract } from "./provider-runtime-contracts.js"
import { DEFAULT_WORDPRESS_VERSION } from "./runtime-defaults.js"
import type { WorkspaceRecipe, WorkspaceRecipeExtraPlugin, WorkspaceRecipeMount, WorkspaceRecipeRuntimeOverlay, WorkspaceRecipeStagedFile } from "./runtime-contracts.js"
import { componentManifestForRuntimePlugins, runtimeDependencyPlanContract } from "./agent-task-recipe.js"
import { prepareRecipeSourcePackageSync } from "./recipe-source-packages.js"
import { isPlainObject, stringList, stripUndefined } from "./object-utils.js"
import { sandboxToolPolicyFromAllowedTools } from "./sandbox-tool-policy.js"
import { runtimePresetById, type RuntimePresetDefinition, type RuntimePresetRegistryManifest } from "./runtime-preset-registry.js"
import { runtimeProfilePreflight } from "./runtime-profile-compiler.js"
import type { RuntimeProfileReadiness } from "./runtime-boundary-contracts.js"

export const GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA = "wp-codebox/generic-ability-runtime-run-result/v1" as const

export interface GenericAbilityRuntimeComponentContract {
  source: string
  slug?: string
  pluginFile?: string
  loadAs?: ComponentLoadMode
  activate?: boolean
  originalSource?: string
  sourceSubpath?: string
  metadata?: Record<string, unknown>
}

export interface GenericAbilityRuntimeProviderPluginContract extends GenericAbilityRuntimeComponentContract {}

export interface GenericAbilityRuntimeRunOptions {
  abilityId: string
  abilityInput?: Record<string, unknown>
  runtimePresetId?: string
  runtimeProfile?: RuntimePresetDefinition
  runtimePresetRegistry?: RuntimePresetRegistryManifest | RuntimePresetRegistryManifest[]
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
  allowedTools?: string[]
  toolPolicy?: SandboxToolPolicySnapshot
  mounts?: WorkspaceRecipeMount[]
  runtimeStackMounts?: WorkspaceRecipeMount[]
  stagedFiles?: WorkspaceRecipeStagedFile[]
  verifySteps?: WorkspaceRecipe["workflow"]["after"]
}

export function buildGenericAbilityRuntimeRunRecipe(options: GenericAbilityRuntimeRunOptions): WorkspaceRecipe {
  options = applyRuntimePresetOptions(options)
  const abilityId = stringValue(options.abilityId)
  if (!abilityId) {
    throw new Error("buildGenericAbilityRuntimeRunRecipe requires abilityId")
  }

  const componentPlugins = runtimePlugins(options.components, "component", options.artifactsPath)
  const explicitProviderPlugins = runtimePlugins(options.providerPlugins, "provider", options.artifactsPath)
  const providerPathPlugins = providerPluginsFromPaths(options.providerPluginPaths, options.artifactsPath)
  const providers = [...explicitProviderPlugins, ...providerPathPlugins]
  const componentManifest = componentManifestForRuntimePlugins(componentPlugins, providers)
  const dependencyPlan = runtimeDependencyPlanContract({
    provider_plugin_paths: options.providerPluginPaths,
    provider_plugins: providers,
    component_plugins: componentPlugins,
    runtime_overlays: options.runtimeOverlays,
    secret_env: options.secretEnv,
    runtime_env: options.runtimeEnv,
  })
  const readiness = runtimeProfileReadiness(options)
  const expectedResultSchema = options.expectedResultSchema
  const toolPolicy = options.toolPolicy ?? (stringList(options.allowedTools).length > 0
    ? sandboxToolPolicyFromAllowedTools(options.allowedTools ?? [], { source: "wp-codebox.generic-ability-runtime-run.allowed-tools" })
    : undefined)
  const abilityInput = stripUndefined({
    ...(isPlainObject(options.abilityInput) ? options.abilityInput : {}),
    runtime_invocation: {
      schema: GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA,
      ability_id: abilityId,
      expected_result_schema: expectedResultSchema,
      selection: runtimeSelection(options),
      provider_runtime_contract: providerRuntimeInvocationContract(),
      component_manifest: componentManifest,
      dependency_plan: dependencyPlan,
      readiness,
      diagnostics: runtimeDiagnostics(options, readiness),
      sandbox_tool_policy: toolPolicy,
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
      runtimeDependencyPlan: dependencyPlan,
      runtimeReadiness: readiness,
      runtimeDiagnostics: runtimeDiagnostics(options, readiness),
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

function applyRuntimePresetOptions(options: GenericAbilityRuntimeRunOptions): GenericAbilityRuntimeRunOptions {
  const preset = resolveRuntimePreset(options)
  if (!preset) return options
  const modelDefaults = preset.modelDefaults ?? {}
  const abilityInput = stripUndefined({
    provider: modelDefaults.provider,
    model: modelDefaults.model,
    mode: modelDefaults.mode,
    agent: modelDefaults.agent,
    maxTurns: modelDefaults.maxTurns,
    timeoutSeconds: modelDefaults.timeoutSeconds,
    ...options.abilityInput,
  })

  return {
    ...options,
    abilityInput,
    components: [...(preset.components ?? []), ...(options.components ?? [])],
    providerPlugins: [...(preset.provider?.plugins ?? []), ...(options.providerPlugins ?? [])],
    runtimeOverlays: [...(preset.runtimeOverlays ?? []), ...(options.runtimeOverlays ?? [])],
    runtimeEnv: { ...envDefaults(preset.requiredEnv?.runtime), ...(options.runtimeEnv ?? {}) },
    secretEnv: [...stringList(preset.requiredEnv?.secret), ...stringList(options.secretEnv)],
  }
}

function resolveRuntimePreset(options: GenericAbilityRuntimeRunOptions): RuntimePresetDefinition | undefined {
  if (options.runtimeProfile && (!options.runtimePresetId || options.runtimeProfile.id === options.runtimePresetId)) {
    return options.runtimeProfile
  }
  const id = stringValue(options.runtimePresetId)
  if (!id) return undefined
  const registries = Array.isArray(options.runtimePresetRegistry) ? options.runtimePresetRegistry : options.runtimePresetRegistry ? [options.runtimePresetRegistry] : []
  for (const registry of registries) {
    const preset = runtimePresetById(registry, id)
    if (preset) return preset
  }
  throw new Error(`Runtime preset not found: ${id}`)
}

function runtimeSelection(options: GenericAbilityRuntimeRunOptions): Record<string, unknown> | undefined {
  const preset = resolveRuntimePreset(options)
  if (!preset?.modelDefaults && !options.runtimePresetId) return undefined
  const defaults = preset?.modelDefaults ?? {}
  return stripUndefined({
    runtimePresetId: options.runtimePresetId ?? preset?.id,
    provider: defaults.provider,
    model: defaults.model,
    mode: defaults.mode,
    agent: defaults.agent,
    maxTurns: defaults.maxTurns,
    timeoutSeconds: defaults.timeoutSeconds,
  })
}

function runtimeProfileReadiness(options: GenericAbilityRuntimeRunOptions): RuntimeProfileReadiness {
  const preset = resolveRuntimePreset(options)
  return runtimeProfilePreflight({
    schema: "wp-codebox/runtime-profile/v1",
    id: preset?.id ?? options.runtimePresetId ?? "generic-ability-runtime-run",
    components: [
      ...(preset?.components ?? []).map((component) => ({ kind: "component", slug: component.slug ?? slugFromPath(component.source), source: component.source, readiness: "ready" })),
      ...(preset?.provider?.plugins ?? []).map((plugin) => ({ kind: plugin.loadAs === "mu-plugin" ? "mu_plugin" : "plugin", slug: plugin.slug ?? slugFromPath(plugin.source), source: plugin.source, readiness: "ready" })),
    ],
    runtime_overlays: options.runtimeOverlays ?? [],
  }).readiness
}

function runtimeDiagnostics(options: GenericAbilityRuntimeRunOptions, readiness: RuntimeProfileReadiness): Array<Record<string, unknown>> {
  const preset = resolveRuntimePreset(options)
  return [stripUndefined({
    code: preset ? "runtime_preset.resolved" : "runtime_preset.not_requested",
    status: readiness.status ?? "ready",
    severity: "info",
    message: preset ? "Runtime preset resolved by WP Codebox." : "Runtime preset was not requested.",
    evidence: preset ? {
      runtimePresetId: preset.id,
      components: preset.components?.length ?? 0,
      providerPlugins: preset.provider?.plugins?.length ?? 0,
      overlays: preset.runtimeOverlays?.length ?? 0,
      secretEnv: preset.requiredEnv?.secret?.length ?? 0,
    } : undefined,
  })]
}

function envDefaults(names: string[] | undefined): Record<string, string> {
  return Object.fromEntries(stringList(names).map((name) => [name, ""]))
}

function runtimePlugins(contracts: GenericAbilityRuntimeComponentContract[] | undefined, role: "component" | "provider", artifactsRoot = ""): WorkspaceRecipeExtraPlugin[] {
  if (!Array.isArray(contracts)) return []
  return contracts.flatMap((contract, index) => {
    const source = stringValue(contract.source)
    if (!source) return []
    const slug = sanitizePluginSlug(stringValue(contract.slug) || slugFromPath(source))
    const preparedSource = prepareRecipeSourcePackageSync({ source, originalSource: contract.originalSource, sourceSubpath: contract.sourceSubpath, slug, artifactsRoot, packageRootName: "prepared-plugins" })
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
