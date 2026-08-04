import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { gunzipSync } from "node:zlib"

const packageRoot = resolve(import.meta.dirname, "..")
const patchPackageBin = resolve(packageRoot, "node_modules", "patch-package", "index.js")

if (existsSync(patchPackageBin)) {
  execFileSync(process.execPath, [patchPackageBin], { stdio: "inherit" })
  for (const overlay of [
    {
      source: "patches/playground-node-dns-828a14d84db0048317295443562e82aa94e0be7b/asyncify-php_8_4.wasm.gz",
      target: "node_modules/@php-wasm/node-8-4/asyncify/8_4_24/php_8_4.wasm",
      sha256: "336a287c9e8addf683a42d001640daeedb8be419c3ae95497dcd59401e47ad90",
    },
    {
      source: "patches/playground-node-dns-828a14d84db0048317295443562e82aa94e0be7b/jspi-php_8_4.wasm.gz",
      target: "node_modules/@php-wasm/node-8-4/jspi/8_4_24/php_8_4.wasm",
      sha256: "439bd91ccddfdaba7381bbd915aa17652edb8d50bd7fd2c5c81a25e33cbf8776",
    },
  ]) {
    const source = resolve(packageRoot, overlay.source)
    const target = resolve(packageRoot, overlay.target)
    const bytes = gunzipSync(readFileSync(source))
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (digest !== overlay.sha256) {
      throw new Error(`Playground overlay checksum mismatch for ${overlay.source}: ${digest}`)
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
  }
} else {
  process.stdout.write("Skipping development patches in the production package.\n")
}
