import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { createWorkspaceRecipeJsonSchema, TASK_INPUT_ABILITY_ALIAS_FIELDS, TASK_INPUT_JSON_SCHEMA } from "../packages/runtime-core/src/index.js"

const root = new URL("../", import.meta.url)

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObject(value), null, 2)
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortObject(entry)]))
}

function phpJson(expression: string): unknown {
  const php = spawnSync("php", ["-r", `define('ABSPATH', '${root.pathname.replace(/'/g, "'\\''")}'); require '${root.pathname.replace(/'/g, "'\\''")}packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php'; echo json_encode(${expression}, JSON_UNESCAPED_SLASHES);`], {
    cwd: root.pathname,
    encoding: "utf8",
  })
  assert.equal(php.status, 0, php.stderr)
  return JSON.parse(php.stdout)
}

const phpTaskInputSchema = phpJson("WP_Codebox_Task_Input_Contract::schema()")
assert.equal(canonicalJson(phpTaskInputSchema), canonicalJson(TASK_INPUT_JSON_SCHEMA), "PHP task input schema must match runtime-core TASK_INPUT_JSON_SCHEMA")

const phpAliasFields = phpJson("WP_Codebox_Task_Input_Contract::ABILITY_ALIAS_FIELDS")
assert.deepEqual(phpAliasFields, [...TASK_INPUT_ABILITY_ALIAS_FIELDS], "PHP ability task aliases must match runtime-core alias fields")

const recipeSchema = createWorkspaceRecipeJsonSchema()
const recipeProperties = recipeSchema.properties as Record<string, { properties?: Record<string, unknown> }>
const docs = readFileSync(new URL("../docs/recipe-contract.md", import.meta.url), "utf8")

function documentedFields(section: string): string[] {
  const lines = docs.split("\n")
  const start = lines.findIndex((line) => line.includes(section))
  assert.notEqual(start, -1, `Missing docs field section: ${section}`)
  const fields: string[] = []
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^- `([^`]+)`/)
    if (match) {
      fields.push(match[1])
      continue
    }
    if (fields.length > 0 && line.trim() === "") break
  }
  return fields
}

assert.deepEqual(documentedFields("top-level fields"), Object.keys(recipeProperties), "Recipe docs top-level field list must match runtime-core schema")
assert.deepEqual(documentedFields("`inputs` accepts these fields"), Object.keys(recipeProperties.inputs.properties ?? {}), "Recipe docs inputs field list must match runtime-core schema")

console.log("schema parity ok")
