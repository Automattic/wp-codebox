import assert from "node:assert/strict"
import { createHash } from "node:crypto"
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
      async run({ code }: { code: string }) {
        return code.includes("wp-codebox/host-mount-verification/v1")
          ? { text: JSON.stringify({ schema: "wp-codebox/host-mount-verification/v1", repaired: 0, skipped: 0 }) }
          : { text: JSON.stringify({ schema: "wp-codebox/host-mount-directory-materialization/v1", created: 1, skipped: 0 }) }
      },
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
        if (code.includes("wp-codebox/host-mount-verification/v1")) {
          return { text: JSON.stringify({ schema: "wp-codebox/host-mount-verification/v1", repaired: 0, skipped: 0 }) }
        }
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

const silentlyDroppedSource = await mkdtemp(join(tmpdir(), "wp-codebox-silently-dropped-materialization-"))
const verifiedFiles: Record<string, string> = {}

try {
  await mkdir(join(silentlyDroppedSource, "composer"), { recursive: true })
  await writeFile(join(silentlyDroppedSource, "composer", "autoload_real.php"), "<?php require __DIR__ . '/autoload_static.php';")
  await writeFile(join(silentlyDroppedSource, "composer", "autoload_static.php"), "<?php class ComposerStaticInitFixture {}")

  const result = await materializePlaygroundStagedInputs({
    playground: {
      async run({ code }: { code: string }) {
        const payload = materializationPayload(code)
        if (code.includes("wp-codebox/host-mount-verification/v1")) {
          let repaired = 0
          for (const file of payload.files ?? []) {
            const contents = Buffer.from(file.contentsBase64, "base64").toString("utf8")
            if (verifiedFiles[file.target] !== contents) {
              verifiedFiles[file.target] = contents
              repaired++
            }
          }
          return { text: JSON.stringify({ schema: "wp-codebox/host-mount-verification/v1", repaired, skipped: 0 }) }
        }
        return { text: JSON.stringify({ schema: "wp-codebox/host-mount-directory-materialization/v1", created: payload.directories?.length ?? 0, skipped: 0 }) }
      },
      async writeFile(target: string, contents: string) {
        if (!target.endsWith("autoload_static.php")) {
          verifiedFiles[target] = contents
        }
      },
    },
  } as never, [{
    type: "directory",
    source: silentlyDroppedSource,
    target: "/wp-codebox-vendor",
    mode: "readonly",
  }])

  assert.equal(result.materialized, 2)
  assert.equal(verifiedFiles["/wp-codebox-vendor/composer/autoload_static.php"], "<?php class ComposerStaticInitFixture {}", "verification repairs a direct writer that silently omits a generated companion file")
} finally {
  await rm(silentlyDroppedSource, { recursive: true, force: true })
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

const chunkedSource = await mkdtemp(join(tmpdir(), "wp-codebox-chunked-materialization-"))

try {
  const sourcePath = join(chunkedSource, "artifact.bin")
  const contents = Buffer.alloc(1024 * 1024 + 77)
  for (let offset = 0; offset < contents.length; offset++) {
    contents[offset] = (offset * 31 + 255) % 256
  }
  await writeFile(sourcePath, contents)

  const target = "/wordpress/wp-content/uploads/artifact.bin"
  const sandboxFiles = new Map<string, Buffer>([[target, Buffer.from("stale target contents")]])
  const chunkPayloadLengths: number[] = []
  let directWrites = 0
  let verificationPayload: { sha256?: string; contentsBase64?: string } | undefined
  const result = await materializePlaygroundStagedInputs({
    playground: {
      async run({ code }: { code: string }) {
        const payload = materializationPayload(code)
        if (code.includes("wp-codebox/host-mount-chunk-materialization/v1")) {
          const chunk = payload as { target: string; contentsBase64?: string }
          if (chunk.contentsBase64 === undefined) {
            sandboxFiles.set(chunk.target, Buffer.alloc(0))
            return { text: JSON.stringify({ schema: "wp-codebox/host-mount-chunk-materialization/v1", materialized: 0, skipped: 0 }) }
          }
          chunkPayloadLengths.push(chunk.contentsBase64.length)
          sandboxFiles.set(chunk.target, Buffer.concat([sandboxFiles.get(chunk.target) ?? Buffer.alloc(0), Buffer.from(chunk.contentsBase64, "base64")]))
          return { text: JSON.stringify({ schema: "wp-codebox/host-mount-chunk-materialization/v1", materialized: 1, skipped: 0 }) }
        }
        if (code.includes("wp-codebox/host-mount-verification/v1")) {
          verificationPayload = payload.files?.[0]
          const expected = verificationPayload?.sha256
          const actual = sandboxFiles.has(target) ? createHash("sha256").update(sandboxFiles.get(target)!).digest("hex") : undefined
          return { text: JSON.stringify({ schema: "wp-codebox/host-mount-verification/v1", repaired: 0, skipped: expected === actual ? 0 : 1 }) }
        }
        return { text: JSON.stringify({ schema: "wp-codebox/host-mount-directory-materialization/v1", created: payload.directories?.length ?? 0, skipped: 0 }) }
      },
      async writeFile() {
        directWrites++
      },
    },
  } as never, [{ type: "file", source: sourcePath, target, mode: "readwrite" }])

  assert.equal(result.materialized, 1)
  assert.equal(directWrites, 0, "large files never use the whole-file direct writer")
  assert.deepEqual(sandboxFiles.get(target), contents, "chunked writes preserve exact binary bytes and replace existing targets")
  assert.deepEqual(chunkPayloadLengths, [349528, 349528, 349528, 349528, 104])
  assert.equal(verificationPayload?.contentsBase64, undefined, "large-file verification does not embed the file contents")
  assert.match(verificationPayload?.sha256 ?? "", /^[a-f0-9]{64}$/)
} finally {
  await rm(chunkedSource, { recursive: true, force: true })
}

function materializationPayload(code: string): { target?: string; contentsBase64?: string; directories?: string[]; files?: Array<{ target: string; contentsBase64?: string; sha256?: string }> } {
  const match = code.match(/\$payload = json_decode\((.*), true\);/)
  assert.ok(match, "materialization PHP includes a JSON payload")
  return JSON.parse(JSON.parse(match[1]))
}

console.log("mount materialization ok")
