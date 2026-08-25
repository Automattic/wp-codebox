import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { normalizeReleasePlatform, releaseTargetMatchesHost } from "../scripts/lib/release-target.ts"

test("normalizes Node platform names to release target names", () => {
  assert.equal(normalizeReleasePlatform("darwin"), "macos")
  assert.equal(normalizeReleasePlatform("win32"), "windows")
  assert.equal(normalizeReleasePlatform("linux"), "linux")
})

test("executes release packages only on a compatible host target", () => {
  assert.equal(releaseTargetMatchesHost("linux-x64", "linux", "x64"), true)
  assert.equal(releaseTargetMatchesHost("linux-x64", "darwin", "arm64"), false)
  assert.equal(releaseTargetMatchesHost("macos-arm64", "darwin", "arm64"), true)
  assert.equal(releaseTargetMatchesHost("windows-x64", "win32", "x64"), true)
})

test("release versioning covers every workspace package in npm-shrinkwrap", async () => {
  const [manifest, shrinkwrap, homeboy] = await Promise.all([
    readFile("package.json", "utf8").then(JSON.parse),
    readFile("npm-shrinkwrap.json", "utf8").then(JSON.parse),
    readFile("homeboy.json", "utf8").then(JSON.parse),
  ])
  const target = homeboy.version_targets.find(({ file }: { file: string }) => file === "npm-shrinkwrap.json")
  assert(target, "npm-shrinkwrap.json must be a release version target")
  const versions = [...JSON.stringify(shrinkwrap, null, 2).matchAll(new RegExp(target.pattern.replace("(?s)", ""), "gs"))].map((match) => match[1])
  assert.equal(versions.length, 5)
  assert.deepEqual([...new Set(versions)], [manifest.version])
})
