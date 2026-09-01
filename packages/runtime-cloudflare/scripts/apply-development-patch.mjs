import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, relative, resolve } from "node:path"

const packageRoot = resolve(import.meta.dirname, "..")
const packageRequire = createRequire(resolve(packageRoot, "package.json"))
const dependencyRoot = dirname(packageRequire.resolve("@php-wasm/stream-compression/package.json"))
const installRoot = resolve(dependencyRoot, "../../..")
const patchDirectory = resolve(packageRoot, "patches")

execFileSync(process.execPath, [packageRequire.resolve("patch-package"), "--patch-dir", relative(installRoot, patchDirectory)], {
  cwd: installRoot,
  stdio: "inherit",
})
