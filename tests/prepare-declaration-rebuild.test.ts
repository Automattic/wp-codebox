import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, "..")
const coreBuildInfo = resolve(repositoryRoot, "packages/runtime-core/tsconfig.tsbuildinfo")
const coreDist = resolve(repositoryRoot, "packages/runtime-core/dist")

await execFileAsync("npm", ["run", "build"], { cwd: repositoryRoot, maxBuffer: 1024 * 1024 * 20 })
await access(coreBuildInfo)
await rm(coreDist, { recursive: true })
await access(coreBuildInfo)
await assert.rejects(access(resolve(coreDist, "index.d.ts")), /ENOENT/)

await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], {
  cwd: repositoryRoot,
  maxBuffer: 1024 * 1024 * 20,
})

for (const declaration of [
  "packages/runtime-core/dist/index.d.ts",
  "packages/runtime-playground/dist/index.d.ts",
  "packages/cli/dist/index.d.ts",
]) {
  await access(resolve(repositoryRoot, declaration))
}

console.log("prepare declaration rebuild passed")
