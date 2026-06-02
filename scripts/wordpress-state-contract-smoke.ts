import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

type JsonObject = Record<string, unknown>

const sectionFixture = JSON.parse(await readFile("fixtures/wordpress-state/wordpress-state-section-v1.json", "utf8")) as JsonObject
const exportFixture = JSON.parse(await readFile("fixtures/wordpress-state/wordpress-state-export-v1.json", "utf8")) as JsonObject

assert.equal(sectionFixture.schema, "wp-codebox/wordpress-state-section/v1")
assert.equal(sectionFixture.version, 1)
assert.equal(sectionFixture.section, "posts")
assert.ok(Array.isArray(sectionFixture.data))

const posts = sectionFixture.data as JsonObject[]
for (const post of posts) {
  assert.equal(typeof post.id, "number")
  assert.equal(typeof post.type, "string")
  assert.equal(typeof post.slug, "string")
  assert.equal(typeof post.status, "string")
  assert.equal(typeof post.title, "string")
  assert.match(String(post.contentHash), /^[a-f0-9]{64}$/)
  assert.equal(typeof post.modifiedGmt, "string")
  if (Object.hasOwn(post, "content")) {
    assert.equal(typeof post.content, "string")
  }
}

assert.equal(exportFixture.schema, "wp-codebox/wordpress-state-export/v1")
assert.equal(exportFixture.version, 1)
assert.equal(typeof exportFixture.generatedAt, "string")
assert.ok(exportFixture.config && typeof exportFixture.config === "object")
assert.ok(exportFixture.sections && typeof exportFixture.sections === "object")
assert.ok(exportFixture.artifacts && typeof exportFixture.artifacts === "object")

const config = exportFixture.config as JsonObject
assert.deepEqual(config.sections, ["summary", "posts", "terms", "menus", "templates", "media", "options", "users"])
assert.equal(config.redaction, "safe")
assert.equal(config.includeContent, true)
assert.deepEqual(config.optionNames, ["blogname"])
assert.deepEqual(config.userFields, ["roles"])

const sections = exportFixture.sections as Record<string, JsonObject>
assert.equal(typeof sections.summary?.siteUrl, "string")
assert.equal(typeof sections.summary?.homeUrl, "string")
assert.equal(typeof sections.summary?.wordpressVersion, "string")
assert.equal(typeof sections.summary?.activeTheme, "string")
assert.ok(Array.isArray(sections.summary?.activePlugins))
assert.ok(sections.summary?.postCounts && typeof sections.summary.postCounts === "object")

for (const section of ["posts", "terms", "menus", "media", "users"]) {
  assert.equal(typeof sections[section]?.count, "number")
}

assert.deepEqual(sections.options?.keys, ["blogname"])
assert.deepEqual(sections.templates?.keys, ["theme", "templates", "templateParts", "globalStyles"])

const artifacts = exportFixture.artifacts as Record<string, JsonObject>
assert.equal(typeof artifacts.posts?.artifact, "string")
assert.match(String(artifacts.posts?.sha256), /^[a-f0-9]{64}$/)
assert.equal(typeof artifacts.posts?.bytes, "number")

console.log("WordPress state contract fixtures passed")
