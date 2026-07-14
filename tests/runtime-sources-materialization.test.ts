import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { promisify } from "node:util"
import { inspectZipArchive, materializeRuntimeSources, normalizeRuntimeSource, normalizeRuntimeSources, parseExternalPackageSourcePolicy, sha256BytesV1 } from "../.github/scripts/run-agent-task/materialize-external-native-package.mjs"
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
  assert.equal(recipe.inputs?.extra_plugins?.find((plugin) => plugin.slug === "runtime")?.pluginFile, "runtime/runtime.php")
  assert.equal(recipe.inputs?.extra_plugins?.find((plugin) => plugin.slug === "example-provider")?.pluginFile, "example-provider/provider.php")
  assert.equal(recipe.runtime?.overlays?.[0].strategy, "scoped-bundle")
  await assert.rejects(materializeRuntimeSources([{ ...sources[0], revision: "main" }], { policy, remotes: { "example/runtime": repository } }), /immutable 40-character/)
  assert.throws(() => normalizeRuntimeSource({ ...sources[0], version: 2 }, policy), /version must be 1/)
  await assert.rejects(materializeRuntimeSources([{ ...sources[0], path: "../components/runtime" }], { policy, remotes: { "example/runtime": repository } }), /without traversal/)
  await assert.rejects(materializeRuntimeSources([{ ...sources[0], repository: "other/runtime" }], { policy, remotes: { "example/runtime": repository } }), /not authorized/)
  assert.throws(() => normalizeRuntimeSources([sources[0], { ...sources[1], metadata: { slug: "runtime" } }], policy), /duplicate plugin slug/)
  assert.throws(() => normalizeRuntimeSources([{ ...sources[0], metadata: { slug: "runtime", loadAs: "mu-plugin", pluginFile: "../runtime.php" } }], policy), /without traversal/)
  await assert.rejects(materializeRuntimeSources([{ ...sources[0], digest: `sha256-git-archive-v1:${"0".repeat(64)}` }], { policy, remotes: { "example/runtime": repository } }), /digest does not match/)
  assert.throws(() => normalizeRuntimeSource({ ...sources[0], metadata: { slug: "runtime", loadAs: "unknown" } }, policy), /loadAs/)
  await symlink("runtime.php", join(repository, "components/runtime/link.php"))
  await execFileAsync("git", ["add", "."], { cwd: repository }); await execFileAsync("git", ["commit", "--quiet", "-m", "symlink"], { cwd: repository })
  const symlinkRevision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim()
  await assert.rejects(materializeRuntimeSources([{ ...sources[0], revision: symlinkRevision }], { policy, remotes: { "example/runtime": repository } }), /symlinks and special files/)
  await rm(materialized.root, { recursive: true, force: true })
})

