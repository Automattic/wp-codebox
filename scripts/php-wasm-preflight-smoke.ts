import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { PhpWasmRuntimeAssetIntegrityError, preflightPhpWasmRuntimeAssets } from "../packages/runtime-playground/src/php-wasm-preflight.js"

const validEmptyWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const execFileAsync = promisify(execFile)

async function main(): Promise<void> {
  await assertMissingJspiWasmFailsEarly()
  await assertMissingAsyncifyWasmFailsEarly()
  await assertCorruptAsyncifyWasmFailsEarly()
  await assertHealthyRuntimeProvenance()
  await assertInstalledPhp84RuntimePreflights()
  await assertNoJspiRespawnSelectsAsyncify()
  await assertRecipeRunJsonReportsPreflightDiagnostic()
  console.log("PHP wasm runtime preflight smoke passed")
}

async function assertMissingJspiWasmFailsEarly(): Promise<void> {
  const fixture = await phpWasmFixture()
  await writeLoader(fixture, "jspi", "8_3_31")

  await assert.rejects(
    () => preflightPhpWasmRuntimeAssets({ packageRoot: fixture, packageName: "@php-wasm/node-8-3", phpVersion: "8.3", mode: "jspi" }),
    (error) => {
      const diagnostic = assertPreflightError(error)
      assert.equal(diagnostic.reason, "missing-wasm")
      assert.equal(diagnostic.mode, "jspi")
      assert.match(String(diagnostic.wasmPath), /jspi\/8_3_31\/php_8_3\.wasm$/)
      return true
    },
  )
}

async function assertMissingAsyncifyWasmFailsEarly(): Promise<void> {
  const fixture = await phpWasmFixture()
  await writeLoader(fixture, "asyncify", "8_3_30")

  await assert.rejects(
    () => preflightPhpWasmRuntimeAssets({ packageRoot: fixture, packageName: "@php-wasm/node-8-3", phpVersion: "8.3", mode: "asyncify" }),
    (error) => {
      const diagnostic = assertPreflightError(error)
      assert.equal(diagnostic.reason, "missing-wasm")
      assert.equal(diagnostic.mode, "asyncify")
      assert.match(String(diagnostic.wasmPath), /asyncify\/8_3_30\/php_8_3\.wasm$/)
      return true
    },
  )
}

async function assertCorruptAsyncifyWasmFailsEarly(): Promise<void> {
  const fixture = await phpWasmFixture()
  await writeLoader(fixture, "asyncify", "8_3_30")
  await writeWasm(fixture, "asyncify", "8_3_30", Buffer.from("not wasm"))

  await assert.rejects(
    () => preflightPhpWasmRuntimeAssets({ packageRoot: fixture, packageName: "@php-wasm/node-8-3", phpVersion: "8.3", mode: "asyncify" }),
    (error) => {
      const diagnostic = assertPreflightError(error)
      assert.equal(diagnostic.reason, "invalid-wasm")
      assert.equal(diagnostic.mode, "asyncify")
      assert.equal(diagnostic.wasmSize, 8)
      return true
    },
  )
}

async function assertHealthyRuntimeProvenance(): Promise<void> {
  const fixture = await phpWasmFixture()
  await writeLoader(fixture, "jspi", "8_3_31")
  await writeWasm(fixture, "jspi", "8_3_31", validEmptyWasm)

  const preflight = await preflightPhpWasmRuntimeAssets({ packageRoot: fixture, packageName: "@php-wasm/node-8-3", phpVersion: "8.3", mode: "jspi" })
  assert.equal(preflight.schema, "wp-codebox/php-wasm-runtime-asset-preflight/v1")
  assert.equal(preflight.packageName, "@php-wasm/node-8-3")
  assert.equal(preflight.packageVersion, "3.1.35-test")
  assert.equal(preflight.phpVersion, "8.3")
  assert.equal(preflight.mode, "jspi")
  assert.equal(preflight.wasmSize, validEmptyWasm.length)
  assert.match(preflight.wasmSha256, /^[a-f0-9]{64}$/)
}

async function assertNoJspiRespawnSelectsAsyncify(): Promise<void> {
  const fixture = await phpWasmFixture()
  await writeLoader(fixture, "asyncify", "8_3_30")
  await writeWasm(fixture, "asyncify", "8_3_30", validEmptyWasm)

  const previousPackageRoot = process.env.WP_CODEBOX_PHP_WASM_PACKAGE_ROOT
  const previousPhpVersion = process.env.WP_CODEBOX_PHP_WASM_VERSION
  const previousMode = process.env.WP_CODEBOX_PHP_WASM_MODE
  const previousNoJspiRespawn = process.env.WP_CODEBOX_NO_JSPI_RESPAWN
  try {
    process.env.WP_CODEBOX_PHP_WASM_PACKAGE_ROOT = fixture
    process.env.WP_CODEBOX_PHP_WASM_VERSION = "8.3"
    delete process.env.WP_CODEBOX_PHP_WASM_MODE
    process.env.WP_CODEBOX_NO_JSPI_RESPAWN = "1"

    const preflight = await preflightPhpWasmRuntimeAssets({ packageName: "@php-wasm/node-8-3" })
    assert.equal(preflight.mode, "asyncify")
    assert.match(preflight.wasmPath, /asyncify\/8_3_30\/php_8_3\.wasm$/)
  } finally {
    restoreEnv("WP_CODEBOX_PHP_WASM_PACKAGE_ROOT", previousPackageRoot)
    restoreEnv("WP_CODEBOX_PHP_WASM_VERSION", previousPhpVersion)
    restoreEnv("WP_CODEBOX_PHP_WASM_MODE", previousMode)
    restoreEnv("WP_CODEBOX_NO_JSPI_RESPAWN", previousNoJspiRespawn)
  }
}

