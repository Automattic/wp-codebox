import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

const packageRoot = resolve(import.meta.dirname, "..")

const args = process.argv.slice(2)
const local = args.includes("--local")
const remote = args.includes("--remote")
const persistIndex = args.indexOf("--persist-to")
const persistTo = persistIndex === -1 ? undefined : args[persistIndex + 1]
if (local === remote || (local && !persistTo)) throw new Error("Use exactly one of --local --persist-to <directory> or --remote.")

const manifest = JSON.parse(await readFile(resolve(packageRoot, "assets/wordpress-runtime-artifact.json"), "utf8"))
const archive = await readFile(resolve(packageRoot, "artifacts/cloudflare-wordpress-runtime-corpus.zip"))
const actual = createHash("sha256").update(archive).digest("hex")
if (actual !== manifest.archive.sha256 || archive.byteLength !== manifest.archive.size || manifest.key !== `runtime/wordpress/${actual}.zip`) throw new Error("Local WordPress runtime artifact does not match its content-addressed manifest.")
const staticManifest = JSON.parse(await readFile(resolve(packageRoot, "assets/wordpress-static-artifact.json"), "utf8"))
const staticBlob = await readFile(resolve(packageRoot, "artifacts/cloudflare-wordpress-static-corpus.bin"))
const staticActual = createHash("sha256").update(staticBlob).digest("hex")
if (staticActual !== staticManifest.blob.sha256 || staticBlob.byteLength !== staticManifest.blob.size || staticManifest.key !== `runtime/wordpress-static/${staticActual}.bin`) throw new Error("Local WordPress static artifact does not match its content-addressed manifest.")
const sqliteManifest = JSON.parse(await readFile(resolve(packageRoot, "assets/sqlite-database-integration-artifact.json"), "utf8"))
const sqliteArchive = await readFile(resolve(packageRoot, "artifacts/cloudflare-sqlite-database-integration.zip"))
const sqliteActual = createHash("sha256").update(sqliteArchive).digest("hex")
if (sqliteActual !== sqliteManifest.archive.sha256 || sqliteArchive.byteLength !== sqliteManifest.archive.size || sqliteManifest.key !== `runtime/archives/sqlite-database-integration/${sqliteActual}.zip`) throw new Error("Local SQLite integration artifact does not match its content-addressed manifest.")
const websiteImporterManifest = JSON.parse(await readFile(resolve(packageRoot, "assets/website-importer-artifact.json"), "utf8"))
const websiteImporterArchive = await readFile(resolve(packageRoot, "artifacts/cloudflare-website-importer.zip"))
const websiteImporterActual = createHash("sha256").update(websiteImporterArchive).digest("hex")
if (websiteImporterActual !== websiteImporterManifest.archive.sha256 || websiteImporterArchive.byteLength !== websiteImporterManifest.archive.size || websiteImporterManifest.key !== `runtime/archives/${websiteImporterManifest.name}/${websiteImporterActual}.zip`) throw new Error("Local website importer artifact does not match its content-addressed manifest.")

for (const artifact of [
  { key: manifest.key, size: manifest.archive.size, file: resolve(packageRoot, "artifacts/cloudflare-wordpress-runtime-corpus.zip") },
  { key: staticManifest.key, size: staticManifest.blob.size, file: resolve(packageRoot, "artifacts/cloudflare-wordpress-static-corpus.bin") },
  { key: sqliteManifest.key, size: sqliteManifest.archive.size, file: resolve(packageRoot, "artifacts/cloudflare-sqlite-database-integration.zip") },
  { key: websiteImporterManifest.key, size: websiteImporterManifest.archive.size, file: resolve(packageRoot, "artifacts/cloudflare-website-importer.zip") },
]) {
  const command = ["r2", "object", "put", `wp-codebox-runtime-chubes/${artifact.key}`, "--file", artifact.file, local ? "--local" : "--remote"]
  if (persistTo) command.push("--persist-to", persistTo)
  await new Promise((resolve, reject) => {
    const child = spawn("wrangler", command, { cwd: packageRoot, env: childEnvironment(), stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code) => code === 0 ? resolve(undefined) : reject(new Error(`Wrangler R2 provisioning failed with status ${code}.`)))
  })
  console.log(`Provisioned ${artifact.key} (${artifact.size} bytes).`)
}

function childEnvironment() { return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "NODE_OPTIONS" || !value?.includes("register-package-local-loader"))) }
