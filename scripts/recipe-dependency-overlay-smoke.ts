import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-dependency-overlay-"))

try {
  const consumer = join(workspace, "consumer")
  const dependency = join(workspace, "dependency")
  await mkdir(consumer, { recursive: true })
  await mkdir(dependency, { recursive: true })
  await writeFile(join(consumer, "consumer.php"), `<?php
/**
 * Plugin Name: Consumer
 */
`)
  await writeFile(join(dependency, "marker.txt"), "sibling dependency overlay\n")

  const recipePath = join(workspace, "recipe.json")
  const artifacts = join(workspace, "artifacts")
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "latest" },
    inputs: {
      extra_plugins: [{
        source: consumer,
        slug: "consumer",
        pluginFile: "consumer/consumer.php",
        activate: false,
      }],
      dependency_overlays: [{
        kind: "composer-package",
        package: "acme/dependency",
        source: dependency,
        consumer: "consumer",
        metadata: { ref: "sibling-dev" },
      }],
    },
    workflow: {
      steps: [{
        command: "wordpress.run-php",
        args: ["code=echo file_get_contents(WP_PLUGIN_DIR . '/consumer/vendor/acme/dependency/marker.txt');"],
      }],
    },
    artifacts: { directory: artifacts },
  }, null, 2)}\n`)

  const dryRun = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--dry-run", "--json"], { cwd: root })
  const dryRunOutput = JSON.parse(dryRun.stdout)
  assert.equal(dryRunOutput.success, true, dryRunOutput.error?.message)
  assert.equal(dryRunOutput.plan.mounts.some((mount: { target?: string; metadata?: { kind?: string; package?: string }; planned?: string }) => mount.metadata?.kind === "dependency-overlay" && mount.metadata.package === "acme/dependency" && mount.target === "/wordpress/wp-content/plugins/consumer/vendor/acme/dependency" && mount.planned === "existing"), true)

  const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--json"], { cwd: root })
  const output = JSON.parse(stdout)
  assert.equal(output.success, true, output.error?.message)
  assert.equal(output.executions[0]?.stdout, "sibling dependency overlay\n")

  const metadata = JSON.parse(await readFile(join(output.artifacts.directory, "metadata.json"), "utf8"))
  const overlay = metadata.context.preparedDependencyOverlays[0]
  assert.equal(overlay.target, "/wordpress/wp-content/plugins/consumer/vendor/acme/dependency")
  assert.equal(overlay.package, "acme/dependency")
  assert.equal(overlay.consumer, "consumer")
  assert.match(overlay.metadata.digest.sha256, /^[a-f0-9]{64}$/)

  console.log("Recipe dependency overlay smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}