async function assertInstalledPhp84RuntimePreflights(): Promise<void> {
  const preflight = await preflightPhpWasmRuntimeAssets({ phpVersion: "8.4", mode: "jspi" })
  assert.equal(preflight.packageName, "@php-wasm/node-8-4")
  assert.equal(preflight.phpVersion, "8.4")
  assert.equal(preflight.mode, "jspi")
  assert.match(preflight.wasmPath, /jspi\/.+\/php_8_4\.wasm$/)
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }

  process.env[name] = value
}

async function assertRecipeRunJsonReportsPreflightDiagnostic(): Promise<void> {
  const fixture = await phpWasmFixture()
  await writeLoader(fixture, "jspi", "8_3_31")
  const recipeDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-php-wasm-recipe-"))
  const mountDirectory = join(recipeDirectory, "plugin")
  await mkdir(mountDirectory)
  const recipePath = join(recipeDirectory, "recipe.json")
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", name: "php-wasm-preflight", wp: "7.0" },
    inputs: { mounts: [{ source: "./plugin", target: "/wordpress/wp-content/plugins/plugin", mode: "readwrite" }] },
    workflow: { steps: [{ command: "wordpress.run-php", args: ["code=<?php echo 'should-not-run';"] }] },
  }, null, 2)}\n`)

  const child = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--json"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WP_CODEBOX_PHP_WASM_PACKAGE_ROOT: fixture,
      WP_CODEBOX_PHP_WASM_VERSION: "8.3",
      WP_CODEBOX_PHP_WASM_MODE: "jspi",
      WP_CODEBOX_NO_JSPI_RESPAWN: "1",
    },
  }).catch((error: unknown) => error as { stdout?: string; stderr?: string; code?: number })

  assert.equal(child.code, 1)
  assert.ok(child.stdout, `Expected recipe-run JSON on stdout. stderr=${child.stderr ?? ""}`)
  const output = JSON.parse(String(child.stdout)) as {
    success: boolean
    diagnostics?: Array<{ schema: string; phase: string; runtime?: Record<string, unknown>; repair?: string }>
    error?: SerializedSmokeError
  }
  assert.equal(output.success, false)
  assert.equal(output.error?.code, "recipe-runtime-create-failed")
  assert.ok(errorCauseCodes(output.error).includes("wp-codebox-php-wasm-runtime-asset-invalid"))
  const diagnostic = output.diagnostics?.find((item) => item.schema === "wp-codebox/php-wasm-runtime-diagnostic/v1")
  assert.ok(diagnostic)
  assert.equal(diagnostic.phase, "preflight")
  assert.equal(diagnostic.runtime?.reason, "missing-wasm")
  assert.equal(diagnostic.runtime?.mode, "jspi")
  assert.match(String(diagnostic.repair), /reinstalling dependencies/)
}

interface SerializedSmokeError {
  code?: string
  cause?: SerializedSmokeError
}

function errorCauseCodes(error: SerializedSmokeError | undefined): string[] {
  if (!error) {
    return []
  }

  return [...(error.code ? [error.code] : []), ...errorCauseCodes(error.cause)]
}

async function phpWasmFixture(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "wp-codebox-php-wasm-preflight-"))
  await writeFile(join(fixture, "package.json"), `${JSON.stringify({ name: "@php-wasm/node-8-3", version: "3.1.35-test" }, null, 2)}\n`)
  return fixture
}

async function writeLoader(fixture: string, mode: "jspi" | "asyncify", versionDirectory: string): Promise<void> {
  const modeDirectory = join(fixture, mode)
  await mkdir(modeDirectory, { recursive: true })
  await writeFile(join(modeDirectory, "php_8_3.js"), `import path from "node:path"\nconst currentDirPath = path.dirname(new URL(import.meta.url).pathname)\nconst dependencyFilename = path.join(currentDirPath, '${versionDirectory}', 'php_8_3.wasm')\nexport default dependencyFilename\n`)
}

async function writeWasm(fixture: string, mode: "jspi" | "asyncify", versionDirectory: string, bytes: Buffer): Promise<void> {
  const wasmDirectory = join(fixture, mode, versionDirectory)
  await mkdir(wasmDirectory, { recursive: true })
  await writeFile(join(wasmDirectory, "php_8_3.wasm"), bytes)
}

function assertPreflightError(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof PhpWasmRuntimeAssetIntegrityError)
  assert.equal(error.code, "wp-codebox-php-wasm-runtime-asset-invalid")
  assert.match(error.message, /PHP wasm runtime asset preflight failed before WordPress Playground boot/)
  assert.match(error.repair, /reinstalling dependencies/)
  return error.diagnostic
}

await main()
