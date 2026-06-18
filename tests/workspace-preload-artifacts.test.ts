import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { withTempDir } from "../scripts/test-kit.js"
import { buildAgentTaskRecipe, normalizeTaskInput, workspacePreloadsFromTaskInputs } from "../packages/runtime-core/src/index.js"

const preloadArtifact = {
  type: "agent-runtime/workspace-preload",
  slug: "source-workspaces",
  source: "runtime-bundle:test",
  payload: {
    schema: "agent-runtime/workspace-preload/v1",
    repositories: [
      { name: "primary", url: "https://github.com/example/primary.git", ref: "main" },
      { name: "support", url: "git@github.com:example/support.git" },
    ],
    meta: { caller: "generic-test" },
  },
}

const taskInput = normalizeTaskInput({
  goal: "prepare generic preloaded workspaces",
  agent_bundles: [{ bundle: { schema: "agents/runtime-bundle/v1", artifacts: [preloadArtifact] } }],
  structured_artifacts: [
    {
      name: "duplicate-source-workspaces",
      type: "agent-runtime/workspace-preload",
      payload: preloadArtifact.payload,
      metadata: {},
      provenance: {},
    },
  ],
})

const preloads = workspacePreloadsFromTaskInputs({
  agent_bundles: taskInput.agent_bundles,
  structured_artifacts: taskInput.structured_artifacts,
})

assert.equal(preloads.length, 1)
assert.equal(preloads[0]?.type, "agent-runtime/workspace-preload")
assert.equal(preloads[0]?.payload.schema, "agent-runtime/workspace-preload/v1")
assert.deepEqual(preloads[0]?.payload.repositories.map((repository) => repository.name), ["primary", "support"])
assert.deepEqual(preloads[0]?.provenance, { source: "agent-bundle", bundleIndex: 0, artifactIndex: 0, name: "source-workspaces" })

const recipe = buildAgentTaskRecipe({ agent_bundles: taskInput.agent_bundles }, taskInput, "latest")
assert.equal(recipe.inputs?.workspace_preloads?.length, 1)
assert.equal(recipe.inputs?.workspace_preloads?.[0]?.payload.repositories[0]?.url, "https://github.com/example/primary.git")
assert.equal(recipe.workflow.steps[0]?.command, "wp-codebox.agent-sandbox-run")

assert.deepEqual(workspacePreloadsFromTaskInputs({
  workspace_preloads: [{
    type: "agent-runtime/workspace-preload",
    payload: { schema: "agent-runtime/workspace-preload/v1", repositories: [{ name: "direct", url: "https://github.com/example/direct.git" }] },
  }],
}).map((preload) => preload.provenance.source), ["direct"])

assert.equal(workspacePreloadsFromTaskInputs({
  workspace_preloads: [{ type: "agent-runtime/workspace-preload", payload: { schema: "agent-runtime/workspace-preload/v1", repositories: [] } }],
}).length, 0)

await withTempDir("wp-codebox-workspace-preload-bundle-", async (root) => {
  const bundleDirectory = join(root, "bundle")
  await mkdir(bundleDirectory, { recursive: true })
  await writeFile(join(bundleDirectory, "bundle.json"), `${JSON.stringify({ schema: "agents/runtime-bundle/v1", artifacts: [preloadArtifact] }, null, 2)}\n`)

  const fromSource = workspacePreloadsFromTaskInputs({ agent_bundles: [{ source: bundleDirectory }] })
  assert.equal(fromSource.length, 1)
  assert.equal(fromSource[0]?.payload.repositories[0]?.name, "primary")
  assert.deepEqual(fromSource[0]?.provenance, { source: "agent-bundle", bundleIndex: 0, artifactIndex: 0, name: "source-workspaces" })
})

console.log("workspace preload artifact contract tests passed")
