import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")

const rootPackage = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
  bin?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  exports?: Record<string, { types?: string; import?: string }>
}
const corePackage = JSON.parse(await readFile(resolve(repoRoot, "packages", "runtime-core", "package.json"), "utf8")) as {
  exports?: Record<string, { types?: string; import?: string }>
}

assert.ok(
  rootPackage.dependencies?.["@wp-playground/cli"],
  "Published workspace package should install the Playground CLI runtime dependency",
)
assert.ok(
  rootPackage.dependencies?.playwright,
  "Published workspace package should install the Playwright runtime dependency",
)

const { stdout: packStdout } = await execFileAsync(
  "npm",
  ["pack", "--workspace", "@automattic/wp-codebox-cli", "--dry-run", "--json"],
  { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 },
)
const [pack] = JSON.parse(packStdout) as Array<{ files: Array<{ path: string }>; entryCount: number }>
const packedFiles = new Set(pack.files.map((file) => file.path))

const { stdout: corePackStdout } = await execFileAsync(
  "npm",
  ["pack", "--workspace", "@automattic/wp-codebox-core", "--dry-run", "--json"],
  { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 },
)
const [corePack] = JSON.parse(corePackStdout) as Array<{ files: Array<{ path: string }> }>
const corePackedFiles = new Set(corePack.files.map((file) => file.path))

const { stdout: rootPackStdout } = await execFileAsync(
  "npm",
  ["pack", "--dry-run", "--json"],
  { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 },
)
const [rootPack] = JSON.parse(rootPackStdout) as Array<{ files: Array<{ path: string }> }>
const rootPackedFiles = new Set(rootPack.files.map((file) => file.path))

assert.ok(packedFiles.has("package.json"), "CLI package should include package.json")
assert.ok(packedFiles.has("README.md"), "CLI package should include README.md")
assert.ok(packedFiles.has("dist/index.js"), "CLI package should include compiled binary entrypoint")
assert.ok(packedFiles.has("dist/index.d.ts"), "CLI package should include generated types")
assert.equal(packedFiles.has("src/index.ts"), false, "CLI package should not ship TypeScript source")
assert.ok(pack.entryCount >= 4, "CLI package should contain expected publish files")
assert.deepEqual(
  corePackage.exports?.["./recipe-builders"],
  { types: "./dist/recipe-builders.d.ts", import: "./dist/recipe-builders.js" },
  "Core package should expose a stable recipe-builder subpath",
)
assert.deepEqual(
  corePackage.exports?.["./contracts"],
  { types: "./dist/contracts.d.ts", import: "./dist/contracts.js" },
  "Core package should expose the intentional contracts subpath",
)
assert.deepEqual(
  corePackage.exports?.["./artifacts"],
  { types: "./dist/artifacts.d.ts", import: "./dist/artifacts.js" },
  "Core package should expose the intentional artifact helper subpath",
)
assert.deepEqual(
  corePackage.exports?.["./internals"],
  { types: "./dist/internals.d.ts", import: "./dist/internals.js" },
  "Core package should expose the explicit monorepo-internal helper subpath",
)
assert.ok(corePackedFiles.has("dist/recipe-builders.js"), "Core package should ship compiled recipe-builder entrypoint")
assert.ok(corePackedFiles.has("dist/recipe-builders.d.ts"), "Core package should ship recipe-builder types")
assert.ok(corePackedFiles.has("dist/contracts.js"), "Core package should ship compiled contracts entrypoint")
assert.ok(corePackedFiles.has("dist/contracts.d.ts"), "Core package should ship contracts types")
assert.ok(corePackedFiles.has("dist/artifacts.js"), "Core package should ship compiled artifacts entrypoint")
assert.ok(corePackedFiles.has("dist/artifacts.d.ts"), "Core package should ship artifacts types")
assert.ok(corePackedFiles.has("dist/internals.js"), "Core package should ship compiled internals entrypoint")
assert.ok(corePackedFiles.has("dist/internals.d.ts"), "Core package should ship internals types")
assert.ok(
  rootPackedFiles.has("scripts/normalize-playground-sqlite-package.mjs"),
  "Root package should ship the Playground SQLite package normalizer for clean installs",
)
assert.deepEqual(
  rootPackage.exports?.["./recipe-builders"],
  { types: "./packages/runtime-core/dist/recipe-builders.d.ts", import: "./packages/runtime-core/dist/recipe-builders.js" },
  "Root release package should expose the stable recipe-builder subpath",
)
assert.deepEqual(
  rootPackage.exports?.["./core/contracts"],
  { types: "./packages/runtime-core/dist/contracts.d.ts", import: "./packages/runtime-core/dist/contracts.js" },
  "Root release package should expose the contracts subpath",
)
assert.deepEqual(
  rootPackage.exports?.["./core/artifacts"],
  { types: "./packages/runtime-core/dist/artifacts.d.ts", import: "./packages/runtime-core/dist/artifacts.js" },
  "Root release package should expose the artifacts subpath",
)
assert.deepEqual(
  rootPackage.exports?.["./core/internals"],
  { types: "./packages/runtime-core/dist/internals.d.ts", import: "./packages/runtime-core/dist/internals.js" },
  "Root release package should expose the explicit internals subpath",
)
assert.equal(
  rootPackage.bin?.["wp-codebox"],
  "packages/cli/dist/index.js",
  "Root release tarball should install the stable wp-codebox binary",
)
assert.ok(rootPackedFiles.has("packages/cli/dist/index.js"), "Root package should ship the compiled CLI binary target")
assert.ok(rootPackedFiles.has("packages/runtime-core/dist/recipe-builders.js"), "Root package should ship compiled recipe builders")
assert.ok(rootPackedFiles.has("packages/runtime-core/dist/recipe-builders.d.ts"), "Root package should ship recipe-builder types")
assert.ok(rootPackedFiles.has("packages/runtime-core/dist/contracts.js"), "Root package should ship compiled contracts entrypoint")
assert.ok(rootPackedFiles.has("packages/runtime-core/dist/contracts.d.ts"), "Root package should ship contracts types")
assert.ok(rootPackedFiles.has("packages/runtime-core/dist/artifacts.js"), "Root package should ship compiled artifacts entrypoint")
assert.ok(rootPackedFiles.has("packages/runtime-core/dist/artifacts.d.ts"), "Root package should ship artifacts types")
assert.ok(rootPackedFiles.has("packages/runtime-core/dist/internals.js"), "Root package should ship compiled internals entrypoint")
assert.ok(rootPackedFiles.has("packages/runtime-core/dist/internals.d.ts"), "Root package should ship internals types")

