import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assertPhpWasmExtensionAbi, PhpWasmExtensionAbiError, phpWasmExtensionMissingAbiSymbols } from "../packages/runtime-playground/src/php-wasm-preflight.js"

function wasmImporting(moduleName: string, importName: string): Uint8Array {
  const moduleBytes = Buffer.from(moduleName, "utf8")
  const nameBytes = Buffer.from(importName, "utf8")
  const importPayload = Buffer.concat([
    Buffer.from([1]),
    Buffer.from([moduleBytes.length]),
    moduleBytes,
    Buffer.from([nameBytes.length]),
    nameBytes,
    Buffer.from([0, 0]),
  ])
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x01, 0x04, 0x01, 0x60, 0x00, 0x00]),
    Buffer.from([0x02, importPayload.length]),
    importPayload,
  ])
}

const sodiumLike = wasmImporting("env", "php_password_algo_register")
assert.deepEqual(phpWasmExtensionMissingAbiSymbols(sodiumLike, []), ["php_password_algo_register"])
assert.deepEqual(phpWasmExtensionMissingAbiSymbols(sodiumLike, ["php_password_algo_register"]), [])
assert.deepEqual(phpWasmExtensionMissingAbiSymbols(wasmImporting("env", "__assert_fail"), []), [])
assert.deepEqual(phpWasmExtensionMissingAbiSymbols(wasmImporting("env", "_emalloc_448"), ["_emalloc", "_emalloc_128"]), ["_emalloc_448"])

const root = await mkdtemp(join(tmpdir(), "wp-codebox-php-wasm-abi-"))
const phpWasmPath = join(root, "php.wasm")
const manifestDir = join(root, "sodium")
const manifestPath = join(manifestDir, "manifest.json")
const artifactPath = join(manifestDir, "sodium-php8.4-jspi.so")
await mkdir(manifestDir)
await writeFile(phpWasmPath, wasmImporting("env", "unused"))
await writeFile(artifactPath, sodiumLike)
await writeFile(manifestPath, JSON.stringify({
  name: "sodium",
  artifacts: [{ phpVersion: "8.4", sourcePath: "sodium-php8.4-jspi.so" }],
}))
await assert.rejects(
  assertPhpWasmExtensionAbi({
    extensions: [{ manifest: manifestPath }],
    phpVersion: "8.4",
    phpWasmPath,
    mode: "jspi",
  }),
  (error: unknown) => error instanceof PhpWasmExtensionAbiError
    && error.code === "wp-codebox-php-wasm-extension-abi-mismatch"
    && error.diagnostic.missingSymbols.includes("php_password_algo_register"),
)
await rm(root, { recursive: true, force: true })

console.log("php wasm extension abi ok")
