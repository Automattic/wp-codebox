import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { materializeRuntimeSources, parseExternalPackageSourcePolicy } from "../.github/scripts/run-agent-task/materialize-external-native-package.mjs"
import { buildAgentTaskRecipe } from "../packages/runtime-core/src/agent-task-recipe.js"
import { normalizeTaskInput } from "../packages/runtime-core/src/task-input.js"

const execFileAsync = promisify(execFile)

if (process.env.WP_CODEBOX_RUN_NETWORK_INTEGRATION !== "1") {
  console.log("runtime sources Playground integration skipped: set WP_CODEBOX_RUN_NETWORK_INTEGRATION=1; CI enables this pinned-public-source test")
  process.exit(0)
}

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
  await writeFile(privatePackage, '{"schema_version":1,"bundle_slug":"flat-runtime-agent","agent":{"agent_slug":"flat-runtime-agent"}}\n')
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
