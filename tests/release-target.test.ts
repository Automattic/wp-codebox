import assert from "node:assert/strict"
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