await withTempDir("wp-codebox-runtime-zip-source-", async (directory) => {
  const archiveRoot = join(directory, "example-provider")
  await mkdir(archiveRoot, { recursive: true })
  await writeFile(join(archiveRoot, "plugin.php"), "<?php /* Plugin Name: Example Provider */\n")
  await execFileAsync("zip", ["-q", "-r", "provider.zip", "example-provider"], { cwd: directory })
  const archive = await readFile(join(directory, "provider.zip"))
  const url = "https://downloads.example.test/provider.zip"
  const digest = (await execFileAsync("shasum", ["-a", "256", join(directory, "provider.zip")])).stdout.split(/\s+/)[0]
  const policy = parseExternalPackageSourcePolicy(JSON.stringify({ version: 1, repositories: {}, runtime_artifacts: [{ url, sha256: digest }] }))
  const source = { version: 1, role: "provider_plugin", source: { type: "https_zip", url, sha256: digest, archive_root: "example-provider" }, metadata: { slug: "example-provider", pluginFile: "plugin.php", activate: true } }
  const materialized = await materializeRuntimeSources([source], { policy, fetch: async () => new Response(archive) })
  assert.equal(materialized.lowered[0].provider_plugins[0].slug, "example-provider")
  assert.deepEqual(materialized.descriptors[0], { role: "provider_plugin", source: { type: "https_zip", url, sha256: digest, archive_root: "example-provider" } })
  await assert.rejects(materializeRuntimeSources([{ ...source, source: { ...source.source, sha256: "0".repeat(64) } }], { policy, fetch: async () => new Response(archive) }), /trusted policy/)
  assert.throws(() => parseExternalPackageSourcePolicy(JSON.stringify({ version: 1, repositories: {}, runtime_artifacts: [{ url }] })), /sha256/)
  assert.throws(() => normalizeRuntimeSource({ ...source, source: { ...source.source, url: "http://downloads.example.test/provider.zip" } }, policy), /HTTPS/)
  await assert.rejects(materializeRuntimeSources([{ ...source, source: { ...source.source, archive_root: "other" } }], { policy, fetch: async () => new Response(archive) }), /archive root/)
  assert.throws(() => normalizeRuntimeSource({ ...source, role: "bundled_library" }, policy), /component and provider_plugin/)
  const encrypted = Buffer.from(archive)
  const centralDirectory = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  encrypted.writeUInt16LE(encrypted.readUInt16LE(centralDirectory + 8) | 1, centralDirectory + 8)
  assert.throws(() => inspectZipArchive(encrypted), /encrypted/)
  const bomb = Buffer.from(archive)
  bomb.writeUInt32LE(33 * 1024 * 1024, centralDirectory + 24)
  assert.throws(() => inspectZipArchive(bomb), /oversized/)
  await symlink("plugin.php", join(archiveRoot, "link.php"))
  await execFileAsync("zip", ["-q", "-y", "symlink.zip", "example-provider/link.php"], { cwd: directory })
  const symlinkArchive = await readFile(join(directory, "symlink.zip"))
  assert.throws(() => inspectZipArchive(symlinkArchive), /symlink|special-file/)
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
  await writeFile(join(workspace, ".codebox", "native-agent-task-input.json"), JSON.stringify({
    source_package_root: privateRoot,
    component_contracts: [{
      path: privateRoot,
      sourceRoot: privateRoot,
      metadata: { originalSource: privateRoot, nested: { preparedPath: privateRoot, requestedPath: privateRoot }, runtime_source: { role: "component", repository: "example/runtime", revision: "a".repeat(40), path: "plugin" } },
    }],
  }))
  await writeFile(join(workspace, ".codebox", "agent-task-workflow-result.json"), JSON.stringify({ callback_data: { task_path: privateRoot, nested: { result_path: privateRoot } } }))
  const script = new URL("../.github/scripts/run-agent-task/prepare-agent-task-upload.mjs", import.meta.url)
  await execFileAsync(process.execPath, [script.pathname], { env: { ...process.env, AGENT_TASK_WORKSPACE: workspace, AGENT_TASK_UPLOAD_PATH: upload, WP_CODEBOX_RUNTIME_SOURCE_ROOT: privateRoot } })
  const staged = await readFile(join(upload, ".codebox", "agent-task-artifacts", "safe.json"), "utf8")
  assert.doesNotMatch(staged, /private-runtime-source|private runtime source/)
  const stagedInput = await readFile(join(upload, ".codebox", "native-agent-task-input.json"), "utf8")
  assert.doesNotMatch(stagedInput, /private-runtime-source/)
  assert.match(stagedInput, /"runtime_source"/)
  const stagedResult = await readFile(join(upload, ".codebox", "agent-task-workflow-result.json"), "utf8")
  assert.doesNotMatch(stagedResult, /private-runtime-source/)
  await writeFile(join(artifacts, "leak.json"), privateRoot)
  await assert.rejects(execFileAsync(process.execPath, [script.pathname], { env: { ...process.env, AGENT_TASK_WORKSPACE: workspace, AGENT_TASK_UPLOAD_PATH: upload, WP_CODEBOX_RUNTIME_SOURCE_ROOT: privateRoot } }), /Runtime source paths must never be persisted/)
})

