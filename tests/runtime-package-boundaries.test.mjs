import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const cloudflareRoot = resolve(root, "packages/runtime-cloudflare")
const rootPackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
const rootLock = JSON.parse(await readFile(resolve(root, "npm-shrinkwrap.json"), "utf8"))
const cloudflarePackage = JSON.parse(await readFile(resolve(cloudflareRoot, "package.json"), "utf8"))
const cloudflareLock = JSON.parse(await readFile(resolve(cloudflareRoot, "npm-shrinkwrap.json"), "utf8"))
const corePackage = JSON.parse(await readFile(resolve(root, "packages/runtime-core/package.json"), "utf8"))
const compatibleCorePackage = JSON.parse(await readFile(resolve(cloudflareRoot, "vendor/wp-codebox-core/package.json"), "utf8"))
const coreCompatibility = JSON.parse(await readFile(resolve(cloudflareRoot, "vendor/wp-codebox-core/compatibility.json"), "utf8"))
const cloudflareWorkflow = await readFile(resolve(root, ".github/workflows/cloudflare-check.yml"), "utf8")
const homeboy = JSON.parse(await readFile(resolve(root, "homeboy.json"), "utf8"))

assert.deepEqual(rootPackage.workspaces, ["packages/cli", "packages/runtime-core", "packages/runtime-playground", "packages/wordpress-plugin"])
assert.equal(rootPackage.workspaces.includes("packages/runtime-cloudflare"), false, "runtime-cloudflare must not join the default install lane")
assert.equal(rootLock.packages?.["packages/runtime-cloudflare"], undefined, "the root shrinkwrap must not retain extraneous Cloudflare package metadata")
assert.equal(rootPackage.overrides?.["@php-wasm/stream-compression"], undefined, "the Cloudflare-only stream patch must not retain root override ownership")
for (const dependency of ["@cloudflare/workers-types", "wrangler"]) {
  assert.equal(rootPackage.devDependencies?.[dependency], undefined, `${dependency} must not be installed by the main lane`)
  assert.ok(cloudflarePackage.devDependencies?.[dependency], `${dependency} must be owned by runtime-cloudflare`)
}
assert.equal(cloudflarePackage.dependencies?.["@automattic/wp-codebox-core"], "file:vendor/wp-codebox-core", "the packed runtime must own an explicit compatible core contract dependency")
assert.equal(cloudflarePackage.peerDependencies?.["@automattic/wp-codebox-core"], undefined, "package-owned runtime assets must not retain an optional core peer")
assert.equal(cloudflareLock.packages?.[""]?.dependencies?.["@automattic/wp-codebox-core"], "file:vendor/wp-codebox-core")
assert.equal(cloudflarePackage.wpCodeboxCoreCompatibility, corePackage.version)
assert.equal(cloudflarePackage.wpCodeboxCoreCompatibilityManifest, "vendor/wp-codebox-core/compatibility.json")
assert.equal(compatibleCorePackage.version, corePackage.version)
assert.equal(coreCompatibility.version, corePackage.version)

for (const script of ["build", "check", "test", "test:packed-wrangler", "package:dry-run", "local-gate", "local-gate:d1", "local-gate:provisioning"]) {
  assert.ok(cloudflarePackage.scripts?.[script], `runtime-cloudflare must own ${script}`)
}
assert.equal(cloudflarePackage.scripts?.postinstall, "node scripts/apply-development-patch.mjs", "the package install must apply its required stream-compression patch")
assert.ok(cloudflarePackage.dependencies?.["patch-package"], "packed installs must receive the package-owned patch tool used by postinstall")
assert.deepEqual(cloudflarePackage.bundleDependencies, ["@automattic/wp-codebox-core", "@php-wasm/stream-compression", "@php-wasm/universal", "@php-wasm/web-8-5", "@wp-playground/wordpress", "patch-package"], "packed installs must carry the shared contract, every required runtime dependency, and patch tool")
assert.match(cloudflarePackage.scripts?.test ?? "", /register-package-local-loader/, "repository-level Cloudflare tests must use the package-local dependency loader")
assert.equal(homeboy.deployment_provider?.policy?.wrangler?.binary, "./packages/runtime-cloudflare/node_modules/.bin/wrangler")
assert.deepEqual(homeboy.deployment_provider?.policy?.predeploy_commands, ["npm ci --prefix packages/runtime-cloudflare --workspaces=false"])
assert.match(cloudflareWorkflow, /npm ci --prefix packages\/runtime-cloudflare --workspaces=false/, "Cloudflare CI must install the independent package lock")
assert.match(cloudflareWorkflow, /npm --prefix packages\/runtime-cloudflare run check/, "Cloudflare CI must run the package-owned check")
assert.match(cloudflareWorkflow, /npm --prefix packages\/runtime-cloudflare run test:packed-wrangler/, "Cloudflare CI must bundle a clean installed package artifact")
for (const script of ["cloudflare:build", "cloudflare:check", "cloudflare:package-dry-run", "cloudflare:dry-run", "cloudflare:local-gate", "test:cloudflare-runtime"]) {
  assert.match(rootPackage.scripts?.[script] ?? "", /^npm --prefix packages\/runtime-cloudflare run /, `${script} must remain a thin package alias`)
}

const rootPack = await packList(root)
assert.ok(rootPack.has("npm-shrinkwrap.json"), "main package must retain its reproducible dependency manifest")
assert.equal([...rootPack].some((path) => path.includes("runtime-cloudflare") || path.includes("wrangler")), false, "main package must exclude Cloudflare code and assets")

