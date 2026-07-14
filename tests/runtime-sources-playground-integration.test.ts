import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { materializeRuntimeSources, parseExternalPackageSourcePolicy, validateRuntimeSourceModel } from "../.github/scripts/run-agent-task/materialize-external-native-package.mjs"
import { buildAgentTaskRecipe } from "../packages/runtime-core/src/agent-task-recipe.js"
import { normalizeTaskInput } from "../packages/runtime-core/src/task-input.js"
import { sandboxToolPolicyFromAllowedTools } from "../packages/runtime-core/src/sandbox-tool-policy.js"

const execFileAsync = promisify(execFile)

const fixture = JSON.parse(await readFile(new URL("../fixtures/agent-task-runtime-sources-run-29299109269.json", import.meta.url), "utf8"))
const policy = parseExternalPackageSourcePolicy(JSON.stringify({
  version: 1,
  repositories: {},
  runtime_sources: Object.fromEntries(fixture.runtime_sources.filter((source: { repository?: string }) => source.repository).map((source: { repository: string; path: string }) => [source.repository, [source.path]])),
  runtime_artifacts: fixture.runtime_sources.filter((source: { source?: { type?: string } }) => source.source?.type === "https_zip").map((source: { source: { url: string; sha256: string } }) => ({ url: source.source.url, sha256: source.source.sha256 })),
}))
const root = await mkdtemp(join(tmpdir(), "wp-codebox-runtime-sources-playground-"))

