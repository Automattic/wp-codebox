import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const cloudflareRoot = resolve(root, "packages/runtime-cloudflare")
const rootPackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
const rootLock = JSON.parse(await readFile(resolve(root, "npm-shrinkwrap.json"), "utf8"))
const cloudflarePackage = JSON.parse(await readFile(resolve(cloudflareRoot, "package.json"), "utf8"))
const cloudflareLock = JSON.parse(await readFile(resolve(cloudflareRoot, "package-lock.json"), "utf8"))
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
assert.equal(cloudflarePackage.dependencies?.["@automattic/wp-codebox-core"], undefined, "package-owned runtime assets must not retain a sibling core dependency")
assert.equal(cloudflarePackage.peerDependencies?.["@automattic/wp-codebox-core"], undefined, "package-owned runtime assets must not retain an optional core peer")
assert.equal(cloudflareLock.packages?.[""]?.dependencies?.["@automattic/wp-codebox-core"], undefined)

for (const script of ["build", "check", "test", "test:packed-wrangler", "package:dry-run", "local-gate", "local-gate:d1", "local-gate:provisioning"]) {
  assert.ok(cloudflarePackage.scripts?.[script], `runtime-cloudflare must own ${script}`)
}
assert.equal(cloudflarePackage.scripts?.postinstall, "node scripts/apply-development-patch.mjs", "the package install must apply its required stream-compression patch")
assert.ok(cloudflarePackage.dependencies?.["patch-package"], "packed installs must receive the package-owned patch tool used by postinstall")
assert.deepEqual(cloudflarePackage.bundleDependencies, ["@php-wasm/stream-compression", "@php-wasm/universal", "@php-wasm/web-8-5", "@wp-playground/wordpress", "patch-package"], "packed installs must carry every required runtime dependency and patch tool")
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
  "src/runtime-archive-component.ts",
  "assets/wordpress-runtime-artifact.json",
  "assets/wordpress-static-artifact.json",
]) {
  assert.ok(cloudflarePack.has(path), `runtime-cloudflare package is missing ${path}`)
}
assert.equal([...cloudflarePack].some((path) => path.startsWith("../") || path.startsWith("packages/runtime-playground") || path.startsWith("packages/cli")), false)

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
