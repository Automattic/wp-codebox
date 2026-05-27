import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRuntime } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"
import { normalizePluginCheckOutput } from "../packages/runtime-playground/src/commands.js"

const raw = JSON.stringify({
  errors: {
    "simple-plugin/simple-plugin.php": [[{
      code: "plugin_header_missing",
      message: "Plugin header is missing.",
      line: 1,
      column: 1,
      docs: "https://developer.wordpress.org/plugins/",
    }]],
  },
  warnings: {
    "simple-plugin/simple-plugin.php": [[{
      code: "escaping_missing",
      message: "Output should be escaped.",
      line: "12",
    }]],
  },
})

const normalized = normalizePluginCheckOutput(raw, 1, "simple-plugin")
assert.equal(normalized.schema, "wp-codebox/plugin-check/v1")
assert.equal(normalized.command, "wordpress.plugin-check")
assert.equal(normalized.targetPlugin, "simple-plugin")
assert.equal(normalized.exitCode, 1)
assert.equal(normalized.status, "failed")
assert.deepEqual(normalized.summary, { total: 2, errors: 1, warnings: 1, notices: 0, info: 0, unknown: 0 })
assert.equal(normalized.findings[0].file, "simple-plugin/simple-plugin.php")
assert.equal(normalized.findings[0].type, "error")
assert.equal(normalized.findings[0].line, 1)
assert.equal(normalized.findings[1].type, "warning")
assert.equal(normalized.findings[1].line, 12)

const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-plugin-check-"))
try {
  const mountDirectory = resolve("examples/simple-plugin")
  const runtime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "plugin-check-smoke", version: "7.0", blueprint: { steps: [] } },
      policy: {
        network: "deny",
        filesystem: "readwrite-mounts",
        commands: ["wordpress.plugin-check"],
        secrets: "none",
        approvals: "never",
      },
      artifactsDirectory,
      metadata: { runtime: { version: "0.0.0" }, task: { kind: "plugin-check-smoke" } },
    },
    createPlaygroundRuntimeBackend(),
  )

  await runtime.mount({
    type: "directory",
    source: mountDirectory,
    target: "/wordpress/wp-content/plugins/simple-plugin",
    mode: "readwrite",
    metadata: { kind: "component", slug: "simple-plugin" },
  })
  await assert.rejects(
    () => runtime.execute({ command: "wordpress.plugin-check", args: [] }),
    /requires plugin-slug=<slug>/,
  )
  const result = await runtime.execute({ command: "wordpress.plugin-check", args: ["plugin-slug=simple-plugin", "checks=plugin_header_fields"] })
  const output = JSON.parse(result.stdout)
  assert.equal(output.schema, "wp-codebox/plugin-check/v1")
  assert.equal(output.status, "failed")
  assert.equal(output.summary.errors, 1)
  assert.equal(output.findings[0].code, "plugin_header_no_license")
  const artifacts = await runtime.collectArtifacts({ includeLogs: true })
  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8"))
  assert.equal(manifest.files.some((file: { kind: string }) => file.kind === "plugin-check"), true)
  await runtime.destroy()
  console.log("Plugin Check normalization smoke passed")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}
