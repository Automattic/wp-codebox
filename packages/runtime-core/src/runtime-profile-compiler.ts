import { runtimeDependencyPlanContract } from "./agent-task-recipe.js"
import { runtimeProfile, type RuntimeProfile, type RuntimeProfileDependency, type RuntimeProfileReadiness } from "./runtime-boundary-contracts.js"
import type { WorkspaceRecipeExtraPlugin } from "./runtime-contracts.js"
import { isPlainObject, stripUndefined } from "./object-utils.js"

export interface RuntimeProfileDependencyPlan {
  schema: "wp-codebox/runtime-dependency-plan/v1"
  [key: string]: unknown
}

export interface RuntimeProfileExecutionPlan {
  schema: "wp-codebox/runtime-profile-execution-plan/v1"
  dependency_plan: RuntimeProfileDependencyPlan
  capabilities?: string[]
  extra_plugins?: WorkspaceRecipeExtraPlugin[]
  runtime_overlays?: Array<Record<string, unknown>>
  runtime_env?: Record<string, string>
  readiness?: RuntimeProfileReadiness
  diagnostics?: RuntimeProfile["diagnostics"]
  provenance?: RuntimeProfile["provenance"]
}

export interface RuntimeProfilePreflight {
  schema: "wp-codebox/runtime-profile-preflight/v1"
  readiness: RuntimeProfileReadiness
}

export function compileRuntimeProfile(input: unknown): RuntimeProfileExecutionPlan {
  const profile = runtimeProfile(input)
  const componentPlugins = [
    ...dependencyPlugins(profile.components, "component", "plugin"),
    ...dependencyPlugins(profile.plugins, "plugin", "plugin"),
    ...dependencyPlugins(profile.mu_plugins, "mu_plugin", "mu-plugin"),
    ...objectPlugins(profile.extra_plugins),
    ...objectPlugins(profile.component_contracts),
  ]
  const runtimeOverlays = [
    ...overlayDependencies(profile.overlays),
    ...(profile.runtime_overlays ?? []),
  ]
  const readiness = runtimeProfilePreflight(profile).readiness

  return stripUndefined({
    schema: "wp-codebox/runtime-profile-execution-plan/v1",
    dependency_plan: runtimeDependencyPlanContract({
      provider_plugins: objectPlugins(profile.provider_plugins),
      component_plugins: componentPlugins,
      runtime_overlays: runtimeOverlays,
      runtime_env: profile.env,
    }) as RuntimeProfileDependencyPlan,
    capabilities: profile.capabilities,
    extra_plugins: componentPlugins.length > 0 ? componentPlugins : undefined,
    runtime_overlays: runtimeOverlays.length > 0 ? runtimeOverlays : undefined,
    runtime_env: profile.env,
    readiness,
    diagnostics: profile.diagnostics,
    provenance: profile.provenance,
  }) as RuntimeProfileExecutionPlan
}

export function runtimeProfilePreflight(input: unknown): RuntimeProfilePreflight {
  const profile = isRuntimeProfile(input) ? input : runtimeProfile(input)
  return {
    schema: "wp-codebox/runtime-profile-preflight/v1",
    readiness: profile.readiness ?? inferredReadiness(profile),
  }
}

function dependencyPlugins(dependencies: RuntimeProfileDependency[] | undefined, kind: string, loadAs: "plugin" | "mu-plugin"): WorkspaceRecipeExtraPlugin[] {
  return (dependencies ?? []).flatMap((dependency) => {
    if (!dependency.source) return []
    return [stripUndefined({
      source: dependency.source,
      slug: dependency.slug,
      pluginFile: stringField(dependency.metadata, "pluginFile"),
      activate: dependency.activate ?? (loadAs === "plugin" ? true : undefined),
      loadAs,
      metadata: stripUndefined({
        runtimeProfileDependency: stripUndefined({
          kind,
          target: dependency.target,
          required: dependency.required,
          readiness: dependency.readiness,
          provenance: dependency.provenance,
        }),
        ...(dependency.metadata ?? {}),
      }),
    })]
  })
}

function objectPlugins(entries: Array<Record<string, unknown>> | undefined): WorkspaceRecipeExtraPlugin[] {
  return (entries ?? []).flatMap((entry) => {
    const source = stringField(entry, "source") || stringField(entry, "path")
    if (!source) return []
    const loadAs: "plugin" | "mu-plugin" = entry.loadAs === "mu-plugin" || entry.load_as === "mu-plugin" ? "mu-plugin" : "plugin"
    return [stripUndefined({
      source,
      slug: stringField(entry, "slug") || stringField(entry, "component") || stringField(entry, "name"),
      pluginFile: stringField(entry, "pluginFile") || stringField(entry, "plugin_file"),
      activate: typeof entry.activate === "boolean" ? entry.activate : loadAs === "plugin" ? true : undefined,
      sha256: stringField(entry, "sha256"),
      loadAs,
      metadata: isPlainObject(entry.metadata) ? entry.metadata : undefined,
    })]
  })
}

function overlayDependencies(dependencies: RuntimeProfileDependency[] | undefined): Array<Record<string, unknown>> {
  return (dependencies ?? []).map((dependency) => stripUndefined({
    kind: dependency.kind,
    slug: dependency.slug,
    source: dependency.source,
    target: dependency.target,
    activate: dependency.activate,
    required: dependency.required,
    readiness: dependency.readiness,
    provenance: dependency.provenance,
    metadata: dependency.metadata,
  }))
}

function inferredReadiness(profile: RuntimeProfile): RuntimeProfileReadiness {
  const dependencies = [
    ...profile.components,
    ...(profile.plugins ?? []),
    ...(profile.mu_plugins ?? []),
    ...(profile.themes ?? []),
    ...(profile.overlays ?? []),
  ]
  const missing = dependencies
    .filter((dependency) => dependency.required !== false && (dependency.readiness === "missing" || !dependency.source))
    .map((dependency) => `${dependency.kind}:${dependency.slug}`)
  const blocked = dependencies.some((dependency) => dependency.readiness === "blocked")
  return {
    status: blocked ? "blocked" : missing.length > 0 ? "missing" : "ready",
    checks: {
      dependencies: missing.length === 0 && !blocked,
    },
    missing,
  }
}

function isRuntimeProfile(input: unknown): input is RuntimeProfile {
  return isPlainObject(input) && input.schema === "wp-codebox/runtime-profile/v1" && Array.isArray(input.components)
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined
  const value = record[key]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}
