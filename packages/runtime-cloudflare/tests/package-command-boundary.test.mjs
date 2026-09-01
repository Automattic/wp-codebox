import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import { resolve, sep } from "node:path"

const packageRoot = resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"))
const readme = await readFile(resolve(packageRoot, "README.md"), "utf8")
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

for (const [, command] of readme.matchAll(/`(npm (?:ci|test|run|exec)[^`]*)`/g)) {
  const script = command.match(/^npm run ([a-z0-9:-]+)(?:\s|$)/)?.[1]
  if (script) assert.ok(packageJson.scripts[script], `README advertises missing package script ${script}`)
  else if (command === "npm test") assert.ok(packageJson.scripts.test, "README's npm test command must resolve to the package test script")
  else if (command === "npm ci --workspaces=false") await readFile(resolve(packageRoot, "npm-shrinkwrap.json"))
  else if (command.startsWith("npm exec -- wrangler ")) assert.ok(packageJson.dependencies.wrangler, "README's npm exec Wrangler command must resolve to a package dependency")
  else assert.fail(`README advertises an unvalidated command: ${command}`)
}
for (const [, name] of readme.matchAll(/`((?:generate|provision|operator|remote-gate|dry-run|local-gate):[a-z0-9:-]+)`/g)) {
  assert.ok(packageJson.scripts[name], `README references missing package script ${name}`)
}
assert.doesNotMatch(readme, /npm (?:--prefix|run cloudflare:)|packages\/runtime-cloudflare|\]\(\.\.\//, "README commands and links must work outside the repository checkout")
for (const [, config] of readme.matchAll(/--config ([a-z0-9.-]+\.jsonc)/g)) {
  await readFile(resolve(packageRoot, config))
}

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
