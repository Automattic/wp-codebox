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
      async run() { return { text: JSON.stringify({ schema: "wp-codebox/host-mount-directory-materialization/v1", created: 1, skipped: 0 }) } },
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
        return { text: JSON.stringify({ schema: "wp-codebox/host-mount-directory-materialization/v1", created: payload.directories?.length ?? 0, skipped: 0 }) }
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

const fallbackSource = await mkdtemp(join(tmpdir(), "wp-codebox-batched-materialization-"))
const fallbackFileBatches: number[] = []

try {
  await mkdir(join(fallbackSource, "files"), { recursive: true })
  for (let index = 0; index < 205; index++) {
    await writeFile(join(fallbackSource, "files", `file-${index}.txt`), `file ${index}`)
  }

  const result = await materializePlaygroundStagedInputs({
    playground: {
      async run({ code }: { code: string }) {
        const payload = materializationPayload(code)
        if (code.includes("wp-codebox/host-mount-materialization/v1")) {
          fallbackFileBatches.push(payload.files?.length ?? 0)
          return { text: JSON.stringify({ schema: "wp-codebox/host-mount-materialization/v1", materialized: payload.files?.length ?? 0, skipped: 0 }) }
        }
        return { text: JSON.stringify({ schema: "wp-codebox/host-mount-directory-materialization/v1", created: payload.directories?.length ?? 0, skipped: 0 }) }
      },
    },
  } as never, [{
    type: "directory",
    source: fallbackSource,
    target: "/workspace/large-tree",
    mode: "readwrite",
  }])

  assert.equal(result.materialized, 205)
  assert.equal(fallbackFileBatches.length, 3, "large fallback writes are split into bounded batches")
  assert.deepEqual(fallbackFileBatches, [100, 100, 5])
} finally {
  await rm(fallbackSource, { recursive: true, force: true })
}

const unreadableTargetSource = await mkdtemp(join(tmpdir(), "wp-codebox-unreadable-target-"))

try {
  await mkdir(join(unreadableTargetSource, "bin", "tests", "i18n-tools"), { recursive: true })
  await writeFile(join(unreadableTargetSource, "bin", "tests", "i18n-tools", "phpunit.xml"), "<phpunit />")

  await assert.rejects(
    materializePlaygroundStagedInputs({
      playground: {
        async run({ code }: { code: string }) {
          const payload = materializationPayload(code)
          return {
            text: JSON.stringify({
              schema: "wp-codebox/host-mount-directory-materialization/v1",
              created: payload.directories?.length ?? 0,
              skipped: 0,
              missing: ["/home/example/public_html/bin/tests/i18n-tools"],
            }),
          }
        },
        async writeFile() {
          throw new Error("files should not be written when directory verification fails")
        },
      },
    } as never, [{
      type: "directory",
      source: unreadableTargetSource,
      target: "/home/example/public_html",
      mode: "readwrite",
    }]),
    /Staged input mount target directories are not readable in the sandbox after materialization: \/home\/example\/public_html\/bin\/tests\/i18n-tools \(missing\)/,
  )
} finally {
  await rm(unreadableTargetSource, { recursive: true, force: true })
}

const failedVerificationSource = await mkdtemp(join(tmpdir(), "wp-codebox-failed-directory-verification-"))

try {
  await mkdir(join(failedVerificationSource, "bin", "tests", "i18n-tools"), { recursive: true })

  await assert.rejects(
    materializePlaygroundStagedInputs({
      playground: {
        async run() {
          return { exitCode: 1, errors: "mkdir failed", text: "" }
        },
        async writeFile() {
          throw new Error("files should not be written when directory verification exits non-zero")
        },
      },
    } as never, [{
      type: "directory",
      source: failedVerificationSource,
      target: "/home/example/public_html",
      mode: "readwrite",
    }]),
    /playground-staged-input-mkdir failed with exit code 1/,
  )
} finally {
  await rm(failedVerificationSource, { recursive: true, force: true })
}

const malformedVerificationSource = await mkdtemp(join(tmpdir(), "wp-codebox-malformed-directory-verification-"))

try {
  await mkdir(join(malformedVerificationSource, "bin", "tests", "i18n-tools"), { recursive: true })

  await assert.rejects(
    materializePlaygroundStagedInputs({
      playground: {
        async run() {
          return { text: "" }
        },
        async writeFile() {
          throw new Error("files should not be written when directory verification omits its schema")
        },
      },
    } as never, [{
      type: "directory",
      source: malformedVerificationSource,
      target: "/home/example/public_html",
      mode: "readwrite",
    }]),
    /playground-staged-input-mkdir did not return wp-codebox\/host-mount-directory-materialization\/v1/,
  )
} finally {
  await rm(malformedVerificationSource, { recursive: true, force: true })
}

function materializationPayload(code: string): { directories?: string[]; files?: Array<{ target: string; contentsBase64: string }> } {
  const match = code.match(/\$payload = json_decode\((.*), true\);/)
  assert.ok(match, "materialization PHP includes a JSON payload")
  return JSON.parse(JSON.parse(match[1]))
}

console.log("mount materialization ok")
