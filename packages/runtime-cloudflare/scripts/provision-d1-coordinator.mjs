import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const packageRoot = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const databaseName = option("--database-name", "wp-codebox-runtime-state")
const binding = option("--binding", "WORDPRESS_STATE_DATABASE")
const templatePath = resolve(option("--template", resolve(packageRoot, "wrangler.d1.jsonc")))
const outputPath = resolve(option("--output"))
const wrangler = option("--wrangler", resolve(packageRoot, "node_modules/.bin/wrangler"))
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
if (typeof template.main === "string" && !template.main.startsWith("/")) template.main = resolve(dirname(templatePath), template.main)
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
    const child = spawn(wrangler, command, { cwd: packageRoot, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"] })
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

function childEnvironment() { return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "NODE_OPTIONS" || !value?.includes("register-package-local-loader"))) }

function parseJsonc(value) {
  let output = ""
  let string = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    const next = value[index + 1]
    if (lineComment) {
      if (character === "\n") { lineComment = false; output += character }
      continue
    }
    if (blockComment) {
      if (character === "*" && next === "/") { blockComment = false; index++ }
      else if (character === "\n") output += character
      continue
    }
    if (string) {
      output += character
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') string = false
      continue
    }
    if (character === '"') { string = true; output += character }
    else if (character === "/" && next === "/") { lineComment = true; index++ }
    else if (character === "/" && next === "*") { blockComment = true; index++ }
    else output += character
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, "$1"))
}