await execFileAsync("npm", ["run", "package:wordpress-plugin"], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 })
const pluginZip = resolve(repoRoot, "packages", "wordpress-plugin", "dist", "wp-codebox.zip")
await access(pluginZip)

const { stdout: zipStdout } = await execFileAsync("unzip", ["-Z1", pluginZip], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 20 })
const zipEntries = new Set(zipStdout.trim().split("\n").filter(Boolean))

assert.ok(zipEntries.has("wp-codebox/wp-codebox.php"), "Plugin zip should include the main plugin file")
assert.ok(zipEntries.has("wp-codebox/README.md"), "Plugin zip should include README.md")
assert.ok(zipEntries.has("wp-codebox/assets/browser-runtime.js"), "Plugin zip should include the checked-in browser runtime asset")
assert.ok(zipEntries.has("wp-codebox/src/class-wp-codebox-abilities.php"), "Plugin zip should include ability surface")
assert.ok(zipEntries.has("wp-codebox/src/class-wp-codebox-agent-sandbox-runner.php"), "Plugin zip should include sandbox runner")
assert.ok(zipEntries.has("wp-codebox/src/class-wp-codebox-artifacts.php"), "Plugin zip should include artifact helpers")
assert.ok(zipEntries.has("wp-codebox/vendor/wp-codebox-cli/bin/wp-codebox"), "Plugin zip should include packaged CLI wrapper")
assert.ok(
  zipEntries.has("wp-codebox/vendor/wp-codebox-cli/vendor/node/bin/node"),
  "Plugin zip should include packaged Node runtime for the plugin CLI path",
)
assert.ok(zipEntries.has("wp-codebox/vendor/wp-codebox-cli/packages/cli/dist/index.js"), "Plugin zip should include compiled CLI runtime")
assert.ok(
  zipEntries.has("wp-codebox/vendor/wp-codebox-cli/node_modules/@wp-playground/wordpress-builds/src/sqlite-database-integration/sqlite-database-integration-trunk.zip"),
  "Plugin zip should include Playground's normalized trunk SQLite package alias",
)
assert.ok(
  zipEntries.has("wp-codebox/vendor/wp-codebox-cli/scripts/normalize-playground-sqlite-package.mjs"),
  "Plugin zip should include the Playground SQLite package normalizer for packaged installs",
)
assert.equal(zipEntries.has("wp-codebox/package.json"), false, "Plugin zip should not include package metadata")
assert.equal(zipEntries.has("wp-codebox/dist/wp-codebox.zip"), false, "Plugin zip should not include generated artifacts")

const browserRuntimeSource = await readFile(resolve(repoRoot, "packages", "wordpress-plugin", "assets", "browser-runtime.js"), "utf8")
assert.match(browserRuntimeSource, /window\.wpCodeboxBrowser/, "Browser runtime asset should expose the generic WP Codebox browser helper")
assert.match(browserRuntimeSource, /\/wp-content\/uploads\/wp-codebox\/runner/, "Browser runtime asset should use the generic WP Codebox runner path")
assert.equal(/studio/i.test(browserRuntimeSource), false, "Browser runtime asset should not encode host-product defaults")

console.log("Package distribution smoke passed")
