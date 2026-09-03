import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve("@php-wasm/node-8-4/package.json"))
const releases = (await readdir(join(packageRoot, "jspi"))).filter((entry) => /^8_4_\d+$/.test(entry))
assert.equal(releases.length, 1, "PHP 8.4 JSPI package must contain one canonical patch release")

const wasmPath = join(packageRoot, "jspi", releases[0], "php_8_4.wasm")
const module = await WebAssembly.compile(await readFile(wasmPath))
const exports = new Set(WebAssembly.Module.exports(module).map(({ name }) => name))
const externalExtensionAbi = [
  "_emalloc",
  "convert_to_null",
  "explicit_bzero",
  "php_password_algo_find",
  "php_password_algo_register",
  "sscanf",
]

for (const symbol of externalExtensionAbi) {
  assert.ok(exports.has(symbol), `PHP 8.4 JSPI runtime must export external-extension ABI symbol ${symbol}`)
}

console.log("PHP 8.4 external-extension ABI exports passed")
