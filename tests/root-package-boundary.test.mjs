import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const rootPackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
const rootLock = JSON.parse(await readFile(resolve(root, "npm-shrinkwrap.json"), "utf8"))

assert.deepEqual(rootPackage.workspaces, ["packages/cli", "packages/runtime-core", "packages/runtime-native", "packages/runtime-playground", "packages/wordpress-plugin"])
assert.equal(rootPackage.workspaces.includes("packages/runtime-cloudflare"), false, "runtime-cloudflare must not join the default install lane")
assert.equal(rootLock.packages?.["packages/runtime-cloudflare"], undefined, "the root shrinkwrap must not retain Cloudflare package metadata")
for (const dependency of ["@cloudflare/workers-types", "wrangler"]) {
  assert.equal(rootPackage.dependencies?.[dependency], undefined, `${dependency} must not be a root production dependency`)
  assert.equal(rootPackage.devDependencies?.[dependency], undefined, `${dependency} must not be a root development dependency`)
}

const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", "--workspaces=false"], {
  cwd: root,
  maxBuffer: 1024 * 1024 * 20,
})
const jsonStart = stdout.indexOf("[")
assert.notEqual(jsonStart, -1, "npm pack must emit a JSON file manifest")
const [packed] = JSON.parse(stdout.slice(jsonStart))
const files = new Set(packed.files.map(({ path }) => path))
assert.ok(files.has("npm-shrinkwrap.json"), "root CLI artifact must retain its reproducible dependency manifest")
assert.equal([...files].some((path) => path.includes("runtime-cloudflare") || path.includes("wrangler")), false, "root CLI artifact must exclude Cloudflare code and assets")

console.log("root package boundary passed")
