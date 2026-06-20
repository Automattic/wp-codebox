import assert from "node:assert/strict"
import { chdir, cwd } from "node:process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentRuntimeMounts, parseAgentRuntimeProbeOptions, type AgentRuntimeMount } from "../packages/cli/src/agent-sandbox.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-agent-runtime-components-"))
const originalCwd = cwd()
const originalAgentsApiPath = process.env.WP_CODEBOX_AGENTS_API_PATH
const originalRuntimeComponentPaths = process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS

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
  const runtimeEngine = join(root, "runtime-engine")
  const runtimeTools = join(root, "runtime-tools")
  mkdirSync(runtimeEngine, { recursive: true })
  mkdirSync(runtimeTools, { recursive: true })
  writeFileSync(join(runtimeEngine, "runtime-engine.php"), "<?php\n/* Plugin Name: Runtime Engine */\n")
  writeFileSync(join(runtimeTools, "runtime-tools.php"), "<?php\n/* Plugin Name: Runtime Tools */\n")
  process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS = `${runtimeEngine},${runtimeTools}`
  const workspace = join(root, "workspace")
  mkdirSync(workspace, { recursive: true })
  chdir(workspace)
  const defaultMounts = agentRuntimeMounts(parseAgentRuntimeProbeOptions([], parseMount))
  const defaultMount = defaultMounts
    .find((mount) => mount.metadata?.slug === "agents-api")
  assertSamePath(defaultMount?.source, defaultAgentsApi)
  assert.equal(defaultMount?.target, "/wordpress/wp-content/mu-plugins/wp-codebox-runtime/agents-api")
  assertSamePath(defaultMounts.find((mount) => mount.metadata?.slug === "runtime-engine")?.source, runtimeEngine)
  assertSamePath(defaultMounts.find((mount) => mount.metadata?.slug === "runtime-tools")?.source, runtimeTools)

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
  if (originalRuntimeComponentPaths === undefined) {
    delete process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS
  } else {
    process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS = originalRuntimeComponentPaths
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