try {
  const materialized = await materializeRuntimeSources(fixture.runtime_sources, { policy, tempRoot: root, forbiddenRoots: [join(root, "artifacts")] })
  const privatePackage = join(materialized.root, "flat-runtime-agent.agent.json")
  const interceptorPlugin = join(materialized.root, "openai-interceptor")
  const workspaceSeed = join(materialized.root, "workspace-seed")
  const packageInstruction = "PACKAGE SYSTEM INSTRUCTION: selected imported agent"
  const packageTools = ["workspace_read", "workspace_edit"]
  const genericSandboxInstruction = "Default sandbox agent"
  const genericSandboxTool = "deny-all"
  await mkdir(interceptorPlugin, { recursive: true })
  await writeFile(join(interceptorPlugin, "openai-interceptor.php"), `<?php
/**
 * Plugin Name: OpenAI Runtime Package Test Interceptor
 */
add_filter( 'pre_http_request', static function( $preempt, $args, $url ) {
    if ( ! str_starts_with( $url, 'https://api.openai.com/v1/' ) ) {
        return $preempt;
    }
    $capture = WP_CONTENT_DIR . '/openai-runtime-package-requests.json';
    $requests = is_readable( $capture ) ? json_decode( (string) file_get_contents( $capture ), true ) : array();
    $requests = is_array( $requests ) ? $requests : array();
    $requests[] = array( 'url' => $url, 'body' => $args['body'] ?? null );
    file_put_contents( $capture, wp_json_encode( $requests ) );
    if ( str_ends_with( $url, '/models' ) ) {
        $body = array( 'object' => 'list', 'data' => array( array( 'id' => 'gpt-5.5', 'object' => 'model', 'created' => 0, 'owned_by' => 'openai' ) ) );
    } else {
        $turn = count( array_filter( $requests, static fn( $request ) => str_ends_with( (string) $request['url'], '/responses' ) ) );
        $output = 1 === $turn
            ? array( array( 'id' => 'fc-read', 'type' => 'function_call', 'call_id' => 'call-read', 'name' => 'workspace_read', 'arguments' => wp_json_encode( array( 'path' => 'README.md' ) ) ) )
            : ( 2 === $turn
                ? array( array( 'id' => 'fc-edit', 'type' => 'function_call', 'call_id' => 'call-edit', 'name' => 'workspace_edit', 'arguments' => wp_json_encode( array( 'path' => 'README.md', 'old_string' => 'before', 'new_string' => 'after' ) ) ) )
                : array( array( 'id' => 'msg-fixture', 'type' => 'message', 'status' => 'completed', 'role' => 'assistant', 'content' => array( array( 'type' => 'output_text', 'text' => 'Workspace updated.', 'annotations' => array() ) ) ) ) );
        $body = array( 'id' => 'resp-fixture-' . $turn, 'object' => 'response', 'status' => 'completed', 'output' => $output, 'usage' => array( 'input_tokens' => 1, 'output_tokens' => 1, 'total_tokens' => 2 ) );
    }
    return array( 'headers' => array( 'content-type' => 'application/json' ), 'body' => wp_json_encode( $body ), 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array(), 'filename' => null );
}, 1000, 3 );
`)
  await writeFile(privatePackage, JSON.stringify({
    schema_version: 1,
    bundle_slug: "flat-runtime-agent",
    agent: {
      agent_slug: "flat-runtime-agent",
      agent_name: "Flat Runtime Agent",
      description: "Playground imported-agent selection fixture.",
      agent_config: {
        instructions: packageInstruction,
        enabled_tools: packageTools,
        modes: ["chat"],
      },
    },
  }) + "\n")
  await mkdir(workspaceSeed, { recursive: true })
  await writeFile(join(workspaceSeed, "README.md"), "before\n")
  const lowered = materialized.lowered.reduce((input: Record<string, unknown[]>, source: Record<string, unknown[]>) => {
    for (const [key, entries] of Object.entries(source)) input[key] = [...(input[key] ?? []), ...entries]
    return input
  }, {})
  const recipe = buildAgentTaskRecipe({
    goal: "Verify pinned public runtime sources",
    artifacts_path: join(materialized.root, "private-artifacts"),
    source_package_root: join(materialized.root, "prepared-packages"),
    runtime_env: { OPENAI_API_KEY: "dummy-key" },
    stagedFiles: [{ source: privatePackage, target: "/tmp/flat-runtime-agent.agent.json" }],
    ...lowered,
  }, normalizeTaskInput({ goal: "Verify pinned public runtime sources" }), "latest")
  recipe.workflow = {
    steps: [{
      command: "wordpress.run-php",
      args: ["code=" + String.raw`$imports = wp_agent_import_runtime_bundles( array( array( 'source' => '/tmp/flat-runtime-agent.agent.json', 'slug' => 'flat-runtime-agent', 'on_conflict' => 'upgrade' ) ), array( 'owner_id' => 1 ) );
if ( ! is_array( $imports ) || empty( $imports[0]['success'] ) ) { throw new RuntimeException( 'Canonical importer did not import the flat package: ' . wp_json_encode( $imports ) ); }
$client = \WordPress\AiClient\AiClient::defaultRegistry();
$provider_class = 'WordPress\\OpenAiAiProvider\\Provider\\OpenAiProvider';
$provider_resolved = is_object( $client ) && method_exists( $client, 'hasProvider' ) && class_exists( $provider_class ) && $client->hasProvider( $provider_class );
echo wp_json_encode( array( 'imported_slug' => $imports[0]['agent_slug'] ?? '', 'agents_registry' => class_exists( 'WP_Agents_Registry' ), 'provider_active' => is_plugin_active( 'ai-provider-for-openai/plugin.php' ), 'provider_class' => $provider_class, 'provider_resolved' => $provider_resolved, 'client' => is_object( $client ) ) );`],
    }],
  }
  const recipePath = join(root, "recipe.json")
  await writeFile(recipePath, `${JSON.stringify(recipe)}\n`)
  const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--json"], {
    cwd: process.cwd(),
    timeout: 300_000,
    env: { ...process.env, OPENAI_API_KEY: "dummy-key" },
    maxBuffer: 2 * 1024 * 1024,
  })
  const output = JSON.parse(result.stdout)
  const stdout = output.executions?.filter((execution: { command?: string }) => execution.command === "wordpress.run-php").at(-1)?.stdout ?? ""
  const checks = JSON.parse(stdout)
  assert.deepEqual(checks, { imported_slug: "flat-runtime-agent", agents_registry: true, provider_active: true, provider_class: "WordPress\\OpenAiAiProvider\\Provider\\OpenAiProvider", provider_resolved: true, client: true })
  const packageBytes = await readFile(privatePackage)
  const packageDigest = `sha256-bytes-v1:${createHash("sha256").update(packageBytes).digest("hex")}`
  const providerRecipe = buildAgentTaskRecipe({
    goal: "Prove explicit provider reaches the native runtime package",
    artifacts_path: join(materialized.root, "private-artifacts"),
    source_package_root: join(materialized.root, "prepared-runtime-sources"),
    provider: "openai",
    model: "gpt-5.5",
    runtime_env: { OPENAI_API_KEY: "dummy-key" },
    extra_plugins: [{ source: interceptorPlugin, slug: "openai-runtime-package-interceptor", pluginFile: "openai-runtime-package-interceptor/openai-interceptor.php", activate: true, loadAs: "plugin" }],
    workspaces: [{ target: "/workspace", mode: "readwrite", seed: { type: "directory", source: workspaceSeed } }],
    sandbox_tool_policy: sandboxToolPolicyFromAllowedTools(["workspace.read", "workspace.edit"], { source: "runtime-sources-playground-integration" }),
    ...lowered,
    runtime_task: {
      ability: "wp-codebox/run-runtime-package",
      input: {
        schema: "wp-codebox/runtime-package-task/v1",
        package: { slug: "flat-runtime-agent", source: "public-external-package", external_source: { digest: packageDigest }, bootstrap: { encoding: "base64", bytes: packageBytes.toString("base64"), digest: packageDigest } },
        workflow: { id: "agents/chat" },
        input: { prompt: "Read README.md, then replace before with after.", provider: "openai", model: "gpt-5.5", writable_paths: ["README.md"], runner_workspace_policy: { writable_paths: ["README.md"] } },
        artifact_declarations: [],
        required_artifacts: [],
      },
    },
  }, normalizeTaskInput({ goal: "Prove explicit provider reaches the native runtime package" }), "latest")
  const runtimeTaskArg = providerRecipe.workflow.steps[0].args?.find((arg) => arg.startsWith("runtime-task-json="))
  assert.ok(runtimeTaskArg, "native runtime package task must be part of the Playground closure")
  const runtimeTask = JSON.parse(runtimeTaskArg.slice("runtime-task-json=".length))
  assert.deepEqual(runtimeTask.input.input, { prompt: "Read README.md, then replace before with after.", provider: "openai", model: "gpt-5.5", writable_paths: ["README.md"], runner_workspace_policy: { writable_paths: ["README.md"] } })
  assert.throws(() => validateRuntimeSourceModel({ provider: "undeclared", name: "gpt-5.5" }, materialized.descriptors.map((descriptor: Record<string, unknown>) => ({ ...descriptor, metadata: { providers: descriptor.providers } }))), /not declared/, "an undeclared provider must be rejected before a chat turn is constructed")

  const readCapturedRequests = { command: "wordpress.run-php", args: ["code=echo is_readable( WP_CONTENT_DIR . '/openai-runtime-package-requests.json' ) ? file_get_contents( WP_CONTENT_DIR . '/openai-runtime-package-requests.json' ) : '[]';"] }
  const runRuntimePackage = async (mutateTask: (task: Record<string, any>) => void = () => {}) => {
    const candidate = structuredClone(providerRecipe)
    const taskIndex = candidate.workflow.steps[0].args.findIndex((arg: string) => arg.startsWith("runtime-task-json="))
    const task = JSON.parse(candidate.workflow.steps[0].args[taskIndex].slice("runtime-task-json=".length))
    mutateTask(task)
    candidate.workflow.steps[0].args[taskIndex] = `runtime-task-json=${JSON.stringify(task)}`
    candidate.workflow.steps.push(readCapturedRequests)
    await writeFile(recipePath, `${JSON.stringify(candidate)}\n`)
    try {
      const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--json"], {
        cwd: process.cwd(), timeout: 180_000, env: { ...process.env, OPENAI_API_KEY: "dummy-key" }, maxBuffer: 2 * 1024 * 1024,
      })
      return JSON.parse(result.stdout)
    } catch (error: any) {
      return JSON.parse(error.stdout)
    }
  }

   const runtimePackageOutput = await runRuntimePackage()
  const runtimeExecution = runtimePackageOutput.executions?.find((execution: { stdout?: string }) => execution.stdout?.includes("agent_runtime"))
   const runtime = JSON.parse(JSON.parse(runtimeExecution?.stdout ?? "{}").output ?? "{}")
   assert.equal(runtime.agent_runtime?.success, true, JSON.stringify(runtimePackageOutput.executions?.map((execution: { command?: string, stdout?: string }) => ({ command: execution.command, stdout: execution.stdout }))))
   assert.equal(runtime.agent_runtime.result.package.slug, "flat-runtime-agent", "the generated runtime must execute the imported agent identity")
   const requests = JSON.parse(runtimePackageOutput.executions?.filter((execution: { command?: string }) => execution.command === "wordpress.run-php").at(-1)?.stdout ?? "[]")
   const providerTurns = requests.filter((request: { url: string }) => request.url.endsWith("/responses"))
   assert.equal(providerTurns.length, 3, "the intercepted provider must receive read, edit, and terminal turns")
   const providerTurn = providerTurns[0]
   assert.ok(providerTurn, "the OpenAI provider transport must execute through the local interception fixture")
  assert.equal(JSON.parse(providerTurn.body).model, "gpt-5.5", "the selected OpenAI model must reach the provider transport")
  assert.match(providerTurn.body, new RegExp(packageInstruction), "the selected imported agent instruction must reach the provider transport")
  for (const packageTool of packageTools) assert.match(providerTurn.body, new RegExp(packageTool), "the selected imported agent tool schema must reach the provider transport")
   assert.doesNotMatch(providerTurn.body, new RegExp(genericSandboxInstruction), "the generic sandbox instruction must not reach an imported-agent model request")
   assert.doesNotMatch(providerTurn.body, new RegExp(genericSandboxTool), "the generic sandbox tool must not reach an imported-agent model request")
   assert.match(providerTurn.url, /^https:\/\/api\.openai\.com\/v1\/responses$/, "the selected OpenAI provider must reach its provider transport")
   const readTurn = JSON.parse(providerTurns[1].body)
   const editTurn = JSON.parse(providerTurns[2].body)
   const readOutput = readTurn.input.find((item: { type?: string, call_id?: string }) => item.type === "function_call_output" && item.call_id === "call-read")
   const editOutput = editTurn.input.find((item: { type?: string, call_id?: string }) => item.type === "function_call_output" && item.call_id === "call-edit")
   const readResult = JSON.parse(readOutput.output)
   assert.equal(readResult.success, true, "the second provider request must contain a successful sandbox read result")
   assert.equal(readResult.tool_name, "workspace_read")
   assert.deepEqual(readResult.result, { success: true, path: "README.md", content: "before\n", size: 7, lines_read: 2, offset: 1 })
   assert.deepEqual(readResult.runtime, { executor_target: "wp-codebox/sandbox-workspace", capability: "workspace.files.read", side_effects: [], side_effect_boundary: "wp-codebox-sandbox" })
   assert.equal(JSON.parse(editOutput.output).success, true, "the third provider request must receive the sandbox edit result")
   assert.equal(JSON.parse(editOutput.output).result.replacements, 1, `the sandbox executor must edit the seeded README: ${editOutput.output}`)
   assert.equal(JSON.parse(editOutput.output).runtime.executor_target, "wp-codebox/sandbox-workspace")
   assert.doesNotMatch(providerTurn.body, /workspace_worktree_add|workspace_worktree_remove|workspace_primary_/i, "parent workspace mutation tools must not be exposed to the provider")
   assert.equal(runtimePackageOutput.agentResult?.changedFiles?.count, 1, "the runtime must capture the changed sandbox file")
   assert.ok(runtimePackageOutput.agentResult?.patch?.bytes > 0, "the runtime must capture a canonical patch")
   const artifactDirectory = runtimePackageOutput.agentResult?.artifacts?.directory
   assert.equal(JSON.parse(await readFile(join(artifactDirectory, "files", "changed-files.json"), "utf8")).files[0].relativePath, "README.md")
   assert.match(await readFile(join(artifactDirectory, "files", "patch.diff"), "utf8"), /-before\n\+after/)

  for (const [label, mutateTask] of [
    ["package", (task: Record<string, any>) => { task.input.package.slug = "spoofed-agent" }],
    ["chat", (task: Record<string, any>) => { task.input.input.agent = "spoofed-agent" }],
    ["metadata", (task: Record<string, any>) => { task.input.metadata = { imported_agent: { slug: "spoofed-agent" } } }],
  ] as const) {
    const spoofOutput = await runRuntimePackage(mutateTask)
    const spoofExecution = spoofOutput.executions?.find((execution: { stdout?: string }) => execution.stdout?.includes("agent_runtime"))
    const spoofRuntime = JSON.parse(JSON.parse(spoofExecution?.stdout ?? "{}").output ?? "{}")
    assert.equal(spoofRuntime.agent_runtime?.success, false, `${label} agent identity spoof must fail`)
    const spoofRequests = JSON.parse(spoofOutput.executions?.filter((execution: { command?: string }) => execution.command === "wordpress.run-php").at(-1)?.stdout ?? "[]")
    assert.equal(spoofRequests.length, 0, `${label} agent identity spoof must fail before an outbound provider request`)
  }
  await rm(materialized.root, { recursive: true, force: true })
  await assert.rejects(access(privatePackage), /ENOENT/, "private source package must be removed with its materialization root")
  console.log(`runtime sources Playground integration ok: ${JSON.stringify(checks)}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/fetch failed|Could not resolve host|Connection timed out|network is unreachable/i.test(message)) {
    console.log(`runtime sources Playground integration skipped: pinned public sources were unreachable (${message})`)
  } else {
    throw error
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
