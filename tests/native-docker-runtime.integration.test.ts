import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createDockerNativeRuntimeDriver } from "@automattic/wp-codebox-native"

const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 10_000 })
if (docker.status !== 0) {
  console.log("native Docker runtime integration skipped: trusted-containment-tools-unavailable")
} else {
  // Reviewers need a resolvable path. An explicit directory keeps evidence out
  // of a per-job temporary root that its scheduler may reclaim.
  const requested = process.env.WP_CODEBOX_NATIVE_ARTIFACTS_DIR
  const artifactsDirectory = requested ? resolve(requested) : await mkdtemp(join(tmpdir(), "wp-codebox-native-docker-"))
  if (requested) await mkdir(artifactsDirectory, { recursive: true })
  const driver = createDockerNativeRuntimeDriver()
  try {
    const provenance = await driver.create({ backend: "wordpress-native", environment: { kind: "wordpress", name: "WordPress", version: "6.8", phpVersion: "8.4" }, policy: { network: "deny", filesystem: "sandbox", commands: ["wordpress.run-php", "wordpress.browser-actions", "wordpress.bench"], secrets: "none", approvals: "never" }, artifactsDirectory })
    assert.equal(provenance.container.containment, "required")
    assert.equal((await driver.execute({ command: "wordpress.run-php", args: ["code=echo 'native-php';"] })).stdout.trim(), "native-php")
    const browser = await driver.execute({ command: "wordpress.browser-actions", args: ["auth=wordpress-admin", `steps-json=${JSON.stringify([{ kind: "navigate", url: "/wp-admin/", waitFor: "load" }, { kind: "expect", selector: "#wpadminbar", state: "visible" }])}`, "capture=steps,network,console,errors"] })
    assert.match(browser.stdout, /"authenticated":true/)
    const benchmark = await driver.execute({ command: "wordpress.bench" })
    assert.match(benchmark.stdout, /coldStartupMs/)
    assert.match(benchmark.stdout, /warmNoopPhpMs/)
    assert.match(benchmark.stdout, /dynamicWordPressRequestMs/)
    const artifacts = await driver.collectArtifacts()
    assert.ok(artifacts.manifestPath.endsWith("manifest.json"))
    assert.match(await readFile(artifacts.observationsPath, "utf8"), /wp-admin/)
    assert.match(await readFile(join(artifacts.directory, "files/browser/steps.json"), "utf8"), /"passed"/)
    console.log(`native Docker runtime integration passed; reviewer artifacts retained at ${artifactsDirectory}`)
  } finally {
    await driver.destroy()
  }
}
