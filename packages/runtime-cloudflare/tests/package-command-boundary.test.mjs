import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import { resolve, sep } from "node:path"

const packageRoot = resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"))
const packageRequire = createRequire(resolve(packageRoot, "package.json"))
const corePackagePath = packageRequire.resolve("@automattic/wp-codebox-core/package.json")
const corePackage = JSON.parse(await readFile(corePackagePath, "utf8"))

assert.ok(corePackagePath.startsWith(`${packageRoot}${sep}vendor${sep}`), "the compatible core contract must resolve from package-owned vendored source")
assert.equal(packageJson.wpCodeboxCoreCompatibility, corePackage.version)
assert.equal(corePackage.version, "0.26.2")

for (const name of [
  "test",
  "test:queue",
  "test:principal-credentials",
  "test:remote-principal-credential-gate",
  "local-gate",
  "local-gate:d1",
  "local-gate:provisioning",
  "remote-gate:principal-credentials",
  "generate:wordpress-runtime-corpus",
  "provision:wordpress-runtime-corpus",
  "provision:d1-coordinator",
  "operator:principal-credential",
  "generate:mdi-runtime-bundle",
  "generate:canonical-mdi-seed",
]) {
  const command = packageJson.scripts[name]
  assert.ok(command, `missing package-owned command ${name}`)
  assert.doesNotMatch(command, /cd \.\.\/\.\.|packages\/runtime-|\.\.\/\.\.\//, `${name} must not escape the package`)
  if (name.startsWith("local-gate")) assert.match(command, /^playwright install chromium && /, `${name} must provision its pinned package-owned browser`)
}

assert.doesNotMatch(packageJson.scripts.test, /register-package-local-loader/, "package tests must use normal package-local resolution")

for (const path of [
  "scripts/local-gate.mjs",
  "scripts/remote-principal-credential-gate.mjs",
  "scripts/generate-wordpress-runtime-corpus.ts",
  "scripts/provision-wordpress-runtime-corpus.mjs",
  "scripts/provision-d1-coordinator.mjs",
  "scripts/operator-principal-credential.ts",
  "scripts/build-mdi-runtime-bundle.mjs",
  "scripts/build-canonical-mdi-seed.php",
]) {
  const source = await readFile(resolve(packageRoot, path), "utf8")
  assert.doesNotMatch(source, /packages\/runtime-(?:core|playground|cloudflare)|runtime-playground\/dist|\.\.\/\.\.\//, `${path} must not resolve through the checkout root`)
}
