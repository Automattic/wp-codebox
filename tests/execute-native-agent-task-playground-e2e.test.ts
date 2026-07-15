import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { materializeRuntimeSources, parseExternalPackageSourcePolicy, sha256BytesV1 } from "../.github/scripts/run-agent-task/materialize-external-native-package.mjs"
import { createRunnerWorkspaceSeedSnapshot } from "../.github/scripts/run-agent-task/runner-workspace-seed-snapshot.mjs"

const execFileAsync = promisify(execFile)
const root = resolve(".")
const executor = join(root, ".github/scripts/run-agent-task/execute-native-agent-task.mjs")
const uploader = join(root, ".github/scripts/run-agent-task/prepare-agent-task-upload.mjs")
const fixture = JSON.parse(await readFile(new URL("../fixtures/agent-task-runtime-sources-run-29299109269.json", import.meta.url), "utf8"))
const temp = await mkdtemp(join(tmpdir(), "wp-codebox-native-agent-task-e2e-"))
const workspace = join(temp, "workspace")
const packagePath = join(temp, "fixture-agent.agent.json")
const interceptor = join(temp, "openai-interceptor")
const publisher = join(temp, "publisher.mjs")
const gh = join(temp, "gh")

try {
  await mkdir(join(workspace, ".codebox"), { recursive: true })
  await mkdir(join(workspace, "node_modules"), { recursive: true })
  await writeFile(join(workspace, "README.md"), "before\n")
  await writeFile(join(workspace, ".env"), "PRIVATE_WORKSPACE_SENTINEL\n")
  await writeFile(join(workspace, ".env.example"), "PUBLIC_TEMPLATE_VALUE=example\n")
  await writeFile(join(workspace, ".npmrc"), "//registry.example/:_authToken=PRIVATE_NPM_SENTINEL\n")
  await writeFile(join(workspace, ".netrc"), "machine example login private password PRIVATE_NETRC_SENTINEL\n")
  await writeFile(join(workspace, "id_ed25519"), "PRIVATE_KEY_SENTINEL\n")
  await writeFile(join(workspace, ".codebox", "private.txt"), "PRIVATE_CODEBOX_SENTINEL\n")
  await writeFile(join(workspace, "node_modules", "private.txt"), "PRIVATE_NODE_MODULES_SENTINEL\n")
  const packageBytes = Buffer.from(`${JSON.stringify({ schema_version: 1, bundle_slug: "fixture-agent", agent: { agent_slug: "fixture-agent", agent_name: "Fixture Agent", description: "Playground imported-agent fixture.", agent_config: { instructions: "Read and update README.", enabled_tools: ["workspace_read", "workspace_edit"], modes: ["chat"] } } })}\n`)
  await writeFile(packagePath, packageBytes)
  await mkdir(interceptor, { recursive: true })
  await writeFile(join(interceptor, "interceptor.php"), `<?php
/** Plugin Name: Native Agent Task OpenAI Interceptor */
add_filter( 'pre_http_request', static function( $preempt, $args, $url ) {
 if ( ! str_starts_with( $url, 'https://api.openai.com/v1/' ) ) return $preempt;
 $file = WP_CONTENT_DIR . '/native-agent-task-requests.json'; $requests = is_readable( $file ) ? json_decode( file_get_contents( $file ), true ) : array(); $requests[] = array( 'url' => $url, 'body' => $args['body'] ?? '' ); file_put_contents( $file, wp_json_encode( $requests ) );
 if ( str_ends_with( $url, '/models' ) ) $body = array( 'object' => 'list', 'data' => array( array( 'id' => 'gpt-5.5', 'object' => 'model' ) ) );
  else { $turn = count( array_filter( $requests, static fn( $request ) => str_ends_with( $request['url'], '/responses' ) ) ); $output = 1 === $turn ? array( array( 'id' => 'fc-read', 'type' => 'function_call', 'call_id' => 'read', 'name' => 'workspace_read', 'arguments' => wp_json_encode( array( 'path' => 'README.md' ) ) ) ) : ( 2 === $turn ? array( array( 'id' => 'fc-edit', 'type' => 'function_call', 'call_id' => 'edit', 'name' => 'workspace_edit', 'arguments' => wp_json_encode( array( 'path' => 'README.md', 'old_string' => 'before', 'new_string' => 'after' ) ) ) ) : array( array( 'id' => 'msg-fixture', 'type' => 'message', 'role' => 'assistant', 'status' => 'completed', 'content' => array( array( 'type' => 'output_text', 'text' => 'Updated README.', 'annotations' => array() ) ) ) ) ); $body = array( 'id' => 'fixture-' . $turn, 'object' => 'response', 'status' => 'completed', 'output' => $output, 'usage' => array( 'input_tokens' => 1, 'output_tokens' => 1, 'total_tokens' => 2 ) ); }
 return array( 'headers' => array( 'content-type' => 'application/json' ), 'body' => wp_json_encode( $body ), 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array(), 'filename' => null );
}, 1000, 3 );`)
  const provider = fixture.runtime_sources[1]
  const policyRaw = JSON.stringify({ version: 1, repositories: { "fixture/agent": ["fixture-agent.agent.json"] }, runtime_sources: { "automattic/agents-api": ["."], "wordpress/php-ai-client": ["."] }, runtime_artifacts: [{ url: provider.source.url, sha256: provider.source.sha256 }] })
  const policy = parseExternalPackageSourcePolicy(policyRaw)
  const sources = await materializeRuntimeSources(fixture.runtime_sources, { policy, forbiddenRoots: [workspace] })
  const lowered = sources.lowered.reduce((result: Record<string, unknown[]>, entry: Record<string, unknown[]>) => {
    for (const [key, values] of Object.entries(entry)) result[key] = [...(result[key] ?? []), ...values]
    return result
  }, {})
  lowered.provider_plugin_paths = [...(lowered.provider_plugin_paths ?? []), interceptor]
  lowered.provider_plugins = [...(lowered.provider_plugins ?? []), { source: interceptor, slug: "native-agent-task-openai-interceptor", pluginFile: "native-agent-task-openai-interceptor/interceptor.php", activate: true, loadAs: "plugin" }]
  const preflightSnapshot = await createRunnerWorkspaceSeedSnapshot(workspace)
  for (const secret of [".env", ".npmrc", ".netrc", "id_ed25519"]) await assert.rejects(access(join(preflightSnapshot.source, secret)), /ENOENT/, `workspace_read cannot access ${secret} because the seed excludes it`)
  await rm(preflightSnapshot.source, { recursive: true, force: true })
  const request = { schema: "wp-codebox/agent-task-workflow-request/v1", model: { provider: "openai", name: "gpt-5.5" }, external_package_source: { repository: "fixture/agent", revision: "a".repeat(40), path: "fixture-agent.agent.json", digest: sha256BytesV1(packageBytes) }, runtime_sources: [provider], workload: { id: "native-e2e", label: "Native E2E" }, target_repo: "owner/repo", prompt: "Read README.md, then replace before with after.", writable_paths: "README.md", runner_workspace: { enabled: true, repo: "owner/repo", base: "main", branch_prefix: "fixture/" }, verification_commands: [{ command: "test \"$(cat README.md)\" = after", description: "Verify README" }], drift_checks: [], validation_dependencies: "", success: { requires_pr: true }, access: { caller_repo: "owner/repo", allowed_repos: ["owner/repo"], access_token_repos: ["owner/repo"] }, limits: { max_turns: 3, time_budget_ms: 180000 }, artifacts: { expected: [], declarations: [] }, outputs: { projections: { pr_url: "metadata.runner_workspace_publication.pull_request.url" } }, callback_data: {}, run_agent: true, dry_run: false }
  await writeFile(join(workspace, ".codebox", "agent-task-request.json"), JSON.stringify(request))
  await writeFile(publisher, `export async function publishRunnerWorkspace() { return { schema: "wp-codebox/runner-workspace-publication-result/v1", success: true, status: "published", backend: "fixture", pull_request: { url: "https://github.com/owner/repo/pull/1", opened: true, reused: false } } }`)
  await writeFile(gh, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/1", base: { repo: { full_name: "owner/repo" } } }))\n`)
  await chmod(gh, 0o755)
  const execution = await execFileAsync(process.execPath, [executor], { cwd: workspace, timeout: 300_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, NODE_ENV: "test", AGENT_TASK_REQUEST_PATH: join(workspace, ".codebox", "agent-task-request.json"), AGENT_TASK_WORKSPACE: workspace, WP_CODEBOX_WORKFLOW_ROOT: root, WP_CODEBOX_TEST_EXTERNAL_PACKAGE_PATH: packagePath, WP_CODEBOX_TEST_RUNTIME_SOURCE_INPUTS: JSON.stringify(lowered), WP_CODEBOX_TEST_PUBLISHER_MODULE: publisher, GITHUB_TOKEN: "e2e-github-secret", OPENAI_API_KEY: "e2e-openai-secret", EXPLICIT_ACCESS_TOKEN_CONFIGURED: "true", EXTERNAL_PACKAGE_SOURCE_POLICY: policyRaw, PATH: `${temp}:${process.env.PATH ?? ""}` } }).then(() => ({ code: 0 }), (error: any) => ({ code: error.code, stderr: error.stderr }))
  const result = JSON.parse(await readFile(join(workspace, ".codebox", "agent-task-workflow-result.json"), "utf8"))
  const input = JSON.parse(await readFile(join(workspace, ".codebox", "native-agent-task-input.json"), "utf8"))
  const seededWorkspace = input.task_input.workspaces[0]
  assert.deepEqual(input.task_input.workspaces.map((entry: { target: string, mode: string }) => ({ target: entry.target, mode: entry.mode })), [{ target: "/workspace", mode: "readwrite" }])
  assert.notEqual(seededWorkspace.seed.source, workspace)
  const seedProvenance = input.task_input.runtime_task.input.metadata.runner_workspace_seed
  assert.match(seedProvenance.digest.sha256, /^[a-f0-9]{64}$/)
  assert.equal(seedProvenance.files, 2, "only README and the explicit .env.example template are copied")
  assert.equal(seedProvenance.excluded.files, 6)
  assert.deepEqual(seedProvenance.excluded.categories, [{ category: "credentials", count: 2 }, { category: "environment", count: 1 }, { category: "generated-tree", count: 2 }, { category: "private-key", count: 1 }])
  assert.equal(execution.code, 0, `${execution.stderr ?? ""}\n${JSON.stringify(result)}`)
  assert.equal(result.success, true)
  assert.equal(await readFile(join(workspace, "README.md"), "utf8"), "after\n")
  assert.equal(result.runtime_result.agent_result?.changedFiles?.count, 1)
  assert.ok(result.runtime_result.agent_result?.patch?.bytes > 0)
  assert.equal(result.runtime_result.metadata.agent_runtime.workload.outputs.execution_changes.changed_files_count, 1)
  assert.ok(result.runtime_result.metadata.agent_runtime.workload.outputs.execution_changes.patch_bytes > 0)
  assert.deepEqual(result.runtime_result.typed_artifacts, [])
  assert.equal(result.runtime_result.agent_task_run_result.refs.changed_files.length, 1)
  assert.equal(result.runtime_result.agent_task_run_result.refs.patches.length, 1)
  assert.equal(result.runtime_result.metadata.runner_workspace_publication.pull_request.url, "https://github.com/owner/repo/pull/1")
  const serialized = JSON.stringify(result)
  for (const privateValue of ["e2e-github-secret", "e2e-openai-secret", "PRIVATE_WORKSPACE_SENTINEL", "PRIVATE_NPM_SENTINEL", "PRIVATE_NETRC_SENTINEL", "PRIVATE_KEY_SENTINEL", "PRIVATE_CODEBOX_SENTINEL", "PRIVATE_NODE_MODULES_SENTINEL", sources.root, workspace]) assert.doesNotMatch(serialized, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  await execFileAsync(process.execPath, [uploader], { cwd: workspace, env: { ...process.env, AGENT_TASK_WORKSPACE: workspace, AGENT_TASK_REQUEST_PATH: join(workspace, ".codebox", "agent-task-request.json"), AGENT_TASK_UPLOAD_PATH: join(workspace, ".codebox", "agent-task-upload"), GITHUB_TOKEN: "e2e-github-secret", OPENAI_API_KEY: "e2e-openai-secret" } })
  const exclusions = JSON.parse(await readFile(join(workspace, ".codebox", "agent-task-upload", ".codebox", "agent-task-artifacts", "exclusions.json"), "utf8"))
  assert.equal(exclusions.canonical_transcripts.length, 1, "available canonical evidence is projected once")
  assert.match(exclusions.canonical_transcripts[0].provenance.artifact_path, /^runtime-[a-z0-9-]+\/files\/transcript\.json$/)
  const staged = JSON.stringify(await Promise.all((await readdir(join(workspace, ".codebox", "agent-task-upload"), { recursive: true })).map((path) => readFile(join(workspace, ".codebox", "agent-task-upload", path), "utf8").catch(() => ""))))
  assert.doesNotMatch(staged, /"tool_observability"/, "absent optional tool observability is omitted during upload staging")
  for (const privateValue of ["wp-codebox-runner-workspace-seed-", workspace, "PRIVATE_WORKSPACE_SENTINEL", "PRIVATE_NPM_SENTINEL", "PRIVATE_NETRC_SENTINEL", "PRIVATE_KEY_SENTINEL"]) assert.doesNotMatch(staged, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  const stagedInput = JSON.parse(await readFile(join(workspace, ".codebox", "agent-task-upload", ".codebox", "native-agent-task-input.json"), "utf8"))
  assert.deepEqual(stagedInput.task_input.workspaces[0].seed, { kind: "runner-workspace-seed", digest: seedProvenance.digest.sha256, files: 2, bytes: seedProvenance.bytes, excludes: seedProvenance.excludes, excluded: seedProvenance.excluded })
  const digest = createHash("sha256").update(await readFile(join(workspace, "README.md"))).digest("hex")
  assert.equal(digest.length, 64)
  await rm(sources.root, { recursive: true, force: true })
  console.log("native agent task Playground e2e ok")
} finally {
  await rm(temp, { recursive: true, force: true })
}
