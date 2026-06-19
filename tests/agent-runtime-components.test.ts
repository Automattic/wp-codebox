import assert from "node:assert/strict"
import { chdir, cwd } from "node:process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentRuntimeMounts, parseAgentRuntimeProbeOptions, type AgentRuntimeMount } from "../packages/cli/src/agent-sandbox.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-agent-runtime-components-"))
const originalCwd = cwd()
const originalAgentsApiPath = process.env.WP_CODEBOX_AGENTS_API_PATH

try {
  const dataMachine = join(root, "data-machine")
  const agentsApi = join(dataMachine, "vendor", "wordpress", "agents-api")
  mkdirSync(agentsApi, { recursive: true })
  writeFileSync(join(dataMachine, "data-machine.php"), "<?php\n/* Plugin Name: Data Machine */\n")
  writeFileSync(join(agentsApi, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")

  const options = parseAgentRuntimeProbeOptions(["--component", dataMachine], parseMount)
  const mounts = agentRuntimeMounts(options)
  const agentsApiMount = mounts.find((mount) => mount.metadata?.slug === "agents-api")

  assert.equal(agentsApiMount?.source, agentsApi)
  assert.equal(agentsApiMount?.target, "/wordpress/wp-content/mu-plugins/wp-codebox-runtime/agents-api")
  assert.equal(agentsApiMount?.metadata?.pluginFile, "agents-api/agents-api.php")
  assert.equal(agentsApiMount?.metadata?.loadAs, "mu-plugin")

  const defaultAgentsApi = join(root, "agents-api")
  mkdirSync(defaultAgentsApi, { recursive: true })
  writeFileSync(join(defaultAgentsApi, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")
  const workspace = join(root, "workspace")
  mkdirSync(workspace, { recursive: true })
  chdir(workspace)
  const defaultMount = agentRuntimeMounts(parseAgentRuntimeProbeOptions([], parseMount))
    .find((mount) => mount.metadata?.slug === "agents-api")
  assertSamePath(defaultMount?.source, defaultAgentsApi)
  assert.equal(defaultMount?.target, "/wordpress/wp-content/mu-plugins/wp-codebox-runtime/agents-api")

  const explicitAgentsApi = join(root, "explicit-agents-api")
  mkdirSync(explicitAgentsApi, { recursive: true })
  writeFileSync(join(explicitAgentsApi, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")
  process.env.WP_CODEBOX_AGENTS_API_PATH = defaultAgentsApi
  const explicitMount = agentRuntimeMounts(parseAgentRuntimeProbeOptions(["--agents-api", explicitAgentsApi], parseMount))
    .find((mount) => mount.metadata?.slug === "agents-api")
  assertSamePath(explicitMount?.source, explicitAgentsApi)
} finally {
  chdir(originalCwd)
  if (originalAgentsApiPath === undefined) {
    delete process.env.WP_CODEBOX_AGENTS_API_PATH
  } else {
    process.env.WP_CODEBOX_AGENTS_API_PATH = originalAgentsApiPath
  }
  rmSync(root, { recursive: true, force: true })
}

function parseMount(value: string): AgentRuntimeMount {
  const [source, target, mode = "readonly"] = value.split(":")
  if (mode !== "readonly" && mode !== "readwrite") {
    throw new Error(`Invalid mount mode: ${mode}`)
  }
  return { source, target, mode }
}

function assertSamePath(actual: string | undefined, expected: string): void {
  assert.equal(actual ? realpathSync(actual) : actual, realpathSync(expected))
}
