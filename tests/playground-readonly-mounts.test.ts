import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startPlaygroundCliServer, type PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
import { stageReadonlyPlaygroundMounts } from "../packages/runtime-playground/src/mount-materialization.js"
import type { RuntimeCreateSpec } from "../packages/runtime-core/src/index.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-readonly-mounts-"))
const readonlySource = join(root, "readonly.bin")
const readwriteSource = join(root, "readwrite.bin")
const readonlyBytes = Buffer.from([0, 255, 1, 2, 3, 127, 128])
const readwriteBytes = Buffer.from([10, 20, 30])
await writeFile(readonlySource, readonlyBytes)
await writeFile(readwriteSource, readwriteBytes)

const spec: RuntimeCreateSpec = {
  backend: "wordpress-playground",
  environment: { version: "6.8", phpVersion: "8.4", blueprint: {} },
  policy: { network: "deny", filesystem: "readwrite-mounts", commands: ["wordpress.run-php"], secrets: "none", approvals: "never" },
}

let mountedReadonlyPath = ""
const cliModule: PlaygroundCliModule = {
  async runCLI(options) {
    const readonlyMount = options.mount.find((mount) => mount.vfsPath === "/readonly")
    const readwriteMount = options.mount.find((mount) => mount.vfsPath === "/readwrite")
    assert.ok(readonlyMount)
    assert.ok(readwriteMount)
    mountedReadonlyPath = readonlyMount.hostPath
    // This is the host path Playground's writable Node mount handler receives.
    await writeFile(readonlyMount.hostPath, Buffer.from("sandbox overwrite"))
    await writeFile(readwriteMount.hostPath, Buffer.from("sandbox overwrite"))
    return {
      serverUrl: "http://127.0.0.1:65535",
      playground: { async run() { return { text: "" } } },
      async [Symbol.asyncDispose]() {},
    }
  },
}

try {
  const danglingSource = join(root, "dangling")
  const largeSource = join(root, "large")
  await mkdir(danglingSource)
  await mkdir(largeSource)
  await symlink("missing.php", join(danglingSource, "build.sh"))
  await Promise.all(Array.from({ length: 500 }, (_, index) => writeFile(join(largeSource, `File${index}.php`), `<?php return ${index};\n`)))
  const stagingDirectoriesBefore = await readonlyStagingDirectories()
  await assert.rejects(stageReadonlyPlaygroundMounts([
    { source: danglingSource, target: "/dangling", mode: "readonly" },
    { source: largeSource, target: "/large", mode: "readonly" },
  ]), /ENOENT/, "the source failure must not be masked by cleanup racing another mount copy")
  assert.deepEqual(await readonlyStagingDirectories(), stagingDirectoriesBefore, "failed concurrent staging must remove its temporary root")

  const beforeReadonlyHash = sha256(await readFile(readonlySource))
  const server = await startPlaygroundCliServer(spec, [
    { type: "file", source: readonlySource, target: "/readonly", mode: "readonly" },
    { type: "file", source: readwriteSource, target: "/readwrite", mode: "readwrite" },
  ], { cliModule })

  assert.equal(sha256(await readFile(readonlySource)), beforeReadonlyHash, "readonly source bytes must survive a sandbox overwrite")
  assert.deepEqual(await readFile(readwriteSource), Buffer.from("sandbox overwrite"), "readwrite mounts must retain host-write behavior")
  assert.notEqual(mountedReadonlyPath, readonlySource, "readonly mounts must use a private staged path")

  await server[Symbol.asyncDispose]()
  await assert.rejects(access(mountedReadonlyPath), /ENOENT/, "readonly mount staging must be removed with the runtime")
} finally {
  await rm(root, { recursive: true, force: true })
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function readonlyStagingDirectories(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith("wp-codebox-readonly-mounts-")).sort()
}

console.log("playground readonly mount isolation ok")
