import { copyFile, mkdir, access } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const rootPackageUrl = pathToFileURL(join(process.cwd(), "package.json"))
const requireFromRoot = createRequire(rootPackageUrl)

const result = await normalizePlaygroundSqlitePackage(requireFromRoot)

if (process.env.WP_CODEBOX_PLAYGROUND_SQLITE_ALIAS_DEBUG === "1") {
  console.log(JSON.stringify(result))
}

export async function normalizePlaygroundSqlitePackage(requireFrom = requireFromRoot) {
  const wordpressBuildsRoot = await resolvePackageRoot(requireFrom, "@wp-playground/wordpress-builds")
  if (!wordpressBuildsRoot) {
    return { status: "skipped", reason: "@wp-playground/wordpress-builds is not installed" }
  }

  const sqliteDirectory = join(wordpressBuildsRoot, "src", "sqlite-database-integration")
  const target = join(sqliteDirectory, "sqlite-database-integration-trunk.zip")
  if (await exists(target)) {
    return { status: "present", path: target }
  }

  const cliRoot = await resolvePackageRoot(requireFrom, "@wp-playground/cli")
  const source = await firstExisting([
    join(sqliteDirectory, "sqlite-database-integration.zip"),
    cliRoot ? join(cliRoot, "sqlite-database-integration.zip") : undefined,
  ])

  if (!source) {
    return { status: "skipped", reason: "Playground SQLite package source was not found" }
  }

  await mkdir(sqliteDirectory, { recursive: true })
  await copyFile(source, target)

  return { status: "created", source, path: target }
}

async function resolvePackageRoot(requireFrom, packageName) {
  try {
    return dirname(requireFrom.resolve(`${packageName}/package.json`))
  } catch {
    return undefined
  }
}

async function firstExisting(paths) {
  for (const path of paths) {
    if (path && await exists(path)) {
      return path
    }
  }

  return undefined
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
