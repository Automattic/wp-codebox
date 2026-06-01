import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

interface SandboxDatamachineToolPolicy {
  schema: string
  version: number
  safeTools: string[]
  parentOnlyTools: string[]
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function tsArray(name: string, values: string[]): string {
  return `export const ${name} = [\n${values.map((value) => `  ${JSON.stringify(value)},`).join("\n")}\n] as const`
}

function phpArray(values: string[]): string {
  return values.map((value) => `\t\t'${value}',`).join("\n")
}

function renderTypeScript(policy: SandboxDatamachineToolPolicy): string {
  return `// Generated from packages/sandbox-datamachine-tool-policy.json. Run npm run sandbox-tool-policy-smoke after edits.
export const SANDBOX_DATAMACHINE_TOOL_POLICY_SCHEMA = ${JSON.stringify(policy.schema)} as const
export const SANDBOX_DATAMACHINE_TOOL_POLICY_VERSION = ${policy.version} as const

${tsArray("SANDBOX_DMC_SAFE_ABILITIES", policy.safeTools)}

${tsArray("SANDBOX_DMC_PARENT_ONLY_ABILITIES", policy.parentOnlyTools)}
`
}

function renderPhp(policy: SandboxDatamachineToolPolicy): string {
  return `<?php
/**
 * Generated sandbox Data Machine tool policy.
 *
 * Source: packages/sandbox-datamachine-tool-policy.json.
 *
 * @package WPCodebox
 */

return array(
\t'schema' => '${policy.schema}',
\t'version' => ${policy.version},
\t'safe_tools' => array(
${phpArray(policy.safeTools)}
\t),
\t'parent_only_tools' => array(
${phpArray(policy.parentOnlyTools)}
\t),
);
`
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

const unbridgedGitTools = [
  "datamachine/workspace-apply-patch",
  "datamachine/workspace-git-status",
  "datamachine/workspace-git-log",
  "datamachine/workspace-git-diff",
]

async function main(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  const policyPath = join(root, "packages", "sandbox-datamachine-tool-policy.json")
  const tsPath = join(root, "packages", "runtime-core", "src", "sandbox-datamachine-tool-policy.ts")
  const phpPath = join(root, "packages", "wordpress-plugin", "src", "generated-sandbox-datamachine-tool-policy.php")
  const policy = JSON.parse(await readFile(policyPath, "utf8")) as SandboxDatamachineToolPolicy

  assert(policy.schema === "wp-codebox/sandbox-datamachine-tool-policy/v1", "Unexpected sandbox tool policy schema")
  assert(policy.version === 1, "Unexpected sandbox tool policy version")
  assert(Array.isArray(policy.safeTools) && policy.safeTools.length > 0, "safeTools must be a non-empty array")
  assert(Array.isArray(policy.parentOnlyTools) && policy.parentOnlyTools.length > 0, "parentOnlyTools must be a non-empty array")
  assert(unique(policy.safeTools).length === policy.safeTools.length, "safeTools must not contain duplicates")
  assert(unique(policy.parentOnlyTools).length === policy.parentOnlyTools.length, "parentOnlyTools must not contain duplicates")
  assert(policy.safeTools.every((tool) => tool.startsWith("datamachine/")), "safeTools must be Data Machine tools")
  assert(policy.parentOnlyTools.every((tool) => tool.startsWith("datamachine/")), "parentOnlyTools must be Data Machine tools")

  const overlap = policy.safeTools.filter((tool) => policy.parentOnlyTools.includes(tool))
  assert(overlap.length === 0, `Sandbox safe and parent-only policies overlap: ${overlap.join(", ")}`)
  const unsafeGitTools = policy.safeTools.filter((tool) => unbridgedGitTools.includes(tool))
  assert(unsafeGitTools.length === 0, `Sandbox safe policy includes unbridged git tools: ${unsafeGitTools.join(", ")}`)
  const missingParentOnlyGitTools = unbridgedGitTools.filter((tool) => !policy.parentOnlyTools.includes(tool))
  assert(missingParentOnlyGitTools.length === 0, `Unbridged git tools must be parent-only: ${missingParentOnlyGitTools.join(", ")}`)

  const expectedTs = renderTypeScript(policy)
  const expectedPhp = renderPhp(policy)
  const actualTs = await readFile(tsPath, "utf8")
  const actualPhp = await readFile(phpPath, "utf8")

  assert(actualTs === expectedTs, `${tsPath} has drifted from ${policyPath}`)
  assert(actualPhp === expectedPhp, `${phpPath} has drifted from ${policyPath}`)
}

await main()
