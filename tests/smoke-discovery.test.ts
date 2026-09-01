import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { discoveredParallelCommands, discoveredSerialCommands } from "../scripts/smoke-discovery.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-smoke-discovery-"))

try {
  await mkdir(join(root, "tests"))
  await mkdir(join(root, "scripts"))
  await writeFile(join(root, "tests", "parallel.test.ts"), "")
  await writeFile(join(root, "tests", "recipe-step-continuation.integration.test.ts"), "")
  await writeFile(join(root, "scripts", "native-smoke.php"), "")

  assert.deepEqual(discoveredParallelCommands(root), [
    { name: "scripts/native-smoke.php", command: "php", args: ["scripts/native-smoke.php"] },
    { name: "tests/parallel.test.ts", command: "tsx", args: ["--no-cache", "tests/parallel.test.ts"] },
  ])
  assert.deepEqual(discoveredSerialCommands(root), [
    { name: "tests/recipe-step-continuation.integration.test.ts", command: "tsx", args: ["tests/recipe-step-continuation.integration.test.ts"] },
  ])
} finally {
  await rm(root, { recursive: true, force: true })
}
