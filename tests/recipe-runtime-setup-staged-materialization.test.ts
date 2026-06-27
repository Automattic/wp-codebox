import assert from "node:assert/strict"

import { applyRecipeRuntimeSetup, type PreparedRecipeRuntimeSetup } from "../packages/cli/src/commands/recipe-runtime-setup.js"
import type { Runtime, WorkspaceRecipe } from "../packages/runtime-core/src/public.js"

const calls: string[] = []
const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { backend: "wordpress-playground" },
  inputs: {},
  workflow: { steps: [] },
}
const prepared: PreparedRecipeRuntimeSetup = {
  workspaceMounts: [],
  extraPlugins: [],
  dependencyOverlays: [],
  overlays: [],
  inputMountBaselinePaths: [],
  stagedFiles: [{
    source: "/tmp/host-bundle",
    originalSource: "/tmp/host-bundle",
    sourceRef: "/tmp/host-bundle",
    target: "/workspace/example/bundles/runtime-agent",
    type: "directory",
    cleanupPaths: [],
    provenance: { type: "local", source: "/tmp/host-bundle" },
    metadata: { kind: "runtime-package-source" },
  }],
}

const runtime = {
  async info() { return { id: "runtime", backend: "wordpress-playground", environment: { kind: "wordpress" }, createdAt: new Date().toISOString(), status: "running" } },
  async mount(spec) { calls.push(`mount:${spec.target}`) },
  async materializeMounts(mounts) {
    calls.push(`materialize:${mounts.map((mount) => mount.target).join(",")}`)
    assert.deepEqual(mounts, [{
      type: "directory",
      source: "/tmp/host-bundle",
      target: "/workspace/example/bundles/runtime-agent",
      mode: "readwrite",
      metadata: { kind: "runtime-package-source" },
    }])
  },
  async execute(spec) { calls.push(`execute:${spec.command}`); throw new Error("setup should not execute commands in this fixture") },
  async observe() { throw new Error("unused") },
  async snapshot() { throw new Error("unused") },
  async collectArtifacts() { throw new Error("unused") },
  async destroy() {},
} satisfies Runtime

const phaseExecutor = {
  tracker: {
    complete(name: string) { calls.push(`phase.complete:${name}`) },
    async run<T>(name: string, _data: unknown, callback: () => Promise<T>) { calls.push(`phase.run:${name}`); return await callback() },
    list() { return [] },
  },
  async operation<T>(operation: string, promiseOrFactory: Promise<T> | (() => Promise<T>)) {
    calls.push(`operation:${operation}`)
    return await (typeof promiseOrFactory === "function" ? promiseOrFactory() : promiseOrFactory)
  },
}

await applyRecipeRuntimeSetup({ recipe, recipeDirectory: process.cwd(), runtime, prepared, phaseExecutor: phaseExecutor as never })

const mountIndex = calls.indexOf("mount:/workspace/example/bundles/runtime-agent")
const materializeOperationIndex = calls.indexOf("operation:staged-file.materialize")
const materializeIndex = calls.indexOf("materialize:/workspace/example/bundles/runtime-agent")
assert.ok(mountIndex >= 0, "staged source is mounted")
assert.ok(materializeOperationIndex > mountIndex, "materialization is scheduled after staged mount")
assert.ok(materializeIndex > materializeOperationIndex, "materialization runs inside the setup phase before commands")
assert.equal(calls.some((call) => call.startsWith("execute:")), false)

console.log("recipe runtime setup staged materialization ok")
