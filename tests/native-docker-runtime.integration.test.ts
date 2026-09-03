import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDockerNativeRuntimeDriver } from "@automattic/wp-codebox-native"

const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 10_000 })
if (docker.status !== 0) {
  console.log("native Docker runtime integration skipped: trusted-containment-tools-unavailable")
} else {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-native-docker-"))
  const driver = createDockerNativeRuntimeDriver()
  try {
    const provenance = await driver.create({ backend: "wordpress-native", environment: { kind: "wordpress", name: "WordPress", version: "6.8", phpVersion: "8.4" }, policy: { network: "deny", filesystem: "sandbox", commands: ["wordpress.run-php", "wordpress.browser-actions", "wordpress.bench"], secrets: "none", approvals: "never" }, artifactsDirectory })
    assert.equal(provenance.container.containment, "required")
    assert.equal((await driver.execute({ command: "wordpress.run-php", args: ["code=echo 'native-php';"] })).stdout.trim(), "native-php")
    assert.match((await driver.execute({ command: "wordpress.bench" })).stdout, /dynamicWordPressRequestMs/)
    assert.ok((await driver.collectArtifacts()).manifestPath.endsWith("manifest.json"))
    console.log("native Docker runtime integration passed")
  } finally {
    await driver.destroy()
    await rm(artifactsDirectory, { recursive: true, force: true })
  }
}
