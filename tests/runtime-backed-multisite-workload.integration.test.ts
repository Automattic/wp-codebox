import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runCli } from "../packages/cli/src/cli-entry.js"

process.env.WP_CODEBOX_NO_JSPI_RESPAWN = "1"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-runtime-multisite-"))
try {
  const pluginSource = join(root, "network-fixture")
  const suitePath = join(root, "suite.json")
  const artifactsPath = join(root, "artifacts")
  await mkdir(pluginSource)
  await writeFile(join(pluginSource, "network-fixture.php"), `<?php
/*
Plugin Name: Runtime Multisite Fixture
Network: true
*/
`, "utf8")
  await writeFile(suitePath, JSON.stringify({
    schema: "wp-codebox/fuzz-suite/v1",
    id: "runtime-backed-multisite",
    metadata: {
      runtime_requirements: {
        blueprint: { preferredVersions: { php: "8.4", wp: "latest" }, steps: [{ step: "enableMultisite" }] },
        extra_plugins: [{ source: pluginSource, slug: "network-fixture", pluginFile: "network-fixture/network-fixture.php", activate: true, loadAs: "plugin" }],
      },
    },
    cases: [{
      id: "multisite-workload",
      target: { kind: "runtime", id: "wordpress.run-workload", entrypoint: "wordpress.run-workload" },
      input: {
        schema: "wp-codebox/wordpress-workload-run/v1",
        blueprint: { preferredVersions: { php: "8.4", wp: "latest" }, steps: [{ step: "enableMultisite" }] },
        steps: [
          { command: "wordpress.wp-cli", args: ["command=wp eval 'echo wp_json_encode( array( \\\"marker\\\" => \\\"WORKLOAD_REACHED\\\", \\\"multisite\\\" => is_multisite(), \\\"network_active\\\" => is_plugin_active_for_network( \\\"network-fixture/network-fixture.php\\\" ) ) );'"] },
          { command: "wordpress.browser-probe", args: ["url=/", "capture=html,screenshot", "script=return { title: document.title };"] },
        ],
      },
    }],
  }), "utf8")

  const output = await captureStdout(() => runCli(["run-fuzz-suite", "--input-file", suitePath, "--format=json", "--runner-mode=runtime-backed", "--artifacts", artifactsPath]))
  const result = JSON.parse(output)
  assert.equal(result.status, "passed", output)
  assert.equal(result.cases[0]?.status, "passed", output)
  const recipeResult = result.cases[0]?.metadata?.execution?.result?.json
  const wpCliExecution = recipeResult?.executions?.find((execution: { command?: string }) => execution.command === "wordpress.wp-cli")
  assert.deepEqual(JSON.parse(wpCliExecution?.stdout ?? "{}"), { marker: "WORKLOAD_REACHED", multisite: true, network_active: true })
  const browserExecution = recipeResult?.executions?.find((execution: { command?: string }) => execution.command === "wordpress.browser-probe")
  assert.equal(browserExecution?.exitCode, 0)
  const browserResult = JSON.parse(browserExecution?.stdout ?? "{}")
  assert.ok(JSON.stringify(browserResult).includes("screenshot"), browserExecution?.stdout)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Unable to resolve Playground startup asset.*fetch failed|Could not resolve host|network is unreachable/i.test(message)) {
    console.log("runtime-backed multisite workload integration skipped: WordPress runtime source unavailable")
  } else {
    throw error
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

async function captureStdout(callback: () => Promise<number>): Promise<string> {
  const chunks: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as typeof process.stdout.write
  try {
    assert.equal(await callback(), 0)
  } finally {
    process.stdout.write = originalWrite
  }
  return chunks.join("")
}
