import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
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
  const runtimeSpec = { backend: "wordpress-native", environment: { kind: "wordpress", name: "WordPress", version: "6.8", phpVersion: "8.4" }, policy: { network: "deny", filesystem: "sandbox", commands: ["wordpress.run-php", "wordpress.browser-actions", "wordpress.bench"], secrets: "none", approvals: "never" }, artifactsDirectory }

  const driver = createDockerNativeRuntimeDriver()
  try {
    const provenance = await driver.create(runtimeSpec)
    assert.equal(provenance.container.containment, "required")
    assert.deepEqual(provenance.wordPressRoot, { source: "image-default" })
    assert.equal((await driver.execute({ command: "wordpress.run-php", args: ["code=echo 'native-php';"] })).stdout.trim(), "native-php")

    // The full browser-action argument set: route-host maps declared hosts into the
    // contained runtime, auth-user-id authenticates the fixture user, capture honors
    // its streams, and step-timeout/timeout bound the interaction. Evidence is retained.
    const browser = await driver.execute({
      command: "wordpress.browser-actions",
      args: [
        "auth=wordpress-admin",
        "auth-user-id=1",
        "route-host=example.test,site.test",
        "capture=steps,network,console,errors",
        "step-timeout=30s",
        "timeout=60s",
        `steps-json=${JSON.stringify([
          { kind: "navigate", url: "/wp-admin/", waitFor: "load" },
          { kind: "expect", selector: "#wpadminbar", state: "visible" },
          // A declared route-host must resolve inside the contained runtime.
          { kind: "navigate", url: "http://site.test/wp-admin/", waitFor: "load" },
          { kind: "expect", selector: "#wpadminbar", state: "visible" },
        ])}`,
      ],
    })
    assert.match(browser.stdout, /"authenticated":true/)
    assert.match(browser.stdout, /"fixtureUserId":1/)

    const benchmark = await driver.execute({ command: "wordpress.bench" })
    assert.match(benchmark.stdout, /coldStartupMs/)
    assert.match(benchmark.stdout, /warmNoopPhpMs/)
    assert.match(benchmark.stdout, /dynamicWordPressRequestMs/)

    const artifacts = await driver.collectArtifacts()
    assert.ok(artifacts.manifestPath.endsWith("manifest.json"))
    assert.match(await readFile(artifacts.observationsPath, "utf8"), /wp-admin/)
    assert.match(await readFile(join(artifacts.directory, "files/browser/steps.json"), "utf8"), /"passed"/)
    assert.match(await readFile(join(artifacts.directory, "files/browser/network.json"), "utf8"), /site\.test/)

    // A consumer-supplied WordPress root must be honored and recorded as a directory
    // source, not confused with the pinned image default. We prove it by extracting the
    // pinned image's WordPress tree, adding a distinctive marker, and re-supplying it.
    const customRoot = await mkdtemp(join(tmpdir(), "wp-codebox-custom-root-"))
    const stockContainer = spawnSync("docker", ["create", "wordpress:php8.4-apache@sha256:b5ad1a1b6fe6f1232d27a6effb0abc45cf71dcac6d6aba0db7d6fcaec047ffb3"], { encoding: "utf8" })
    assert.equal(stockContainer.status, 0, `could not create stock WordPress container: ${stockContainer.stderr}`)
    const stockId = stockContainer.stdout.trim()
    try {
      const cp = spawnSync("docker", ["cp", `${stockId}:/var/www/html/.`, customRoot], { encoding: "utf8" })
      assert.equal(cp.status, 0, `could not extract stock WordPress tree: ${cp.stderr}`)
    } finally {
      spawnSync("docker", ["rm", "-f", stockId], { encoding: "utf8" })
    }
    const marker = `wp-codebox-custom-root-${randomUUID()}.txt`
    await writeFile(join(customRoot, marker), "custom-root-marker")

    const customDriver = createDockerNativeRuntimeDriver()
    try {
      const customProvenance = await customDriver.create({ ...runtimeSpec, environment: { ...runtimeSpec.environment, assets: { wordpressDirectory: customRoot } } })
      assert.deepEqual(customProvenance.wordPressRoot, { source: "directory", path: customRoot })
      const probe = await customDriver.execute({ command: "wordpress.run-php", args: [`code=echo file_exists('/var/www/html/${marker}') ? 'custom-root-present' : 'missing';`] })
      assert.equal(probe.stdout.trim(), "custom-root-present")
    } finally {
      await customDriver.destroy()
    }

    console.log(`native Docker runtime integration passed; reviewer artifacts retained at ${artifactsDirectory}`)
  } finally {
    await driver.destroy()
  }
}
