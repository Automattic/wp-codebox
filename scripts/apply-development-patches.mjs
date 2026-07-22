import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const patchPackageBin = resolve(import.meta.dirname, "..", "node_modules", "patch-package", "index.js")

if (existsSync(patchPackageBin)) {
  execFileSync(process.execPath, [patchPackageBin], { stdio: "inherit" })
} else {
  process.stdout.write("Skipping development patches in the production package.\n")
}
