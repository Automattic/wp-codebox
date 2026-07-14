import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validatedExecutionChanges } from "../packages/cli/src/commands/agent-task-run.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-canonical-evidence-"))
const artifacts = join(root, "artifacts")
const changedPath = join(artifacts, "files", "changed-files.json")
const patchPath = join(artifacts, "files", "patch.diff")
const patch = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n"
const changed = { schema: "wp-codebox/changed-files/v1", files: [{ relativePath: "README.md", status: "modified" }] }

const agentResult = (overrides: Record<string, unknown> = {}) => ({
  changedFiles: { count: 1, bytes: Buffer.byteLength(JSON.stringify(changed)), artifact: "files/changed-files.json" },
  patch: { bytes: Buffer.byteLength(patch), artifact: "files/patch.diff" },
  ...overrides,
})

try {
  await mkdir(join(artifacts, "files"), { recursive: true })
  assert.equal(await validatedExecutionChanges(agentResult(), artifacts), undefined, "counters alone are not evidence")

  await writeFile(changedPath, JSON.stringify(changed))
  await writeFile(patchPath, patch)
  const valid = await validatedExecutionChanges(agentResult(), artifacts)
  assert.deepEqual(valid?.refs.map((ref) => ref.kind), ["codebox-changed-files", "codebox-patch"], "valid captured canonical refs are semantic evidence")

  await rm(patchPath)
  assert.equal(await validatedExecutionChanges(agentResult(), artifacts), undefined, "missing canonical files cannot satisfy semantic outputs")
  await writeFile(patchPath, "")
  assert.equal(await validatedExecutionChanges(agentResult(), artifacts), undefined, "empty patches cannot satisfy semantic outputs")
  await writeFile(patchPath, patch.replaceAll("README.md", "other.md"))
  assert.equal(await validatedExecutionChanges(agentResult(), artifacts), undefined, "mismatched paths cannot satisfy semantic outputs")
  await writeFile(patchPath, patch)
  assert.equal(await validatedExecutionChanges(agentResult({ patch: { bytes: 1, artifact: "files/patch.diff" } }), artifacts), undefined, "counter and capture mismatches cannot satisfy semantic outputs")
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("agent task canonical evidence ok")
