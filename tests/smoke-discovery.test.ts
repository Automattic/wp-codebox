import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { discoveredCommands, discoveredParallelCommands, discoveredSerialCommands } from "../scripts/smoke-discovery.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-smoke-discovery-"))

try {
  await mkdir(join(root, "tests"))
  await mkdir(join(root, "scripts"))
  await writeFile(join(root, "tests", "parallel.test.ts"), "")
  await writeFile(join(root, "tests", "recipe-step-continuation.integration.test.ts"), "")
  await writeFile(join(root, "tests", "playground-readonly-mounts-integration.test.ts"), "")
  await writeFile(join(root, "tests", "browser-fixture.browser.test.ts"), "")
  await writeFile(join(root, "scripts", "native-smoke.php"), "")

  assert.deepEqual(discoveredParallelCommands(root, "fast"), [
    { name: "scripts/native-smoke.php", command: "php", args: ["scripts/native-smoke.php"] },
    { name: "tests/parallel.test.ts", command: "tsx", args: ["--no-cache", "tests/parallel.test.ts"] },
  ])
  assert.deepEqual(discoveredParallelCommands(root, "integration"), [])
  assert.deepEqual(discoveredSerialCommands(root, "integration"), [
    { name: "tests/playground-readonly-mounts-integration.test.ts", command: "tsx", args: ["tests/playground-readonly-mounts-integration.test.ts"] },
    { name: "tests/recipe-step-continuation.integration.test.ts", command: "tsx", args: ["tests/recipe-step-continuation.integration.test.ts"] },
  ])
  assert.deepEqual(discoveredParallelCommands(root, "browser"), [])
  assert.deepEqual(discoveredSerialCommands(root, "browser"), [
    { name: "tests/browser-fixture.browser.test.ts", command: "tsx", args: ["tests/browser-fixture.browser.test.ts"] },
  ])
  assert.deepEqual(
    [...discoveredParallelCommands(root, "all"), ...discoveredSerialCommands(root, "all")].map((command) => command.name).sort(),
    discoveredCommands(root).map((command) => command.name).sort(),
    "the exhaustive lane composes every discovered file exactly once",
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
