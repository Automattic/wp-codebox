import assert from "node:assert/strict"

import type { Runtime, WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { collectRecipeDeclaredArtifacts } from "../packages/cli/src/commands/recipe-declared-artifacts.js"
import { recipeInputMountPathMap } from "../packages/cli/src/input-mount-paths.js"

const declaredPath = "/home/wpcom/public_html/evidence/receipt.json"
const payload = { schema: "example/receipt/v1", status: "completed" }
const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    mounts: [{ source: "site", target: "/home/wpcom/public_html", mode: "readwrite" }],
  },
  workflow: { steps: [] },
  artifacts: {
    typed: [{ name: "receipt", type: "example/receipt", path: declaredPath, parseJson: true }],
  },
}
const mappings = recipeInputMountPathMap(recipe)
const effectivePath = `${mappings[0]!.canonicalTarget}/evidence/receipt.json`
let executedCode = ""
const runtime = {
  execute: async (spec: { args?: string[] }) => {
    executedCode = spec.args?.[0] ?? ""
    return {
      stdout: JSON.stringify({
        exists: true,
        type: "file",
        size: JSON.stringify(payload).length,
        sha256: "a".repeat(64),
        parsedJson: payload,
        contentBase64: Buffer.from(JSON.stringify(payload)).toString("base64"),
      }),
      stderr: "",
      exitCode: 0,
    }
  },
} as unknown as Runtime

const [artifact] = await collectRecipeDeclaredArtifacts(recipe, runtime, mappings)
assert.match(executedCode, new RegExp(effectivePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
assert.equal(executedCode.includes(declaredPath), false)
assert.equal(artifact?.path, declaredPath)
assert.equal(artifact?.status, "collected")
assert.deepEqual(artifact?.parsedJson, payload)
