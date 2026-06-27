import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const abilitiesPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-abilities.php", "utf8")
const descriptorsPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-browser-ability-descriptors.php", "utf8")
const schemasPhp = await readFile("packages/wordpress-plugin/src/trait-wp-codebox-abilities-schemas.php", "utf8")
const apiPhp = await readFile("packages/wordpress-plugin/src/class-wp-codebox-api.php", "utf8")

const taskAbilities = new Map([
  ["wp-codebox/run-agent-task", { variable: "run_agent_task_ability", callback: "run_agent_task" }],
  ["wp-codebox/run-agent-task-batch", { variable: "run_agent_task_batch_ability", callback: "run_agent_task_batch" }],
  ["wp-codebox/run-agent-task-fanout", { variable: "run_agent_task_fanout_ability", callback: "run_agent_task_fanout" }],
])

for (const [ability, expectation] of taskAbilities) {
  assert.match(abilitiesPhp, new RegExp(`wp_register_ability\\(\\s*'${ability}',\\s*\\$${expectation.variable}\\s*\\)`))
  assert.match(abilitiesPhp, new RegExp(`\\$${expectation.variable}\\s*=\\s*array\\([\\s\\S]*'execute_callback'\\s*=>\\s*array\\(\\s*self::class,\\s*'${expectation.callback}'\\s*\\)`))
}

for (const removedAlias of ["wp-codebox/run-sandbox-task", "wp-codebox/run-sandbox-task-batch", "wp-codebox/run-sandbox-task-fanout"]) {
  assert.doesNotMatch(abilitiesPhp, new RegExp(`wp_register_ability\\(\\s*'${removedAlias}'`))
}

assert.match(abilitiesPhp, /wp_register_ability\(\s*'wp-codebox\/run-runtime-task'/)
assert.match(abilitiesPhp, /'execute_callback'\s*=>\s*array\(\s*self::class,\s*'run_runtime_task'\s*\)/)
assert.match(schemasPhp, /'schema'\s*=>\s*array\(\s*'type'\s*=>\s*'string',\s*'const'\s*=>\s*'wp-codebox\/runtime-task-request\/v1'\s*\)/)
assert.match(schemasPhp, /'schema'\s*=>\s*array\(\s*'type'\s*=>\s*'string',\s*'const'\s*=>\s*'wp-codebox\/runtime-task-result\/v1'\s*\)/)

for (const canonical of ["wp-codebox/create-browser-playground-session", "wp-codebox/create-browser-task-contract", "wp-codebox/open-or-create-browser-contained-site"]) {
  assert.match(descriptorsPhp, new RegExp(`'${canonical}'\\s*=>\\s*array\\(`))
}

for (const artifactAbility of ["wp-codebox/list-artifacts", "wp-codebox/get-artifact", "wp-codebox/inspect-artifact"]) {
  assert.match(descriptorsPhp, new RegExp(`'${artifactAbility}'\\s*=>\\s*array\\(`))
  assert.match(apiPhp, new RegExp(`'${artifactAbility}'|ABILITY_[A-Z_]+\\s*=\\s*'${artifactAbility}'`))
}

for (const removedAlias of ["wp-codebox/create-sandbox-session", "wp-codebox/create-task-contract", "wp-codebox/open-contained-runtime"]) {
  assert.doesNotMatch(descriptorsPhp, new RegExp(`'${removedAlias}'\\s*=>`))
  assert.doesNotMatch(apiPhp, new RegExp(`'${removedAlias}'\\s*=>`))
}

assert.match(abilitiesPhp, /wp_register_ability\(\s*'wp-codebox\/run-runtime-package'/)
assert.match(abilitiesPhp, /'execute_callback'\s*=>\s*array\(\s*self::class,\s*'run_runtime_package'\s*\)/)
assert.match(abilitiesPhp, /'canonical_ability'\s*=>\s*'wp-codebox\/run-runtime-package'/)
assert.doesNotMatch(abilitiesPhp, /wp_register_ability\(\s*'agents\/run-runtime-package'/)
assert.doesNotMatch(abilitiesPhp + descriptorsPhp + schemasPhp, /datamachine|data machine/i)

console.log("public canonical abilities ok")
