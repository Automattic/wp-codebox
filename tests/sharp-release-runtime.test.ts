import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { materializeSharpReleaseRuntime, materializeVerifiedPackageTarball, sharpRuntimePackageNames } from "../scripts/lib/materialize-sharp-release-runtime.ts"

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, "..")

test("maps supported release targets to only their Sharp runtime packages", () => {
  assert.deepEqual(sharpRuntimePackageNames("linux", "x64"), ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"])
  assert.deepEqual(sharpRuntimePackageNames("linux", "arm64"), ["@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64"])
  assert.deepEqual(sharpRuntimePackageNames("macos", "x64"), ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"])
  assert.deepEqual(sharpRuntimePackageNames("macos", "arm64"), ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"])
  assert.deepEqual(sharpRuntimePackageNames("windows", "x64"), ["@img/sharp-win32-x64"])
  assert.deepEqual(sharpRuntimePackageNames("windows", "arm64"), ["@img/sharp-win32-arm64"])
})

test("all supported runtime packages have immutable shrinkwrap provenance", async () => {
  const shrinkwrap = JSON.parse(await readFile(join(repositoryRoot, "npm-shrinkwrap.json"), "utf8")) as {
    packages: Record<string, { version?: string; resolved?: string; integrity?: string }>
  }
  for (const [platformName, archName] of [
    ["linux", "x64"], ["linux", "arm64"],
    ["macos", "x64"], ["macos", "arm64"],
    ["windows", "x64"], ["windows", "arm64"],
  ]) {
    for (const packageName of sharpRuntimePackageNames(platformName, archName)) {
      const lockedPackage = shrinkwrap.packages[`node_modules/${packageName}`]
      assert.ok(lockedPackage?.version, `${packageName} must have a locked version`)
      assert.match(lockedPackage.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${packageName} must have a locked tarball`)
      assert.match(lockedPackage.integrity ?? "", /^sha512-/, `${packageName} must have locked SRI`)
    }
  }
})

test("runtime-playground and the published aggregate package own Sharp", async () => {
  const rootPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> }
  const playgroundPackage = JSON.parse(await readFile(join(repositoryRoot, "packages", "runtime-playground", "package.json"), "utf8")) as { dependencies: Record<string, string> }
  assert.equal(rootPackage.dependencies.sharp, "0.35.3")
  assert.equal(playgroundPackage.dependencies.sharp, "0.35.3")
})

test("rejects an unsupported release target clearly", () => {
  assert.throws(
    () => sharpRuntimePackageNames("linux", "ia32"),
    /No Sharp native runtime mapping exists for release target linux-ia32\. Supported targets: linux-arm64, linux-x64, macos-arm64, macos-x64, windows-arm64, windows-x64\./,
  )
})

test("materializes an integrity-verified package tarball without network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-sharp-runtime-success-"))
  try {
    const fixture = join(root, "fixture")
    const packed = join(root, "packed")
    await mkdir(fixture, { recursive: true })
    await mkdir(packed, { recursive: true })
    await writeFile(join(fixture, "package.json"), `${JSON.stringify({ name: "@img/test-runtime", version: "1.0.0", files: ["runtime.node"] })}\n`)
    await writeFile(join(fixture, "runtime.node"), "native fixture")
    const { stdout } = await execFileAsync("npm", ["pack", fixture, "--pack-destination", packed, "--json", "--ignore-scripts"])
    const [result] = JSON.parse(stdout) as Array<{ filename: string }>
    const tarball = join(packed, result.filename)
    const integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`

    await materializeVerifiedPackageTarball(root, "@img/test-runtime", { version: "1.0.0", integrity }, tarball)
    assert.equal(await readFile(join(root, "node_modules", "@img", "test-runtime", "runtime.node"), "utf8"), "native fixture")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects a package tarball whose bytes do not match locked SRI", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-sharp-runtime-integrity-"))
  try {
    const tarball = join(root, "tampered.tgz")
    await writeFile(tarball, "tampered package bytes")
    await assert.rejects(
      materializeVerifiedPackageTarball(root, "@img/test-runtime", { version: "1.0.0", integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }, tarball),
      /package integrity mismatch/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects a supported target whose locked runtime cannot be materialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-sharp-runtime-test-"))
  try {
    await mkdir(join(root, "node_modules"), { recursive: true })
    const manifestPath = join(root, "npm-shrinkwrap.json")
    await writeFile(manifestPath, `${JSON.stringify({ packages: {} })}\n`)
    await assert.rejects(
      materializeSharpReleaseRuntime(root, manifestPath, "linux", "x64"),
      /Cannot materialize Sharp runtime for release target linux-x64: node_modules\/@img\/sharp-linux-x64 must have version, resolved, and integrity fields/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
