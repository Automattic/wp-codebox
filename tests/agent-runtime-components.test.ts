import assert from "node:assert/strict"
import { chdir, cwd } from "node:process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentRuntimeMounts, parseAgentRuntimeProbeOptions, type AgentRuntimeMount } from "../packages/cli/src/agent-sandbox.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-agent-runtime-components-"))
const originalCwd = cwd()
const originalAgentsApiPath = process.env.WP_CODEBOX_AGENTS_API_PATH
const originalAgentsApiVendorRoot = process.env.WP_CODEBOX_AGENTS_API_VENDOR_ROOT
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

  // A vendoring plugin (named generically here — wp-codebox does not know the
  // product) ships Agents API under its conventional vendored subpath. A deploy
  // points at the vendoring root through WP_CODEBOX_AGENTS_API_VENDOR_ROOT.
  const vendorRoot = join(root, "runtime-substrate")
  const bundledAgentsApi = join(vendorRoot, "vendor", "wordpress", "agents-api")
  const optInComponent = join(root, "opt-in-component")
  mkdirSync(bundledAgentsApi, { recursive: true })
  mkdirSync(optInComponent, { recursive: true })
  writeFileSync(join(bundledAgentsApi, "agents-api.php"), "<?php\n/* Plugin Name: Agents API */\n")
  writeFileSync(join(optInComponent, "opt-in-component.php"), "<?php\n/* Plugin Name: Opt In Component */\n")
  const workspace = join(root, "workspace")
  mkdirSync(workspace, { recursive: true })
  chdir(workspace)
  process.env.WP_CODEBOX_AGENTS_API_VENDOR_ROOT = vendorRoot

  // Default runtime: only Agents API is mounted. The runner's agent-facing
  // file/git/GitHub tool surface is served by the codebox-native runner-workspace
  // executor (registered by the active wp-codebox plugin), so no external
  // coding-agent plugin is mounted as a default runtime component. Agents API
  // resolves from the vendoring root, with no product-specific name baked in.
  const defaultMounts = agentRuntimeMounts(parseAgentRuntimeProbeOptions([], parseMount))
  assertSamePath(defaultMounts.find((mount) => mount.metadata?.slug === "agents-api")?.source, bundledAgentsApi)
  assert.equal(defaultMounts.find((mount) => mount.metadata?.slug === "data-machine"), undefined)
  assert.equal(defaultMounts.find((mount) => mount.metadata?.slug === "data-machine-code"), undefined)

  // A host/deploy that still needs additional substrate opts back in through the
  // configured runtime component paths — an arbitrary, codebox-name-neutral set.
  process.env.CONTAINED_RUNTIME_COMPONENT_PATHS = [optInComponent].join(",")
  const configuredMounts = agentRuntimeMounts(parseAgentRuntimeProbeOptions([], parseMount))
  assertSamePath(configuredMounts.find((mount) => mount.metadata?.slug === "opt-in-component")?.source, optInComponent)
  delete process.env.CONTAINED_RUNTIME_COMPONENT_PATHS

  delete process.env.WP_CODEBOX_AGENTS_API_VENDOR_ROOT
  rmSync(vendorRoot, { recursive: true, force: true })
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
  if (originalAgentsApiVendorRoot === undefined) {
    delete process.env.WP_CODEBOX_AGENTS_API_VENDOR_ROOT
  } else {
    process.env.WP_CODEBOX_AGENTS_API_VENDOR_ROOT = originalAgentsApiVendorRoot
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
