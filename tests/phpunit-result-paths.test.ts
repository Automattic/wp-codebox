import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.js"
import { captureCommandResultPaths } from "../packages/runtime-playground/src/wordpress-command-runners.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-result-paths-"))
try {
  const files = new Map<string, string>([
    ["/tmp/result.json", JSON.stringify({ schema: "example/result/v1", token: "secret-token" })],
    ["/tmp/malformed.json", "{"],
    ["/tmp/oversized.json", JSON.stringify({ payload: "x".repeat(128) })],
  ])
  const server = { playground: { readFileAsText: async (path: string) => {
    const contents = files.get(path)
    if (contents === undefined) throw new Error("ENOENT")
    return contents
  } } }

  const refs = await captureCommandResultPaths(server, { resultPaths: [{ name: "result", type: "example/result/v1", path: "/tmp/result.json" }] }, root)
  assert.equal(refs.length, 1)
  assert.equal(refs[0]?.id, "result")
  const captured = await readFile(join(root, "files/command-results/result.json"), "utf8")
  assert.doesNotMatch(captured, /secret-token/)

  await assert.doesNotReject(captureCommandResultPaths(server, { resultPaths: [{ name: "missing", type: "example/result/v1", path: "/tmp/missing.json", required: false }] }, root))
  for (const resultPaths of [
    [{ name: "bad", type: "example/result/v1", path: "/tmp/malformed.json" }],
    [{ name: "large", type: "example/result/v1", path: "/tmp/oversized.json", maxBytes: 16 }],
    [{ name: "escape", type: "example/result/v1", path: "/tmp/../secret.json" }],
    [{ name: "same", type: "example/result/v1", path: "/tmp/result.json" }, { name: "same", type: "example/result/v1", path: "/tmp/other.json" }],
  ]) {
    await assert.rejects(captureCommandResultPaths(server, { resultPaths }, root), /Command result-path collection failed/)
  }

  const issues = await validateWorkspaceRecipeSemantics({
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: { steps: [{ command: "wordpress.phpunit", resultPaths: [
      { name: "same", type: "example/result/v1", path: "/tmp/result.json" },
      { name: "same", type: "example/result/v1", path: "/tmp/result.json" },
    ] }] },
  }, join(root, "recipe.json"))
  assert.deepEqual(issues.filter((issue) => issue.code.startsWith("duplicate-result-path-")).map((issue) => issue.code), ["duplicate-result-path-name", "duplicate-result-path-source"])
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("phpunit result path capture boundaries ok")
