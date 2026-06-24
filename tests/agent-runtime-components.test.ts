import assert from "node:assert/strict"
import { chdir, cwd } from "node:process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentRuntimeMounts, parseAgentRuntimeProbeOptions, type AgentRuntimeMount } from "../packages/cli/src/agent-sandbox.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-agent-runtime-components-"))
const originalCwd = cwd()
const originalAgentsApiPath = process.env.WP_CODEBOX_AGENTS_API_PATH
const originalDataMachinePath = process.env.WP_CODEBOX_DATA_MACHINE_PATH
const originalDataMachineCodePath = process.env.WP_CODEBOX_DATA_MACHINE_CODE_PATH
const originalRuntimeComponentPaths = process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS
const originalContainedRuntimeComponentPaths = process.env.CONTAINED_RUNTIME_COMPONENT_PATHS

try {
  chdir(root)

  const runtimeHost = join(root, "runtime-host")
  const agentsApi = join(runtimeHost, "vendor", "wordpress", "agents-api")
  mkdirSync(agentsApi, { recursive: true })
  writeFileSync(join(runtimeHost, "runtime-host.php"), "<?php\n/* Plugin Name: Runtime Host */\n")
  writeFileSync(join(agentsApi, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")

  const options = parseAgentRuntimeProbeOptions(["--component", runtimeHost], parseMount)
  const mounts = agentRuntimeMounts(options)
  const agentsApiMount = mounts.find((mount) => mount.metadata?.slug === "agents-api")

  assert.equal(agentsApiMount, undefined)

  const dataMachine = join(root, "data-machine")
  const bundledAgentsApi = join(dataMachine, "vendor", "wordpress", "agents-api")
  const dataMachineCode = join(root, "data-machine-code")
  mkdirSync(bundledAgentsApi, { recursive: true })
  mkdirSync(dataMachineCode, { recursive: true })
  writeFileSync(join(dataMachine, "data-machine.php"), "<?php\n/* Plugin Name: Data Machine */\n")
  writeFileSync(join(bundledAgentsApi, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")
  writeFileSync(join(dataMachineCode, "data-machine-code.php"), "<?php\n/* Plugin Name: Data Machine Code */\n")
  const workspace = join(root, "workspace")
  mkdirSync(workspace, { recursive: true })
  chdir(workspace)
  const defaultMounts = agentRuntimeMounts(parseAgentRuntimeProbeOptions([], parseMount))
  assertSamePath(defaultMounts.find((mount) => mount.metadata?.slug === "agents-api")?.source, bundledAgentsApi)
  assertSamePath(defaultMounts.find((mount) => mount.metadata?.slug === "data-machine")?.source, dataMachine)
  assertSamePath(defaultMounts.find((mount) => mount.metadata?.slug === "data-machine-code")?.source, dataMachineCode)

  process.env.CONTAINED_RUNTIME_COMPONENT_PATHS = [dataMachine, dataMachineCode].join(",")
  const configuredMounts = agentRuntimeMounts(parseAgentRuntimeProbeOptions([], parseMount))
  assertSamePath(configuredMounts.find((mount) => mount.metadata?.slug === "data-machine")?.source, dataMachine)
  assertSamePath(configuredMounts.find((mount) => mount.metadata?.slug === "data-machine-code")?.source, dataMachineCode)
  delete process.env.CONTAINED_RUNTIME_COMPONENT_PATHS

  rmSync(dataMachine, { recursive: true, force: true })
  const defaultAgentsApi = join(root, "agents-api")
  mkdirSync(defaultAgentsApi, { recursive: true })
  writeFileSync(join(defaultAgentsApi, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")
  const fallbackMounts = agentRuntimeMounts(parseAgentRuntimeProbeOptions([], parseMount))
  assertSamePath(fallbackMounts.find((mount) => mount.metadata?.slug === "agents-api")?.source, defaultAgentsApi)

  const explicitAgentsApi = join(root, "explicit-agents-api")
  mkdirSync(explicitAgentsApi, { recursive: true })
  writeFileSync(join(explicitAgentsApi, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")
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
  if (originalDataMachinePath === undefined) {
    delete process.env.WP_CODEBOX_DATA_MACHINE_PATH
  } else {
    process.env.WP_CODEBOX_DATA_MACHINE_PATH = originalDataMachinePath
  }
  if (originalDataMachineCodePath === undefined) {
    delete process.env.WP_CODEBOX_DATA_MACHINE_CODE_PATH
  } else {
    process.env.WP_CODEBOX_DATA_MACHINE_CODE_PATH = originalDataMachineCodePath
  }
  if (originalRuntimeComponentPaths === undefined) {
    delete process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS
  } else {
    process.env.WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS = originalRuntimeComponentPaths
  }
  if (originalContainedRuntimeComponentPaths === undefined) {
    delete process.env.CONTAINED_RUNTIME_COMPONENT_PATHS
  } else {
    process.env.CONTAINED_RUNTIME_COMPONENT_PATHS = originalContainedRuntimeComponentPaths
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
