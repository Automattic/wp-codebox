import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { spawn } from "node:child_process"

const args = process.argv.slice(2)
const local = args.includes("--local")
const remote = args.includes("--remote")
const persistIndex = args.indexOf("--persist-to")
const persistTo = persistIndex === -1 ? undefined : args[persistIndex + 1]
if (local === remote || (local && !persistTo)) throw new Error("Use exactly one of --local --persist-to <directory> or --remote.")

const manifest = JSON.parse(await readFile("packages/runtime-cloudflare/assets/wordpress-runtime-artifact.json", "utf8"))
const archive = await readFile("artifacts/cloudflare-wordpress-runtime-corpus.zip")
const actual = createHash("sha256").update(archive).digest("hex")
if (actual !== manifest.archive.sha256 || archive.byteLength !== manifest.archive.size || manifest.key !== `runtime/wordpress/${actual}.zip`) throw new Error("Local WordPress runtime artifact does not match its content-addressed manifest.")

const command = ["exec", "--", "wrangler", "r2", "object", "put", `wp-codebox-runtime-chubes/${manifest.key}`, "--file", "artifacts/cloudflare-wordpress-runtime-corpus.zip", local ? "--local" : "--remote"]
if (persistTo) command.push("--persist-to", persistTo)
await new Promise((resolve, reject) => {
  const child = spawn("npm", command, { cwd: process.cwd(), stdio: "inherit" })
  child.on("error", reject)
  child.on("exit", (code) => code === 0 ? resolve(undefined) : reject(new Error(`Wrangler R2 provisioning failed with status ${code}.`)))
})
console.log(`Provisioned ${manifest.key} (${manifest.archive.size} bytes).`)
