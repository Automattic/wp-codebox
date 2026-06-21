import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const abilitiesPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-abilities.php", "utf8")
const descriptorsPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-browser-ability-descriptors.php", "utf8")

const taskAliases = new Map([
  ["wp-codebox/run-sandbox-task", { canonical: "wp-codebox/run-agent-task", canonicalVar: "run_agent_task_ability", aliasVar: "run_sandbox_task_ability", callback: "run_agent_task" }],
  ["wp-codebox/run-sandbox-task-batch", { canonical: "wp-codebox/run-agent-task-batch", canonicalVar: "run_agent_task_batch_ability", aliasVar: "run_sandbox_task_batch_ability", callback: "run_agent_task_batch" }],
  ["wp-codebox/run-sandbox-task-fanout", { canonical: "wp-codebox/run-agent-task-fanout", canonicalVar: "run_agent_task_fanout_ability", aliasVar: "run_sandbox_task_fanout_ability", callback: "run_agent_task_fanout" }],
])

for (const [alias, expectation] of taskAliases) {
  assert.match(abilitiesPhp, new RegExp(`wp_register_ability\\(\\s*'${alias}',\\s*\\$${expectation.aliasVar}\\s*\\)`))
  assert.match(abilitiesPhp, new RegExp(`\\$${expectation.aliasVar}\\s*=\\s*\\$${expectation.canonicalVar};`))
  assert.match(abilitiesPhp, new RegExp(`\\$${expectation.aliasVar}\\['meta'\\]\\s*=\\s*array\\([\\s\\S]*'canonical_ability'\\s*=>\\s*'${expectation.canonical}'[\\s\\S]*'alias_of'\\s*=>\\s*'${expectation.canonical}'[\\s\\S]*\\);`))
  assert.match(abilitiesPhp, new RegExp(`\\$${expectation.canonicalVar}\\s*=\\s*array\\([\\s\\S]*'execute_callback'\\s*=>\\s*array\\(\\s*self::class,\\s*'${expectation.callback}'\\s*\\)`))
}

const browserAliases = new Map([
  ["wp-codebox/create-sandbox-session", "wp-codebox/create-browser-playground-session"],
  ["wp-codebox/create-task-contract", "wp-codebox/create-browser-task-contract"],
  ["wp-codebox/open-contained-runtime", "wp-codebox/open-or-create-browser-contained-site"],
])

for (const [alias, canonical] of browserAliases) {
  assert.match(descriptorsPhp, new RegExp(`'${alias}'\\s*=>\\s*array\\(`))
  assert.match(descriptorsPhp, new RegExp(`'canonical'\\s*=>\\s*'${canonical}'`))
}

assert.match(descriptorsPhp, /\$descriptors\[\s*\$ability_id\s*\]\s*=\s*\$descriptors\[\s*\$canonical\s*\]/)
assert.match(descriptorsPhp, /'canonical_ability'\s*=>\s*\$canonical/)
assert.match(descriptorsPhp, /'alias_of'\s*=>\s*\$canonical/)
assert.doesNotMatch(abilitiesPhp + descriptorsPhp, /datamachine|data machine/i)

console.log("public ability aliases ok")
