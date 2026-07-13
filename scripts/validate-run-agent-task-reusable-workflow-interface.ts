import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

type InputContract = {
  required: boolean
  type: string
  default?: string | number | boolean
}

type SecretContract = {
  required: boolean
}

type OutputContract = {
  value: string
}

type WorkflowInterface = {
  schema: "wp-codebox/reusable-workflow-interface/v1"
  workflow: string
  inputs: Record<string, InputContract>
  secrets: Record<string, SecretContract>
  outputs: Record<string, OutputContract>
}

type Declaration = Record<string, Record<string, string | number | boolean>>

const repositoryRoot = resolve(process.env.WP_CODEBOX_DIR ?? new URL("..", import.meta.url).pathname)
const fixturePath = resolve(repositoryRoot, "contracts/run-agent-task-reusable-workflow-interface.v1.json")
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as WorkflowInterface

assert.equal(fixture.schema, "wp-codebox/reusable-workflow-interface/v1", "Unexpected reusable workflow interface schema version")
assert.equal(fixture.workflow, ".github/workflows/run-agent-task.yml", "Unexpected reusable workflow path")

function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim()
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed
}

function extractDeclaration(workflow: string, section: "inputs" | "secrets" | "outputs"): Declaration {
  const lines = workflow.split("\n")
  const sectionIndex = lines.findIndex((line) => line === `    ${section}:`)
  assert.notEqual(sectionIndex, -1, `Missing workflow_call ${section} declaration`)

  const declaration: Declaration = {}
  let currentName: string | undefined
  for (const line of lines.slice(sectionIndex + 1)) {
    if (/^    \S/.test(line)) break
    const name = line.match(/^      ([A-Za-z_][A-Za-z0-9_-]*):\s*$/)
    if (name) {
      currentName = name[1]
      declaration[currentName] = {}
      continue
    }
    const property = line.match(/^        ([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (property && currentName) declaration[currentName][property[1]] = parseScalar(property[2])
  }
  return declaration
}

const workflow = await readFile(resolve(repositoryRoot, fixture.workflow), "utf8")
const declaredInputs = extractDeclaration(workflow, "inputs")
const declaredSecrets = extractDeclaration(workflow, "secrets")
const declaredOutputs = extractDeclaration(workflow, "outputs")

const actualInputs = Object.fromEntries(Object.entries(declaredInputs).map(([name, input]) => [name, {
  required: input.required === true,
  type: input.type,
  ...(Object.hasOwn(input, "default") ? { default: input.default } : {}),
}]))
const actualSecrets = Object.fromEntries(Object.entries(declaredSecrets).map(([name, secret]) => [name, {
  required: secret.required === true,
}]))
const actualOutputs = Object.fromEntries(Object.entries(declaredOutputs).map(([name, output]) => [name, {
  value: output.value,
}]))

assert.deepEqual(actualInputs, fixture.inputs, "Reusable workflow inputs diverge from the versioned interface fixture")
assert.deepEqual(actualSecrets, fixture.secrets, "Reusable workflow secrets diverge from the versioned interface fixture")
assert.deepEqual(actualOutputs, fixture.outputs, "Reusable workflow outputs diverge from the versioned interface fixture")

console.log(`run-agent-task reusable workflow interface ${fixture.schema} ok`)
