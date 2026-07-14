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
  assert.deepEqual(Object.keys(materialized.descriptors[0]).sort(), ["path", "repository", "revision", "role"])
  await mkdir(join(repository, "artifacts"), { recursive: true })
  await assert.rejects(materializeRuntimeSources(sources, { policy, remotes: { "example/runtime": repository }, tempRoot: join(repository, "artifacts"), forbiddenRoots: [repository] }), /outside target workspaces and artifacts/)
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

await withTempDir("wp-codebox-runtime-source-upload-", async (directory) => {
  const workspace = join(directory, "workspace")
  const artifacts = join(workspace, ".codebox", "agent-task-artifacts")
  const upload = join(workspace, ".codebox", "agent-task-upload")
  const privateRoot = join(directory, "private-runtime-source")
  await mkdir(artifacts, { recursive: true })
  await mkdir(privateRoot, { recursive: true })
  await writeFile(join(privateRoot, "source.php"), "<?php // private runtime source\n")
  await writeFile(join(artifacts, "safe.json"), JSON.stringify({ provenance: { role: "component", repository: "example/runtime", revision: "a".repeat(40), path: "plugin" } }))
  const script = new URL("../.github/scripts/run-agent-task/prepare-agent-task-upload.mjs", import.meta.url)
  await execFileAsync(process.execPath, [script.pathname], { env: { ...process.env, AGENT_TASK_WORKSPACE: workspace, AGENT_TASK_UPLOAD_PATH: upload, WP_CODEBOX_RUNTIME_SOURCE_ROOT: privateRoot } })
  const staged = await readFile(join(upload, ".codebox", "agent-task-artifacts", "safe.json"), "utf8")
  assert.doesNotMatch(staged, /private-runtime-source|private runtime source/)
  await writeFile(join(artifacts, "leak.json"), privateRoot)
  await assert.rejects(execFileAsync(process.execPath, [script.pathname], { env: { ...process.env, AGENT_TASK_WORKSPACE: workspace, AGENT_TASK_UPLOAD_PATH: upload, WP_CODEBOX_RUNTIME_SOURCE_ROOT: privateRoot } }), /Runtime source paths must never be persisted/)
})

const executor = await readFile(new URL("../.github/scripts/run-agent-task/execute-native-agent-task.mjs", import.meta.url), "utf8")
assert.match(executor, /for \(const signal of \["SIGINT", "SIGTERM", "SIGHUP"\]\)/)
assert.match(executor, /cleanupPrivateRuntimeSources\(\)\.finally\(\(\) => process\.exit\(128\)\)/)

console.log("runtime sources materialization ok")
