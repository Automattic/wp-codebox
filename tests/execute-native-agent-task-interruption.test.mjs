import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

const root = resolve(".")
const executor = join(root, ".github/scripts/run-agent-task/execute-native-agent-task.mjs")
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }

async function prepare() {
  const temp = await mkdtemp(join(tmpdir(), "wp-codebox-native-interruption-"))
  // A dedicated TMPDIR makes seed-snapshot residue deterministic to observe.
  const seedTemp = join(temp, "seed-tmp")
  const workspace = join(temp, "workspace")
  await mkdir(seedTemp, { recursive: true })
  await mkdir(join(workspace, ".codebox"), { recursive: true })
  await writeFile(join(workspace, "README.md"), "before\n")
  const request = {
    schema: "wp-codebox/agent-task-workflow-request/v1",
    model: { provider: "openai", name: "gpt-5" },
    external_package_source: {
      repository: "owner/agents",
      revision: "a".repeat(40),
      path: "agent.agent.json",
      digest: `sha256-bytes-v1:${"b".repeat(64)}`,
    },
    runtime_sources: [],
    workload: { id: "interruption-1", label: "Interruption" },
    target_repo: "owner/repo",
    prompt: "Interruption lifecycle fixture.",
    writable_paths: "README.md",
    runner_workspace: { enabled: true, repo: "owner/repo", base: "main", branch_prefix: "wp-codebox/agent-task/" },
    verification_commands: [],
    drift_checks: [],
    success: { requires_pr: false },
    access: { caller_repo: "owner/repo", allowed_repos: ["owner/repo"], access_token_repos: ["owner/repo"] },
    limits: { max_turns: 1, time_budget_ms: 1000 },
    artifacts: { expected: [], declarations: [] },
    outputs: { projections: {} },
    callback_data: {},
    run_agent: true,
    dry_run: true,
  }
  await writeFile(join(workspace, ".codebox", "agent-task-request.json"), JSON.stringify(request))
  return { temp, seedTemp, workspace }
}

function spawnExecutor({ seedTemp, workspace }, extraEnv = {}) {
  const child = spawn(process.execPath, [executor], {
    cwd: workspace,
    env: {
      ...process.env,
      NODE_ENV: "test",
      TMPDIR: seedTemp,
      AGENT_TASK_REQUEST_PATH: join(workspace, ".codebox", "agent-task-request.json"),
      AGENT_TASK_WORKSPACE: workspace,
      WP_CODEBOX_WORKFLOW_ROOT: root,
      GITHUB_TOKEN: "token",
      EXTERNAL_PACKAGE_SOURCE_POLICY: JSON.stringify({ version: 1, repositories: { "owner/agents": ["agent.agent.json"] } }),
      ...extraEnv,
    },
  })
  let stderr = ""
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const closed = new Promise((done) => { child.on("close", (code, signal) => done({ code, signal, stderr })) })
  return { child, closed }
}

async function seedSnapshotEntries(seedTemp) {
  return (await readdir(seedTemp)).filter((entry) => entry.startsWith("wp-codebox-runner-workspace-seed-"))
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  const fixture = await prepare()
  const pauseFile = join(fixture.temp, "pause.json")
  const { child, closed } = spawnExecutor(fixture, { WP_CODEBOX_TEST_SEED_SNAPSHOT_PAUSE_FILE: pauseFile })

  const deadline = Date.now() + 30_000
  while (!existsSync(pauseFile)) {
    assert.ok(Date.now() < deadline, `executor did not reach the seed snapshot pause hook for ${signal}`)
    await delay(50)
  }
  const marker = JSON.parse(await readFile(pauseFile, "utf8"))
  assert.equal(marker.schema, "wp-codebox/test-seed-snapshot-pause/v1")
  assert.ok(marker.seed_snapshot_source.startsWith(fixture.seedTemp), "seed snapshot is created under the controlled TMPDIR")
  assert.ok(existsSync(marker.seed_snapshot_source), "seed snapshot exists while the executor is paused")

  child.kill(signal)
  const exit = await closed
  assert.equal(exit.signal, null, `the executor handles ${signal} itself instead of dying to the default signal action\n${exit.stderr}`)
  assert.equal(exit.code, SIGNAL_EXIT_CODES[signal], `conventional exit code for ${signal}\n${exit.stderr}`)
  assert.equal(existsSync(marker.seed_snapshot_source), false, `the temp seed snapshot directory is removed on ${signal}`)
  assert.deepEqual(await seedSnapshotEntries(fixture.seedTemp), [], `no runner workspace seed content survives ${signal}`)
  assert.equal(await readFile(join(fixture.workspace, "README.md"), "utf8"), "before\n", "the host workspace is untouched")
  assert.deepEqual((await readdir(join(fixture.workspace, ".codebox"))).sort(), ["agent-task-artifacts", "agent-task-request.json"], "no runner workspace materials survive in the workspace")
  assert.deepEqual(await readdir(join(fixture.workspace, ".codebox", "agent-task-artifacts")), [], "no artifacts are staged before interruption")
}

// Normal completion continues to clean up through the same coordinator.
const fixture = await prepare()
const { closed } = spawnExecutor(fixture)
const exit = await closed
assert.equal(exit.code, 0, exit.stderr)
assert.deepEqual(await seedSnapshotEntries(fixture.seedTemp), [], "no runner workspace seed content survives a normal run")
const result = JSON.parse(await readFile(join(fixture.workspace, ".codebox", "agent-task-workflow-result.json"), "utf8"))
assert.equal(result.status, "skipped")

console.log("native agent task interruption ok")
