import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

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

const directorySource = await mkdtemp(join(tmpdir(), "wp-codebox-directory-materialization-"))
const readableDirectories = new Set<string>()
const directoryWrites: Record<string, string> = {}

try {
  await mkdir(join(directorySource, "bin", "tests", "i18n-tools", "fixtures", "empty"), { recursive: true })
  await writeFile(join(directorySource, "bin", "tests", "i18n-tools", "phpunit.xml"), "<phpunit />")

  const result = await materializePlaygroundStagedInputs({
    playground: {
      async run({ code }: { code: string }) {
        const payload = materializationPayload(code)
        for (const directory of payload.directories ?? []) {
          readableDirectories.add(directory)
        }
        return { text: JSON.stringify({ created: payload.directories?.length ?? 0, skipped: 0 }) }
      },
      async writeFile(target: string, contents: string) {
        if (!readableDirectories.has(dirname(target))) {
          throw new Error(`sandbox directory was not materialized before write: ${dirname(target)}`)
        }
        directoryWrites[target] = contents
      },
    },
  } as never, [{
    type: "directory",
    source: directorySource,
    target: "/home/example/public_html",
    mode: "readonly",
  }])

  assert.equal(result.materialized, 1)
  assert.equal(result.phaseResult.status, "completed")
  assert.equal(readableDirectories.has("/home/example/public_html"), true, "mount target is created")
  assert.equal(readableDirectories.has("/home/example/public_html/bin/tests/i18n-tools"), true, "nested cwd target is created")
  assert.equal(readableDirectories.has("/home/example/public_html/bin/tests/i18n-tools/fixtures/empty"), true, "empty subdirectories are created")
  assert.equal(directoryWrites["/home/example/public_html/bin/tests/i18n-tools/phpunit.xml"], "<phpunit />")
} finally {
  await rm(directorySource, { recursive: true, force: true })
}

function materializationPayload(code: string): { directories?: string[] } {
  const match = code.match(/\$payload = json_decode\((.*), true\);/)
  assert.ok(match, "materialization PHP includes a JSON payload")
  return JSON.parse(JSON.parse(match[1]))
}

console.log("mount materialization ok")
