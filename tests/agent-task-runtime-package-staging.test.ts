import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { buildAgentTaskRecipe } from "../packages/runtime-core/src/agent-task-recipe.js"
import type { TaskInput } from "../packages/runtime-core/src/task-input.js"
import { withTempDir } from "../scripts/test-kit.js"

const taskInput: TaskInput = {
  schema: "wp-codebox/task-input/v1",
  version: 1,
  goal: "Replay runtime package",
  target: {},
  allowed_tools: [],
  expected_artifacts: [],
  structured_artifacts: [],
  staged_files: [],
  agent_bundles: [],
  tool_bridge: {},
  parent_tool_bridge: {},
  sandbox_tool_policy: {},
  policy: {},
  context: {},
}

await withTempDir("wp-codebox-runtime-package-staging-", async (root) => {
  const previousCwd = process.cwd()
  const workspaceRoot = join(root, "wp-site-generator")
  const bundleSource = join(workspaceRoot, "bundles", "store-idea-agent")
  await mkdir(bundleSource, { recursive: true })

  try {
    process.chdir(workspaceRoot)
    const runtimeTask = {
      kind: "bundle",
      ability: "wp-codebox/run-runtime-package",
      input: {
        schema: "wp-codebox/runtime-package-task/v1",
        package: {
          slug: "store-idea-agent",
          source: "/workspace/wp-site-generator/bundles/store-idea-agent",
        },
        workflow: { id: "store-idea-agent" },
        input: { prompt: "Generate store idea" },
        artifact_declarations: [],
        required_artifacts: [],
      },
    }
    const recipe = buildAgentTaskRecipe({ runtime_task: runtimeTask }, taskInput, "latest")
    assert.equal(recipe.inputs?.stagedFiles?.length, 1)
    assert.equal(recipe.inputs?.stagedFiles?.[0]?.target, "/workspace/wp-site-generator/bundles/store-idea-agent")
    assert.ok(recipe.inputs?.stagedFiles?.[0]?.source.endsWith("/wp-site-generator/bundles/store-idea-agent"))

    const runtimeTaskArg = recipe.workflow.steps[0].args?.find((arg) => arg.startsWith("runtime-task-json="))
    assert.ok(runtimeTaskArg)
    const encodedRuntimeTask = JSON.parse(runtimeTaskArg.slice("runtime-task-json=".length))
    assert.deepEqual(encodedRuntimeTask.input.package, runtimeTask.input.package)
    assert.equal(JSON.stringify(encodedRuntimeTask).includes("runtime_package"), false)
  } finally {
    process.chdir(previousCwd)
  }
})

await withTempDir("wp-codebox-runtime-package-staging-dedupe-", async (root) => {
  const previousCwd = process.cwd()
  const workspaceRoot = join(root, "wp-site-generator")
  const bundleSource = join(workspaceRoot, "bundles", "store-idea-agent")
  await mkdir(bundleSource, { recursive: true })

  try {
    process.chdir(workspaceRoot)
    const recipe = buildAgentTaskRecipe({
      stagedFiles: [{ source: bundleSource, target: "/workspace/wp-site-generator/bundles/store-idea-agent" }],
      runtime_task: {
        input: {
          package: {
            slug: "store-idea-agent",
            source: "/workspace/wp-site-generator/bundles/store-idea-agent",
          },
        },
      },
    }, taskInput, "latest")
    assert.deepEqual(recipe.inputs?.stagedFiles, [{ source: bundleSource, target: "/workspace/wp-site-generator/bundles/store-idea-agent" }])
  } finally {
    process.chdir(previousCwd)
  }
})

console.log("agent task runtime package staging ok")
