import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { access, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { normalizePlaygroundSqlitePackage } from "./normalize-playground-sqlite-package.mjs"

const repoRoot = resolve(import.meta.dirname, "..")
const requireFromRepo = createRequire(join(repoRoot, "package.json"))
const wordpressBuildsRoot = dirname(requireFromRepo.resolve("@wp-playground/wordpress-builds/package.json"))
const sqliteDirectory = join(wordpressBuildsRoot, "src", "sqlite-database-integration")
const source = join(sqliteDirectory, "sqlite-database-integration.zip")
const target = join(sqliteDirectory, "sqlite-database-integration-trunk.zip")

await access(source)
await unlink(target).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") {
    throw error
  }
})

const result = await normalizePlaygroundSqlitePackage(requireFromRepo)

assert.equal(result.status, "created", "Codebox should create Playground's trunk SQLite package alias")
await access(target)

const existing = await normalizePlaygroundSqlitePackage(requireFromRepo)
assert.equal(existing.status, "present", "Codebox should treat an existing Playground SQLite alias as reusable")

console.log("Playground SQLite alias smoke passed")
