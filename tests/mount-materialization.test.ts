import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { materializePlaygroundStagedInputs } from "../packages/runtime-playground/src/mount-materialization.js"

const source = await mkdtemp(join(tmpdir(), "wp-codebox-mount-materialization-"))
const writes: Record<string, string> = {}

try {
  await mkdir(join(source, "src"), { recursive: true })
  await mkdir(join(source, "node_modules", "large-package"), { recursive: true })
  await writeFile(join(source, "src", "example.php"), "<?php echo 'ok';")
  await writeFile(join(source, "node_modules", "large-package", "ignored.php"), "<?php echo 'ignored';")

  const result = await materializePlaygroundStagedInputs({
    playground: {
      async run() { return { text: JSON.stringify({ created: 1, skipped: 0 }) } },
      async writeFile(target: string, contents: string) { writes[target] = contents },
    },
  } as never, [{
    type: "directory",
    source,
    target: "/wordpress/project",
    mode: "readwrite",
  }])

  assert.equal(result.materialized, 1)
  assert.deepEqual(Object.keys(writes), ["/wordpress/project/src/example.php"])
  assert.equal(writes["/wordpress/project/src/example.php"], "<?php echo 'ok';")
} finally {
  await rm(source, { recursive: true, force: true })
}

console.log("mount materialization ok")
