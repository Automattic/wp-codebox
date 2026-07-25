import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { startPlaygroundCliServer, type PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
import { stageReadonlyPlaygroundMounts } from "../packages/runtime-playground/src/mount-materialization.js"
import type { BrowserStartupProgressEvent, RuntimeCreateSpec } from "../packages/runtime-core/src/index.js"

const execFileAsync = promisify(execFile)

const root = await mkdtemp(join(tmpdir(), "wp-codebox-readonly-mounts-"))
const readonlySource = join(root, "readonly.bin")
const readwriteSource = join(root, "readwrite.bin")
const wpConfigSource = join(root, "wp-config.php")
const readonlyBytes = Buffer.from([0, 255, 1, 2, 3, 127, 128])
const readwriteBytes = Buffer.from([10, 20, 30])
await writeFile(readonlySource, readonlyBytes)
await writeFile(readwriteSource, readwriteBytes)
await writeFile(wpConfigSource, "<?php // external database config\n")

const spec: RuntimeCreateSpec = {
  backend: "wordpress-playground",
  environment: { version: "6.8", phpVersion: "8.4", blueprint: {} },
  policy: { network: "deny", filesystem: "readwrite-mounts", commands: ["wordpress.run-php"], secrets: "none", approvals: "never" },
}

let mountedReadonlyPath = ""
const startupProgress: BrowserStartupProgressEvent[] = []
const cliModule: PlaygroundCliModule = {
  async runCLI(options) {
    const readonlyMount = options.mount.find((mount) => mount.vfsPath === "/readonly")
    const readwriteMount = options.mount.find((mount) => mount.vfsPath === "/readwrite")
    const pluginMount = options.mount.find((mount) => mount.vfsPath === "/wordpress/wp-content/plugins/tracked-symlink-plugin")
    const wpConfigMount = options["mount-before-install"]?.find((mount) => mount.vfsPath === "/wordpress/wp-config.php")
    assert.ok(readonlyMount)
    assert.ok(readwriteMount)
    assert.ok(pluginMount)
    assert.ok(wpConfigMount)
    assert.match(await readFile(join(pluginMount.hostPath, "plugin.php"), "utf8"), /Plugin Name: Tracked Symlink Fixture/)
    assert.equal(await readFile(join(pluginMount.hostPath, "includes", "runtime.php"), "utf8"), "<?php return 'runtime';\n")
    assert.equal(await readFile(join(pluginMount.hostPath, "runtime-link.php"), "utf8"), "<?php return 'runtime';\n")
    assert.equal(await readFile(join(pluginMount.hostPath, "runtime-chain.php"), "utf8"), "<?php return 'runtime';\n")
    await assert.rejects(access(join(pluginMount.hostPath, "build.sh")), /ENOENT/)
    await assert.rejects(access(join(pluginMount.hostPath, "build-chain.sh")), /ENOENT/)
    await assert.rejects(access(join(pluginMount.hostPath, "host-secret.php")), /ENOENT/)
    await assert.rejects(access(join(pluginMount.hostPath, "host-secret-chain.php")), /ENOENT/)
    await assert.rejects(access(join(pluginMount.hostPath, "prefix-secret.php")), /ENOENT/)
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
  const pluginSource = join(root, "tracked-symlink-plugin")
  const prefixConfusionSource = join(root, "tracked-symlink-plugin-private")
  const hostSecret = join(root, "host-secret.php")
  await mkdir(join(pluginSource, "includes"), { recursive: true })
  await mkdir(join(pluginSource, "includes", "node_modules", "nested-package"), { recursive: true })
  await mkdir(join(pluginSource, "package-a", "target", "debug"), { recursive: true })
  await mkdir(prefixConfusionSource)
  await writeFile(join(pluginSource, "plugin.php"), "<?php /* Plugin Name: Tracked Symlink Fixture */\n")
  await writeFile(join(pluginSource, "includes", "runtime.php"), "<?php return 'runtime';\n")
  await writeFile(join(pluginSource, "includes", "node_modules", "nested-package", "ignored.js"), "ignored")
  await writeFile(join(pluginSource, "package-a", "target", "debug", "ignored.bin"), "ignored")
  await writeFile(join(prefixConfusionSource, "secret.php"), "<?php return 'prefix secret';\n")
  await writeFile(hostSecret, "<?php return 'host secret';\n")
  await symlink("includes/runtime.php", join(pluginSource, "runtime-link.php"))
  await symlink("runtime-link.php", join(pluginSource, "runtime-chain.php"))
  await symlink("../../../.github/build.sh", join(pluginSource, "build.sh"))
  await symlink("build.sh", join(pluginSource, "build-chain.sh"))
  await symlink("../host-secret.php", join(pluginSource, "host-secret.php"))
  await symlink("host-secret.php", join(pluginSource, "host-secret-chain.php"))
  await symlink("../tracked-symlink-plugin-private/secret.php", join(pluginSource, "prefix-secret.php"))
  await mkdir(join(pluginSource, "package-a", "vendor"), { recursive: true })
  await mkdir(join(pluginSource, "package-b", "vendor"), { recursive: true })
  await writeFile(join(pluginSource, "package-a", "package.php"), "<?php return 'package-a';\n")
  await writeFile(join(pluginSource, "package-b", "package.php"), "<?php return 'package-b';\n")
  await symlink("../../package-b", join(pluginSource, "package-a", "vendor", "package-b"))
  await symlink("../../package-a", join(pluginSource, "package-b", "vendor", "package-a"))
  await execFileAsync("git", ["init", "--quiet"], { cwd: pluginSource })
  await execFileAsync("git", ["add", "."], { cwd: pluginSource })
  const trackedSymlinks = (await execFileAsync("git", ["ls-files", "-s", "--", "*.php", "*.sh"], { cwd: pluginSource })).stdout.trim().split("\n").filter((entry) => entry.startsWith("120000 ")).map((entry) => entry.split("\t")[1]).sort()
  assert.deepEqual(trackedSymlinks, ["build-chain.sh", "build.sh", "host-secret-chain.php", "host-secret.php", "prefix-secret.php", "runtime-chain.php", "runtime-link.php"], "all fixture symlinks are tracked by Git")

  const stagingDirectoriesBefore = await readonlyStagingDirectories()
  const staging = await stageReadonlyPlaygroundMounts([
    { source: pluginSource, target: "/wordpress/wp-content/plugins/tracked-symlink-plugin", mode: "readonly" },
  ])
  const stagedPlugin = staging.mounts[0].source
  assert.match(await readFile(join(stagedPlugin, "plugin.php"), "utf8"), /Plugin Name: Tracked Symlink Fixture/, "the plugin entrypoint remains available")
  assert.equal(await readFile(join(stagedPlugin, "includes", "runtime.php"), "utf8"), "<?php return 'runtime';\n", "nested runtime files remain available")
  await assert.rejects(access(join(stagedPlugin, ".git")), /ENOENT/, "Git metadata is excluded from the staged mount")
  await assert.rejects(access(join(stagedPlugin, "includes", "node_modules")), /ENOENT/, "nested JavaScript dependencies are excluded from the staged mount")
  await assert.rejects(access(join(stagedPlugin, "package-a", "target")), /ENOENT/, "nested build outputs are excluded from the staged mount")
  assert.equal(await readFile(join(stagedPlugin, "runtime-link.php"), "utf8"), "<?php return 'runtime';\n", "a contained symlink is dereferenced into the staged mount")
  assert.equal(await readFile(join(stagedPlugin, "runtime-chain.php"), "utf8"), "<?php return 'runtime';\n", "a contained symlink chain is dereferenced into the staged mount")
  assert.equal(await readFile(join(stagedPlugin, "package-a", "vendor", "package-b", "package.php"), "utf8"), "<?php return 'package-b';\n", "a contained directory symlink is dereferenced into the staged mount")
  await assert.rejects(access(join(stagedPlugin, "package-a", "vendor", "package-b", "vendor", "package-a")), /ENOENT/, "a directory cycle stops at the repeated real directory")
  await assert.rejects(access(join(stagedPlugin, "package-b", "vendor", "package-a", "vendor", "package-b")), /ENOENT/, "both cycle directions remain bounded")
  await assert.rejects(access(join(stagedPlugin, "build.sh")), /ENOENT/, "a tracked dangling symlink is not materialized")
  await assert.rejects(access(join(stagedPlugin, "build-chain.sh")), /ENOENT/, "a chained dangling symlink is not materialized")
  await assert.rejects(access(join(stagedPlugin, "host-secret.php")), /ENOENT/, "a symlink escaping the source cannot expose a host file")
  await assert.rejects(access(join(stagedPlugin, "host-secret-chain.php")), /ENOENT/, "a chained escaping symlink cannot expose a host file")
  await assert.rejects(access(join(stagedPlugin, "prefix-secret.php")), /ENOENT/, "a sibling path sharing the source prefix remains outside containment")
  assert.deepEqual(staging.diagnostics.map((diagnostic) => ({ code: diagnostic.code, metadata: diagnostic.metadata })), [
    { code: "readonly-mount-symlink-skipped", metadata: { mountIndex: 0, mountTarget: "/wordpress/wp-content/plugins/tracked-symlink-plugin", path: "build-chain.sh", reason: "dangling-target" } },
    { code: "readonly-mount-symlink-skipped", metadata: { mountIndex: 0, mountTarget: "/wordpress/wp-content/plugins/tracked-symlink-plugin", path: "build.sh", reason: "dangling-target" } },
    { code: "readonly-mount-symlink-skipped", metadata: { mountIndex: 0, mountTarget: "/wordpress/wp-content/plugins/tracked-symlink-plugin", path: "host-secret-chain.php", reason: "source-escape" } },
    { code: "readonly-mount-symlink-skipped", metadata: { mountIndex: 0, mountTarget: "/wordpress/wp-content/plugins/tracked-symlink-plugin", path: "host-secret.php", reason: "source-escape" } },
    { code: "readonly-mount-symlink-skipped", metadata: { mountIndex: 0, mountTarget: "/wordpress/wp-content/plugins/tracked-symlink-plugin", path: "package-a/vendor/package-b/vendor/package-a", reason: "directory-cycle" } },
    { code: "readonly-mount-symlink-skipped", metadata: { mountIndex: 0, mountTarget: "/wordpress/wp-content/plugins/tracked-symlink-plugin", path: "package-b/vendor/package-a/vendor/package-b", reason: "directory-cycle" } },
    { code: "readonly-mount-symlink-skipped", metadata: { mountIndex: 0, mountTarget: "/wordpress/wp-content/plugins/tracked-symlink-plugin", path: "prefix-secret.php", reason: "source-escape" } },
  ], "skipped symlinks produce deterministic structured diagnostics")
  const serializedDiagnostics = JSON.stringify(staging.diagnostics)
  assert.equal(serializedDiagnostics.includes(root), false, "diagnostics do not expose absolute host paths")
  assert.equal(serializedDiagnostics.includes("../../../.github/build.sh"), false, "diagnostics do not expose dangling link targets")
  assert.equal(serializedDiagnostics.includes("../tracked-symlink-plugin-private/secret.php"), false, "diagnostics do not expose escaping link targets")
  assert.deepEqual(staging.phaseResult.metadata, { mounts: 1, skipped: 7, diagnostics: staging.diagnostics }, "staging evidence includes the skip diagnostics")
  await staging[Symbol.asyncDispose]()
  assert.deepEqual(await readonlyStagingDirectories(), stagingDirectoriesBefore, "successful staging cleanup removes its temporary root")

  await assert.rejects(stageReadonlyPlaygroundMounts([
    { source: pluginSource, target: "/wordpress/wp-content/plugins/tracked-symlink-plugin", mode: "readonly" },
    { source: join(root, "missing-plugin"), target: "/wordpress/wp-content/plugins/missing-plugin", mode: "readonly" },
  ]), /ENOENT/)
  assert.deepEqual(await readonlyStagingDirectories(), stagingDirectoriesBefore, "failed staging cleanup removes its partially populated temporary root")

  const beforeReadonlyHash = sha256(await readFile(readonlySource))
  const server = await startPlaygroundCliServer(spec, [
    { type: "file", source: readonlySource, target: "/readonly", mode: "readonly" },
    { type: "file", source: readwriteSource, target: "/readwrite", mode: "readwrite" },
    { type: "file", source: wpConfigSource, target: "/wordpress/wp-config.php", mode: "readonly" },
    { type: "directory", source: pluginSource, target: "/wordpress/wp-content/plugins/tracked-symlink-plugin", mode: "readonly" },
  ], { cliModule, onProgress: (event) => startupProgress.push(event) })

  assert.equal(sha256(await readFile(readonlySource)), beforeReadonlyHash, "readonly source bytes must survive a sandbox overwrite")
  assert.deepEqual(await readFile(readwriteSource), Buffer.from("sandbox overwrite"), "readwrite mounts must retain host-write behavior")
  assert.notEqual(mountedReadonlyPath, readonlySource, "readonly mounts must use a private staged path")
  const mountMaterialization = startupProgress.find((event) => event.phase === "preview:materializing-mounts")?.detail?.materialization
  assert.deepEqual((mountMaterialization as { metadata?: Record<string, unknown> })?.metadata, {
    mounts: 3,
    skipped: 7,
    diagnostics: staging.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      metadata: { ...diagnostic.metadata, mountIndex: 3 },
    })),
  }, "startup progress retains structured symlink skip evidence")

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
