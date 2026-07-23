import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const databaseName = option("--database-name", "wp-codebox-runtime-state")
const binding = option("--binding", "WORDPRESS_STATE_DATABASE")
const templatePath = resolve(option("--template", "packages/runtime-cloudflare/wrangler.d1.jsonc"))
const outputPath = resolve(option("--output"))
const wrangler = option("--wrangler", resolve("node_modules/.bin/wrangler"))
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(databaseName) || !/^[A-Z][A-Z0-9_]*$/.test(binding) || !option("--output")) throw new Error("A safe database name, binding, and --output path are required.")

let databases = await listDatabases()
let matches = databases.filter((database) => database.name === databaseName)
if (matches.length > 1) throw new Error(`Multiple D1 databases are named ${databaseName}.`)
if (!matches.length) {
  await run(["d1", "create", databaseName])
  databases = await listDatabases()
  matches = databases.filter((database) => database.name === databaseName)
}
const database = matches[0]
if (!database || typeof database.uuid !== "string" || !/^[a-f0-9-]{36}$/.test(database.uuid)) throw new Error(`D1 database ${databaseName} was not resolved after provisioning.`)

const template = parseJsonc(await readFile(templatePath, "utf8"))
const configured = template.d1_databases?.find((candidate) => candidate.binding === binding && candidate.database_name === databaseName)
if (!configured) throw new Error(`D1 template does not declare ${binding} for ${databaseName}.`)
configured.database_id = database.uuid
await writeFile(outputPath, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ schema: "wp-codebox/cloudflare-d1-provision/v1", databaseName, databaseId: database.uuid, binding, config: outputPath })}\n`)

async function listDatabases() {
  const output = await run(["d1", "list", "--json"])
  const parsed = JSON.parse(output)
  if (!Array.isArray(parsed)) throw new Error("Wrangler returned an invalid D1 database list.")
  return parsed
}

async function run(command) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(wrangler, command, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("exit", (code) => code === 0 ? resolveRun(stdout) : reject(new Error(`Wrangler ${command.slice(0, 2).join(" ")} failed with status ${code}: ${stderr}`)))
  })
}

function parseJsonc(value) {
  return JSON.parse(value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1"))
}