const cloudflarePack = await packList(cloudflareRoot, true)
for (const path of [
  "README.md",
  "package.json",
  "tsconfig.json",
  "wrangler.jsonc",
  "wrangler.d1.jsonc",
  "wrangler.control.jsonc",
  "wrangler.public-reader.jsonc",
  "components/website-importer.json",
  "patches/@php-wasm+stream-compression+3.1.45.patch",
  "src/worker-do.ts",
  "src/worker-d1.ts",
  "src/worker-control.ts",
  "src/public-reader-worker.ts",
  "npm-shrinkwrap.json",
  "scripts/local-gate.mjs",
  "scripts/generate-wordpress-runtime-corpus.ts",
  "vendor/wp-codebox-core/package.json",
  "node_modules/@automattic/wp-codebox-core/runtime-archive-component.js",
  "assets/wordpress-runtime-artifact.json",
  "assets/wordpress-static-artifact.json",
]) {
  assert.ok(cloudflarePack.has(path), `runtime-cloudflare package is missing ${path}`)
}
assert.equal([...cloudflarePack].some((path) => path.startsWith("../") || path.startsWith("packages/runtime-playground") || path.startsWith("packages/cli")), false)

await assertCoreContractDrift()

console.log("runtime package boundaries passed")

async function packList(cwd, explicitPackage = false) {
  const args = ["pack", ...(explicitPackage ? ["."] : []), "--dry-run", "--ignore-scripts", "--json", "--workspaces=false"]
  const { stdout } = await execFileAsync("npm", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 20,
  })
  const [result] = JSON.parse(stdout)
  return new Set(result.files.map(({ path }) => path))
}

async function assertCoreContractDrift() {
  for (const [path, expected] of Object.entries(coreCompatibility.upstreamSources)) assert.equal(await sha256(resolve(root, "packages/runtime-core", path)), expected, `upstream core contract drifted: ${path}`)
  for (const [path, expected] of Object.entries(coreCompatibility.compatibleFiles)) assert.equal(await sha256(resolve(cloudflareRoot, "vendor/wp-codebox-core", path)), expected, `vendored core compatibility file drifted: ${path}`)
  const coreArchive = await import(pathToFileURL(resolve(root, "packages/runtime-core/dist/runtime-archive-component.js")))
  const compatibleArchive = await import(pathToFileURL(resolve(cloudflareRoot, "vendor/wp-codebox-core/runtime-archive-component.js")))
  const coreProfile = await import(pathToFileURL(resolve(root, "packages/runtime-core/dist/runtime-package-profile.js")))
  const compatibleProfile = await import(pathToFileURL(resolve(cloudflareRoot, "vendor/wp-codebox-core/runtime-package-profile.js")))
  const coreResult = await import(pathToFileURL(resolve(root, "packages/runtime-core/dist/runtime-command-result.js")))
  const coreContracts = await import(pathToFileURL(resolve(root, "packages/runtime-core/dist/runtime-contracts.js")))
  const compatibleResult = await import(pathToFileURL(resolve(cloudflareRoot, "vendor/wp-codebox-core/runtime-command-result.js")))
  const component = { schema: coreArchive.RUNTIME_ARCHIVE_COMPONENT_SCHEMA, id: "website-importer", package: { profile: "cloudflare", root: "static-site-importer" }, wordpress: { install_path: "plugins/static-site-importer", bootstrap_file: "plugin.php", load: { mode: "mu-plugin-loader", loader_path: "mu-plugins/loader.php" } }, abilities: { import: "sites/import" }, limits: { files: 100, bytes: 1_000_000 } }
  assert.deepEqual(compatibleArchive.runtimeArchiveComponent(component), coreArchive.runtimeArchiveComponent(component))
  assert.deepEqual(compatibleArchive.runtimeArchiveComponentOwnedWpContentPaths(component), coreArchive.runtimeArchiveComponentOwnedWpContentPaths(component))
  const source = { schema: coreArchive.RUNTIME_ARCHIVE_COMPONENT_SOURCE_SCHEMA, source: { url: "https://example.com/component.zip", version: "1.0.0", identity: "revision", sha256: "a".repeat(64) }, component }
  assert.deepEqual(compatibleArchive.runtimeArchiveComponentSource(source), coreArchive.runtimeArchiveComponentSource(source))
  const manifestSource = JSON.stringify({ schema: "example/runtime-package-manifest/v1", package: "example", package_root: "example", profiles: { cloudflare: { abilities: ["sites/import"], selectors: [{ type: "file", path: "plugin.php" }], required_files: ["plugin.php"] } } })
  const coreManifest = coreProfile.parseRuntimePackageManifest(manifestSource)
  const compatibleManifest = compatibleProfile.parseRuntimePackageManifest(manifestSource)
  assert.deepEqual(compatibleManifest, coreManifest)
  assert.deepEqual(compatibleProfile.selectRuntimePackageProfileFiles(compatibleManifest, "cloudflare", ["example/runtime-package-manifest.json", "example/plugin.php"], "example/runtime-package-manifest.json"), coreProfile.selectRuntimePackageProfileFiles(coreManifest, "cloudflare", ["example/runtime-package-manifest.json", "example/plugin.php"], "example/runtime-package-manifest.json"))
  const resultInput = { status: "ok", stdout: "{\"passed\":true}\n", stderr: "", diagnostics: [{ code: "ready" }] }
  assert.deepEqual(compatibleResult.runtimeCommandResultEnvelopeFromOutput(resultInput), coreResult.runtimeCommandResultEnvelopeFromOutput(resultInput))
  assert.equal(compatibleResult.RUNTIME_COMMAND_RESULT_SCHEMA, coreContracts.RUNTIME_COMMAND_RESULT_SCHEMA)
}

async function sha256(path) { return createHash("sha256").update(await readFile(path)).digest("hex") }
