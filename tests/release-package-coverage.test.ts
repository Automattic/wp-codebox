import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, "..")
const pluginRoot = "packages/wordpress-plugin"
const pluginArtifact = "packages/wordpress-plugin/dist/wp-codebox.zip"

const homeboy = JSON.parse(await readFile(resolve(repositoryRoot, "homeboy.json"), "utf8"))
assert.deepEqual(homeboy.release?.package_coverage, [{
  artifact: pluginArtifact,
  artifact_match: "exact",
  source_roots: [pluginRoot],
  archive_root: "wp-codebox",
}])

const { stdout } = await execFileAsync("npm", ["run", "release:package"], {
  cwd: repositoryRoot,
  maxBuffer: 1024 * 1024 * 20,
})
const artifacts = JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]")
assert.equal(artifacts.length, 2, "release package emitted unexpected artifacts")
assert.deepEqual(artifacts.filter((artifact: { type: string }) => artifact.type === "wordpress-plugin-zip"), [
  { path: pluginArtifact, type: "wordpress-plugin-zip" },
])
const cliArtifacts = artifacts.filter((artifact: { type: string }) => artifact.type === "node-cli-tarball")
assert.equal(cliArtifacts.length, 1, "release package must emit exactly one CLI tarball")
const cliArtifact = cliArtifacts[0] as { path: string, platform: string }
assert.match(cliArtifact.path, /^dist\/wp-codebox-cli-[^/]+\.tar\.gz$/)
assert.match(cliArtifact.platform, /^[a-z0-9]+-[a-z0-9]+$/)
assert.equal(cliArtifact.path, `dist/wp-codebox-cli-${cliArtifact.platform}.tar.gz`)

const { stdout: tracked } = await execFileAsync("git", ["ls-files", "-z", "--", `${pluginRoot}/**`], { cwd: repositoryRoot })
const mappedFiles = tracked
  .split("\0")
  .filter(Boolean)
  .filter((path) => /\.(php|inc|phtml|js|mjs|cjs|css|json)$/.test(path))
  .filter((path) => !path.endsWith("/package.json"))
  .map((path) => `wp-codebox/${path.slice(pluginRoot.length + 1)}`)
assert.ok(mappedFiles.length > 0, "plugin source root has no mapped tracked runtime files")

const { stdout: zipEntries } = await execFileAsync("unzip", ["-Z1", pluginArtifact], {
  cwd: repositoryRoot,
  maxBuffer: 1024 * 1024 * 20,
})
const archiveEntries = new Set(zipEntries.trim().split("\n"))
for (const path of mappedFiles) {
  assert.ok(archiveEntries.has(path), `${pluginArtifact} is missing mapped tracked file ${path}`)
}

assert.equal(archiveEntries.has("wp-codebox/package.json"), false, "package metadata is intentionally excluded from the plugin archive")

const { stdout: tarEntries } = await execFileAsync("tar", ["-tzf", cliArtifact.path], {
  cwd: repositoryRoot,
  maxBuffer: 1024 * 1024 * 20,
})
assert.ok(tarEntries.split("\n").some((path) => path === "wp-codebox-cli/"), "CLI tarball root changed")

console.log("release package coverage passed")
