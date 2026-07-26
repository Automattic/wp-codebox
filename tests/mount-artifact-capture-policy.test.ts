import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { validateWorkspaceRecipeJsonSchema, type MountSpec, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { applyRecipeRuntimeSetup, prepareRecipeRuntimeSetup } from "../packages/cli/src/commands/recipe-runtime-setup.js"
import { captureMountedFiles, captureMountDiffs } from "../packages/runtime-playground/src/mounted-artifact-capture.js"

const validRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    mounts: [{
      source: ".",
      target: "/workspace",
      mode: "readwrite",
      captureArtifacts: false,
    }],
  },
  workflow: { steps: [{ command: "wordpress.run-php" }] },
}

assert.equal(validateWorkspaceRecipeJsonSchema(validRecipe).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({
  ...validRecipe,
  inputs: { mounts: [{ ...validRecipe.inputs.mounts[0], captureArtifacts: "disabled" }] },
}).valid, false)

const root = await mkdtemp(join(tmpdir(), "wp-codebox-mount-artifact-policy-"))
const artifactRoot = join(root, "artifacts")
const filesDirectory = join(artifactRoot, "files")
const inputSource = join(root, "large-input")
const mount: MountSpec = {
  type: "directory",
  source: join(root, "source-that-must-not-be-read"),
  target: "/workspace",
  mode: "readwrite",
  captureArtifacts: false,
}
const redactor = { redact: (_path: string, contents: string) => contents }

try {
  await mkdir(inputSource)
  await writeFile(join(inputSource, "fixture.txt"), "fixture")
  const setupRecipe: WorkspaceRecipe = {
    ...validRecipe,
    inputs: { mounts: [{ ...validRecipe.inputs.mounts[0], source: inputSource }] },
  }
  const prepared = await prepareRecipeRuntimeSetup(setupRecipe, root, "wordpress-playground")
  let mountedInput: MountSpec | undefined
  await applyRecipeRuntimeSetup({
    recipe: setupRecipe,
    recipeDirectory: root,
    prepared,
    runtimeSpec: { environment: { kind: "wordpress", name: "test", version: "latest" }, runtimeEnv: {} },
    runtime: {
      async mount(spec: MountSpec) { mountedInput = spec },
    } as never,
    phaseExecutor: {
      tracker: {
        list: () => [],
        async run<T>(_name: string, _data: unknown, operation: () => Promise<T>) { return await operation() },
      },
      async operation<T>(_operation: string, operation: Promise<T> | (() => Promise<T>)) {
        return await (typeof operation === "function" ? operation() : operation)
      },
    } as never,
  })
  assert.equal(prepared.inputMountBaselinePaths.length, 0, "disabled mounts do not create filesystem baselines")
  assert.equal(mountedInput?.captureArtifacts, false, "runtime mount retains the artifact policy")
  assert.equal(mountedInput?.metadata?.baselineSource, undefined)

  const captured = await captureMountedFiles(filesDirectory, [mount], redactor)
  assert.deepEqual(captured.files, [], "disabled mounts do not capture files")
  assert.deepEqual(captured.skipped, [], "disabled mounts are not traversed")

  const diffs = await captureMountDiffs(artifactRoot, filesDirectory, [mount], redactor)
  assert.deepEqual(diffs.mountDiffs, [], "disabled mounts do not extract diffs")
  assert.deepEqual(diffs.changedFiles.files, [])
  assert.equal(diffs.patch, "")
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("mount artifact capture policy ok")