await withTempDir("wp-codebox-runtime-sources-workflow-", async (directory) => {
  const repository = join(directory, "repository")
  const workspace = join(directory, "workspace")
  const codebox = join(workspace, ".codebox")
  const upload = join(codebox, "agent-task-upload")
  const tools = join(directory, "tools")
  const temp = join(directory, "temp")
  await mkdir(join(repository, "plugin"), { recursive: true })
  await mkdir(join(workspace, ".codebox", "agent-task-artifacts"), { recursive: true })
  await mkdir(tools, { recursive: true })
  await mkdir(temp, { recursive: true })
  const packageBytes = Buffer.from('{"schema_version":1,"bundle_slug":"fixture-agent","agent":{"agent_slug":"fixture-agent"}}\n')
  await writeFile(join(repository, "fixture.agent.json"), packageBytes)
  await writeFile(join(repository, "plugin", "plugin.php"), "<?php /* Plugin Name: Fixture */\n")
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository })
  await execFileAsync("git", ["config", "user.email", "test@example.test"], { cwd: repository })
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repository })
  await execFileAsync("git", ["add", "."], { cwd: repository })
  await execFileAsync("git", ["commit", "--quiet", "-m", "runtime workflow source"], { cwd: repository })
  const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim()
  const gitPath = (await execFileAsync("which", ["git"])).stdout.trim()
  await writeFile(join(tools, "git"), `#!${process.execPath}\nimport { spawnSync } from "node:child_process"\nconst args = process.argv.slice(2).map((value) => value.startsWith("https://github.com/") ? ${JSON.stringify(repository)} : value)\nconst result = spawnSync(${JSON.stringify(gitPath)}, args, { stdio: "inherit" })\nprocess.exit(result.status ?? 1)\n`)
  await chmod(join(tools, "git"), 0o755)
  await writeFile(join(directory, "fake-cli.mjs"), `import { writeFile } from "node:fs/promises"\nconst result = process.argv[process.argv.indexOf("--result-file") + 1]\nawait writeFile(result, JSON.stringify({ schema: "wp-codebox/agent-task-run/v1", success: true, status: "succeeded", agent_task_run_result: { schema: "wp-codebox/agent-task-run-result/v1", success: true, status: "succeeded" }, outputs: {} }))\n`)
  const request = {
    workload: { id: "runtime-sources-workflow", label: "Runtime sources workflow" },
    access: { caller_repo: "example/target", allowed_repos: ["example/target"], access_token_repos: ["example/target"] },
    target_repo: "example/target",
    run_agent: true,
    dry_run: false,
    prompt: "Verify private runtime source upload isolation",
    external_package_source: { repository: "example/source", revision, path: "fixture.agent.json", digest: sha256BytesV1(packageBytes) },
    runtime_sources: [{ version: 1, role: "provider_plugin", repository: "example/source", revision, path: "plugin", metadata: { slug: "fixture", pluginFile: "plugin.php", activate: true } }],
    verification_commands: [],
    drift_checks: [],
    artifacts: { declarations: [], expected: [] },
    callback_data: {},
    outputs: { projections: {} },
    success: { requires_pr: false },
  }
  await writeFile(join(codebox, "agent-task-request.json"), JSON.stringify(request))
  await writeFile(join(codebox, "agent-task-artifacts", "safe.json"), JSON.stringify({ provenance: { repository: "example/source", revision } }))
  const environment = { ...process.env, PATH: `${tools}:${process.env.PATH}`, TMPDIR: temp, AGENT_TASK_WORKSPACE: workspace, AGENT_TASK_REQUEST_PATH: join(codebox, "agent-task-request.json"), WP_CODEBOX_CLI_PATH: join(directory, "fake-cli.mjs"), GITHUB_TOKEN: "test-token", EXTERNAL_PACKAGE_SOURCE_POLICY: JSON.stringify({ version: 1, repositories: { "example/source": ["fixture.agent.json"] }, runtime_sources: { "example/source": ["plugin"] } }) }
  const executorPath = new URL("../.github/scripts/run-agent-task/execute-native-agent-task.mjs", import.meta.url)
  await execFileAsync(process.execPath, [executorPath.pathname], { env: environment })
  await assert.rejects(access(join(codebox, "native-agent-task-input.json")), /ENOENT/, "runtime source native input must remain private")
  const uploaderPath = new URL("../.github/scripts/run-agent-task/prepare-agent-task-upload.mjs", import.meta.url)
  await execFileAsync(process.execPath, [uploaderPath.pathname], { env: { ...environment, AGENT_TASK_UPLOAD_PATH: upload, WP_CODEBOX_RUNTIME_SOURCE_ROOT: join(temp, "wp-codebox-runtime-sources-") } })
  const privateRuntimePrefix = join(temp, "wp-codebox-runtime-sources-")
  for (const path of [".codebox/agent-task-request.json", ".codebox/agent-task-workflow-result.json", ".codebox/agent-task-artifacts/safe.json"]) {
    assert.ok(!(await readFile(join(upload, path), "utf8")).includes(privateRuntimePrefix))
  }
})

const executor = await readFile(new URL("../.github/scripts/run-agent-task/execute-native-agent-task.mjs", import.meta.url), "utf8")
assert.match(executor, /for \(const signal of \["SIGINT", "SIGTERM", "SIGHUP"\]\)/)
assert.match(executor, /cleanupPrivateRuntimeSources\(\)\.finally\(\(\) => process\.exit\(128\)\)/)
assert.match(executor, /const executionInputPath = privateRuntimeSourceRoot \? join\(privateRuntimeSourceRoot, "native-agent-task-input\.json"\) : runtimeInputPath/)
assert.match(executor, /assertNoPrivateRuntimePaths\(nativeRuntimeResult\)/)

console.log("runtime sources materialization ok")
