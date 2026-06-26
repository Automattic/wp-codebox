import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { createRuntimeWpCliBridge } from "../packages/runtime-playground/src/runtime-wp-cli-bridge.js"

const bridge = await createRuntimeWpCliBridge(async () => ({ exitCode: 0, text: "", errors: "" }))
try {
  const literal = "literal;touch shell-expanded"
  const noShellResponse = await postBridgeAction(bridge.url, bridge.token, {
    type: "host_node",
    args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", literal],
  })
  assert.equal(noShellResponse.success, true)
  assert.deepEqual(JSON.parse(noShellResponse.stdout), [literal])
  assert.equal(noShellResponse.command, "node")
  assert.deepEqual(noShellResponse.args, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", literal])

  const originalExecPath = process.execPath
  const fallbackDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-node-fallback-"))
  try {
    const nodeShim = join(fallbackDirectory, "node")
    await writeFile(nodeShim, `#!/bin/sh\nprintf 'fallback-node:%s\\n' "$1"\n`, { mode: 0o755 })
    Object.defineProperty(process, "execPath", { value: join(fallbackDirectory, "missing-node"), configurable: true, writable: true })
    const fallbackResponse = await postBridgeAction(bridge.url, bridge.token, {
      type: "host_node",
      args: ["helper.mjs"],
      env: { PATH: `${fallbackDirectory}${delimiter}${process.env.PATH ?? ""}` },
    })
    assert.equal(fallbackResponse.success, true)
    assert.equal(fallbackResponse.stdout, "fallback-node:helper.mjs\n")
  } finally {
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true, writable: true })
    await rm(fallbackDirectory, { recursive: true, force: true })
  }

  const originalExecPathForFailure = process.execPath
  const emptyPathDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-node-missing-"))
  try {
    Object.defineProperty(process, "execPath", { value: join(emptyPathDirectory, "missing-node"), configurable: true, writable: true })
    const missingNodeResponse = await postBridgeAction(bridge.url, bridge.token, {
      type: "host_node",
      args: ["helper.mjs"],
      env: { PATH: emptyPathDirectory },
    })
    assert.equal(missingNodeResponse.success, false)
    assert.equal(missingNodeResponse.exitCode, 127)
    assert.match(missingNodeResponse.error, /process\.execPath/)
    assert.match(missingNodeResponse.error, /node was not found on PATH/)
  } finally {
    Object.defineProperty(process, "execPath", { value: originalExecPathForFailure, configurable: true, writable: true })
    await rm(emptyPathDirectory, { recursive: true, force: true })
  }
} finally {
  await bridge.close()
}

async function postBridgeAction(url: string, token: string, action: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(`${url}/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(action),
  })
  assert.equal(response.status, 200)
  return await response.json() as Record<string, any>
}
