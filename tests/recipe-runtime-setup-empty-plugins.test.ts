import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { applyRecipeRuntimeSetup, recipeInputMountPathMap, type PreparedRecipeRuntimeSetup } from "../packages/cli/src/commands/recipe-runtime-setup.js"
import type { MountSpec, Runtime, WorkspaceRecipe } from "../packages/runtime-core/src/public.js"

const inputMountSource = await mkdtemp(join(tmpdir(), "wp-codebox-empty-plugin-input-"))
const fileMountSource = join(inputMountSource, "wp-config.php")
await writeFile(fileMountSource, "<?php\n")

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { backend: "wordpress-playground" },
  inputs: {
    extra_plugins: [],
    mounts: [
      { source: inputMountSource, target: "/home/wpcom", mode: "readonly", captureArtifacts: false },
      { source: fileMountSource, target: "/home/wpcom/public_html/wp-config.php", mode: "readonly" },
    ],
  },
  workflow: {
    steps: [{ command: "wordpress.phpunit", args: ["plugin-slug=wpcom", "multisite=0"] }],
  },
}

const prepared: PreparedRecipeRuntimeSetup = {
  workspaceMounts: [],
  extraPlugins: [],
  dependencyOverlays: [],
  overlays: [],
  inputMountBaselinePaths: [],
  inputMountPathMap: recipeInputMountPathMap(recipe),
  stagedFiles: [],
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

function unusedRuntime(): Runtime {
  return {
    async info() { return { id: "runtime", backend: "wordpress-playground", environment: { kind: "wordpress" }, createdAt: new Date().toISOString(), status: "running" } },
    async mount() {},
    async execute() { throw new Error("unused") },
    async observe() { throw new Error("unused") },
    async snapshot() { throw new Error("unused") },
    async collectArtifacts() { throw new Error("unused") },
    async destroy() {},
  } satisfies Runtime
}

try {
  const materialized: MountSpec[][] = []
  const { phases, phaseExecutor } = recordingPhaseExecutor()
  await applyRecipeRuntimeSetup({
    recipe,
    recipeDirectory: process.cwd(),
    runtime: {
      ...unusedRuntime(),
      async materializeStagedInputs(mounts) { materialized.push(mounts) },
    },
    runtimeSpec: { environment: { kind: "wordpress", name: "test", version: "latest" }, runtimeEnv: {} },
    prepared,
    phaseExecutor: phaseExecutor as never,
  })
  assert.deepEqual(phases.filter((phase) => phase.name === "mount_plugins"), [{ name: "mount_plugins", status: "completed" }])
  assert.deepEqual(phases.filter((phase) => phase.name === "materialize_runtime_inputs"), [{ name: "materialize_runtime_inputs", status: "completed" }])
  assert.equal(materialized.length, 1)
  assert.equal(materialized[0].length, 2)
  assert.ok(materialized[0].some((mount) => mount.type === "file" && mount.source === fileMountSource), "empty extra_plugins still materializes file input mounts")

  const failing = recordingPhaseExecutor()
  await assert.rejects(
    applyRecipeRuntimeSetup({
      recipe,
      recipeDirectory: process.cwd(),
      runtime: {
        ...unusedRuntime(),
        async materializeStagedInputs() {
          const error = new TypeError("resolved is not a function")
          error.cause = new Error("Comlink method call failed")
          throw error
        },
      },
      runtimeSpec: { environment: { kind: "wordpress", name: "test", version: "latest" }, runtimeEnv: {} },
      prepared,
      phaseExecutor: failing.phaseExecutor as never,
    }),
    (error: unknown) => error instanceof TypeError && error.message === "resolved is not a function",
  )
  assert.deepEqual(failing.phases.filter((phase) => phase.name === "mount_plugins"), [{ name: "mount_plugins", status: "completed" }])
  assert.deepEqual(failing.phases.filter((phase) => phase.name === "materialize_runtime_inputs"), [{ name: "materialize_runtime_inputs", status: "failed" }])
} finally {
  await rm(inputMountSource, { recursive: true, force: true })
}

console.log("recipe-runtime-setup empty extra plugins materialize phase ok")
