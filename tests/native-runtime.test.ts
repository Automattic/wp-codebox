import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { NativeRuntime, nativeRuntimeBackendProvider } from "../packages/runtime-playground/src/native-runtime.js"
import { listCliRuntimeBackendKinds, resolveCliRuntimeBackend } from "../packages/cli/src/runtime-backends.js"
import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"

const spec = { backend: "wordpress-native", environment: { kind: "wordpress", version: "6.8", phpVersion: "8.4" }, policy: {} } as RuntimeCreateSpec

test("native registration leaves Playground default and alias unchanged", () => {
  assert.ok(listCliRuntimeBackendKinds().includes("wordpress-native"))
  assert.equal(resolveCliRuntimeBackend("wordpress").kind, "wordpress-playground")
  assert.equal(resolveCliRuntimeBackend("").kind, "wordpress-playground")
  assert.equal(resolveCliRuntimeBackend("wordpress-native").kind, nativeRuntimeBackendProvider.kind)
})

test("unsupported commands return a structured result without booting Docker", async () => {
  const runtime = new NativeRuntime(spec)
  const result = await runtime.execute({ command: "wordpress.browser" })
  assert.equal(result.exitCode, 1)
  assert.equal(result.result?.error?.code, "wordpress-native-command-unsupported")
  assert.match(result.stderr, /not supported on wordpress-native/)
})

let docker = true
try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }) } catch { docker = false }
test("Docker: boot, route PHP and WP-CLI, remove all runtime resources", { skip: !docker, timeout: 900_000 }, async () => {
  const runtime = await nativeRuntimeBackendProvider.createBackend().create(spec)
  const id = (await runtime.info()).id
  try {
    const php = await runtime.execute({ command: "wordpress.run-php", args: ['code=echo PHP_VERSION, opcache_get_status() ? "opcache" : "no-opcache";'], timeoutMs: 30_000 })
    assert.equal(php.exitCode, 0, php.stderr)
    assert.match(php.stdout, /8\.4\..*opcache/)
    assert.ok(!php.stdout.includes("no-opcache"))
    const cli = await runtime.execute({ command: "wordpress.wp-cli", args: ["command=option get siteurl"], timeoutMs: 30_000 })
    assert.equal(cli.exitCode, 0, cli.stderr)
    assert.equal(cli.stdout.trim(), "http://localhost")
    const info = await runtime.info()
    assert.equal(info.backend, "wordpress-native")
    assert.ok(info.environment.metadata?.native)
    const timedOut = await runtime.execute({ command: "wordpress.run-php", args: ["bootstrap=none", "code=sleep(10);"], timeoutMs: 250 })
    assert.equal(timedOut.exitCode, 1, JSON.stringify(timedOut))
    assert.equal((await runtime.info()).status, "destroyed")
  } finally { await runtime.destroy() }
  for (const [kind, name] of [["container", `${id}-php`], ["container", `${id}-db`], ["network", id], ["volume", `${id}-wp`]]) {
    assert.throws(() => execFileSync("docker", [kind!, "inspect", name!], { stdio: "ignore" }))
  }
})
