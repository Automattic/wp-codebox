import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { promisify } from "node:util"
import { materializeRuntimeSources, normalizeRuntimeSource, parseExternalPackageSourcePolicy } from "../.github/scripts/run-agent-task/materialize-external-native-package.mjs"
import { withTempDir } from "../scripts/test-kit.js"
import { buildAgentTaskRecipe } from "../packages/runtime-core/src/agent-task-recipe.js"
import { normalizeTaskInput } from "../packages/runtime-core/src/task-input.js"

const execFileAsync = promisify(execFile)
const hostedRegression = JSON.parse(await readFile(new URL("../fixtures/agent-task-runtime-sources-run-29299109269.json", import.meta.url), "utf8"))
assert.equal(hostedRegression.run_id, "29299109269")
assert.deepEqual(hostedRegression.runtime_sources.map((source: { role: string }) => source.role), ["component", "provider_plugin", "bundled_library"])

await withTempDir("wp-codebox-runtime-sources-", async (repository) => {
  for (const path of ["components/runtime", "providers/example", "libraries/client"]) await mkdir(join(repository, path), { recursive: true })
  await writeFile(join(repository, "components/runtime/runtime.php"), "<?php /* Plugin Name: Runtime */\n")
  await writeFile(join(repository, "providers/example/provider.php"), "<?php /* Plugin Name: Provider */\n")
  await writeFile(join(repository, "libraries/client/client.php"), "<?php\n")
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository })
  await execFileAsync("git", ["config", "user.email", "test@example.test"], { cwd: repository })
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repository })
  await execFileAsync("git", ["add", "."], { cwd: repository })
  await execFileAsync("git", ["commit", "--quiet", "-m", "runtime sources"], { cwd: repository })
  const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim()
  const policy = parseExternalPackageSourcePolicy(JSON.stringify({ version: 1, repositories: {}, runtime_sources: { "example/runtime": ["components/runtime", "providers/example", "libraries/client"] } }))
  const sources = [
    { version: 1, role: "component", repository: "example/runtime", revision, path: "components/runtime", metadata: { slug: "runtime", loadAs: "mu-plugin", activate: false } },
    { version: 1, role: "provider_plugin", repository: "example/runtime", revision, path: "providers/example", metadata: { slug: "example-provider", pluginFile: "provider.php" } },
    { version: 1, role: "bundled_library", repository: "example/runtime", revision, path: "libraries/client", metadata: { library: "client", strategy: "scoped-bundle", target: "/wordpress/client" } },
  ]
  const materialized = await materializeRuntimeSources(sources, { policy, remotes: { "example/runtime": repository } })
  assert.equal(materialized.lowered[0].component_contracts[0].loadAs, "mu-plugin")
  assert.equal(materialized.lowered[1].provider_plugins[0].slug, "example-provider")
  assert.equal(materialized.lowered[2].runtime_overlays[0].strategy, "scoped-bundle")
  assert.ok(relative(repository, materialized.root).startsWith(".."), "sources are outside the target workspace")
  const loweredInput = materialized.lowered.reduce((input, lowered) => {
    for (const [key, entries] of Object.entries(lowered)) (input as Record<string, unknown[]>)[key] = [...((input as Record<string, unknown[]>)[key] ?? []), ...(entries as unknown[])]
    return input
  }, {} as Record<string, unknown[]>)
  const recipe = buildAgentTaskRecipe({ goal: "verify lowering", ...loweredInput }, normalizeTaskInput({ goal: "verify lowering" }), "latest")
  assert.ok(recipe.inputs?.extra_plugins?.some((plugin) => plugin.slug === "runtime" && plugin.loadAs === "mu-plugin"))
  assert.ok(recipe.inputs?.extra_plugins?.some((plugin) => plugin.slug === "example-provider" && plugin.activate === true))
  assert.equal(recipe.runtime?.overlays?.[0].strategy, "scoped-bundle")
  await assert.rejects(materializeRuntimeSources([{ ...sources[0], revision: "main" }], { policy, remotes: { "example/runtime": repository } }), /immutable 40-character/)
  assert.throws(() => normalizeRuntimeSource({ ...sources[0], version: 2 }, policy), /version must be 1/)
  await assert.rejects(materializeRuntimeSources([{ ...sources[0], path: "../components/runtime" }], { policy, remotes: { "example/runtime": repository } }), /without traversal/)
  await assert.rejects(materializeRuntimeSources([{ ...sources[0], repository: "other/runtime" }], { policy, remotes: { "example/runtime": repository } }), /not authorized/)
  await assert.rejects(materializeRuntimeSources([{ ...sources[0], digest: `sha256-git-archive-v1:${"0".repeat(64)}` }], { policy, remotes: { "example/runtime": repository } }), /digest does not match/)
  assert.throws(() => normalizeRuntimeSource({ ...sources[0], metadata: { slug: "runtime", loadAs: "unknown" } }, policy), /loadAs/)
  await symlink("runtime.php", join(repository, "components/runtime/link.php"))
  await execFileAsync("git", ["add", "."], { cwd: repository }); await execFileAsync("git", ["commit", "--quiet", "-m", "symlink"], { cwd: repository })
  const symlinkRevision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim()
  await assert.rejects(materializeRuntimeSources([{ ...sources[0], revision: symlinkRevision }], { policy, remotes: { "example/runtime": repository } }), /symlinks and special files/)
  await rm(materialized.root, { recursive: true, force: true })
})

console.log("runtime sources materialization ok")
