import assert from "node:assert/strict"

import { applyRecipeRuntimeSetup, recipeInputMountPathMap, type PreparedRecipeRuntimeSetup } from "../packages/cli/src/commands/recipe-runtime-setup.js"
import type { PreparedExtraTheme } from "../packages/cli/src/recipe-sources.js"
import type { ExecutionResult, ExecutionSpec, MountSpec, Runtime, WorkspaceRecipe } from "../packages/runtime-core/src/public.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { backend: "wordpress-playground" },
  inputs: {},
  workflow: {
    steps: [{ command: "wordpress.phpunit", args: ["plugin-slug=wpcom", "multisite=0"] }],
  },
}

function preparedTheme(overrides: Partial<PreparedExtraTheme> = {}): PreparedExtraTheme {
  return {
    source: "/tmp/fake-theme-source",
    slug: "fake-theme",
    target: "/wordpress/wp-content/themes/fake-theme",
    activate: false,
    themeName: "Fake Theme",
    cleanupPaths: [],
    provenance: { kind: "local", original: "fake-theme" },
    ...overrides,
  }
}

function preparedSetup(extraThemes: PreparedExtraTheme[]): PreparedRecipeRuntimeSetup {
  return {
    workspaceMounts: [],
    extraPlugins: [],
    extraThemes,
    dependencyOverlays: [],
    overlays: [],
    inputMountBaselinePaths: [],
    inputMountPathMap: recipeInputMountPathMap(recipe),
    stagedFiles: [],
  }
}

function recordingPhaseExecutor() {
  const phases: Array<{ name: string; status: "completed" | "failed" }> = []
  return {
    phases,
    phaseExecutor: {
      tracker: {
        complete(name: string) { phases.push({ name, status: "completed" }) },
        async run<T>(name: string, _data: unknown, callback: () => Promise<T>) {
          try {
            const result = await callback()
            phases.push({ name, status: "completed" })
            return result
          } catch (error) {
            phases.push({ name, status: "failed" })
            throw error
          }
        },
        list() { return phases },
      },
      async operation<T>(_operation: string, promiseOrFactory: Promise<T> | (() => Promise<T>)) {
        return await (typeof promiseOrFactory === "function" ? promiseOrFactory() : promiseOrFactory)
      },
    },
  }
}

function recordingRuntime(): { runtime: Runtime; mounts: MountSpec[]; executions: ExecutionSpec[] } {
  const mounts: MountSpec[] = []
  const executions: ExecutionSpec[] = []
  const runtime: Runtime = {
    async info() { return { id: "runtime", backend: "wordpress-playground", environment: { kind: "wordpress" }, createdAt: new Date().toISOString(), status: "running" } },
    async mount(mount) { mounts.push(mount) },
    async execute(spec) {
      executions.push(spec)
      return {
        id: `exec-${executions.length}`,
        command: spec.command,
        args: spec.args ?? [],
        exitCode: 0,
        stdout: "{}",
        stderr: "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      } satisfies ExecutionResult
    },
    async observe() { throw new Error("unused") },
    async snapshot() { throw new Error("unused") },
    async collectArtifacts() { throw new Error("unused") },
    async destroy() {},
    async materializeStagedInputs() {},
  } satisfies Runtime
  return { runtime, mounts, executions }
}

// An extra_themes entry mounts into wp-content/themes/<slug>, materializes
// alongside plugin/input mounts, and -- because activate is not set -- does
// not trigger theme activation.
{
  const { runtime, mounts, executions } = recordingRuntime()
  const { phases, phaseExecutor } = recordingPhaseExecutor()
  await applyRecipeRuntimeSetup({
    recipe,
    recipeDirectory: process.cwd(),
    runtime,
    runtimeSpec: { environment: { kind: "wordpress", name: "test", version: "latest" }, runtimeEnv: {} },
    prepared: preparedSetup([preparedTheme()]),
    phaseExecutor: phaseExecutor as never,
  })

  assert.deepEqual(phases.filter((phase) => phase.name === "mount_themes"), [{ name: "mount_themes", status: "completed" }])
  const themeMount = mounts.find((mount) => mount.target === "/wordpress/wp-content/themes/fake-theme")
  assert.ok(themeMount, "theme mounted at wp-content/themes/<slug>")
  assert.equal(themeMount?.type, "directory")
  assert.equal(themeMount?.source, "/tmp/fake-theme-source")
  assert.equal(themeMount?.mode, "readonly")

  assert.ok(!phases.some((phase) => phase.name === "activate_theme"), "no activation phase runs when activate is not set")
  assert.ok(!executions.some((execution) => execution.args?.some((arg) => arg.includes("switch_theme"))), "switch_theme is never called when activate is not set")
}

// A theme with activate:true mounts and is activated via switch_theme, not
// activate_plugin -- the plugin-specific mu-plugin loader, Composer
// autoloader install, and plugin lifecycle-replay activation code paths are
// never invoked for a theme.
{
  const { runtime, mounts, executions } = recordingRuntime()
  const { phases, phaseExecutor } = recordingPhaseExecutor()
  await applyRecipeRuntimeSetup({
    recipe,
    recipeDirectory: process.cwd(),
    runtime,
    runtimeSpec: { environment: { kind: "wordpress", name: "test", version: "latest" }, runtimeEnv: {} },
    prepared: preparedSetup([preparedTheme({ slug: "active-theme", target: "/wordpress/wp-content/themes/active-theme", activate: true })]),
    phaseExecutor: phaseExecutor as never,
  })

  assert.deepEqual(phases.filter((phase) => phase.name === "mount_themes"), [{ name: "mount_themes", status: "completed" }])
  assert.deepEqual(phases.filter((phase) => phase.name === "activate_theme"), [{ name: "activate_theme", status: "completed" }])

  const activation = executions.find((execution) => execution.command === "wordpress.run-php" && execution.args?.some((arg) => arg.includes("switch_theme")))
  assert.ok(activation, "switch_theme is invoked for the active theme")
  const codeArg = activation?.args?.find((arg) => arg.startsWith("code="))
  assert.ok(codeArg?.includes('"active-theme"'), "activation code targets the prepared theme's slug")
  assert.ok(!codeArg?.includes("activate_plugin"), "theme activation never calls activate_plugin")
  assert.ok(!codeArg?.includes("wp_codebox_activate_plugin_preload_recipe_plugin"), "theme activation never runs the plugin preload/lifecycle-replay machinery")
}

console.log("recipe runtime setup extra_themes mount+activate wiring ok")
