import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentRuntimeMounts, parseAgentRuntimeProbeOptions, type AgentRuntimeMount } from "../packages/cli/src/agent-sandbox.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-agent-runtime-components-"))

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
} finally {
  rmSync(root, { recursive: true, force: true })
}

function parseMount(value: string): AgentRuntimeMount {
  const [source, target, mode = "readonly"] = value.split(":")
  if (mode !== "readonly" && mode !== "readwrite") {
    throw new Error(`Invalid mount mode: ${mode}`)
  }
  return { source, target, mode }
}
