import assert from "node:assert/strict"
import { commandRegistry } from "../packages/runtime-core/src/command-registry.js"
import { validateWorkspaceRecipeJsonSchema } from "../packages/runtime-core/src/recipe-schema.js"
import type { RuntimeCreateSpec } from "../packages/runtime-core/src/runtime-contracts.js"
import { abilityPhpCode, abilityPrincipalFromArgs } from "../packages/runtime-playground/src/ability-command-handlers.js"
import { restRequestPhpCode } from "../packages/runtime-playground/src/rest-request-command-handlers.js"
import { wordpressFixtureUserPhpCode, wordpressUserSessionFromCommandArgs } from "../packages/runtime-playground/src/wordpress-user-sessions.js"

const recipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    fixtureUsers: [
      { name: "admin", username: "fixture-admin", email: "fixture-admin@example.test", role: "administrator", password: "super-secret-password" },
      { name: "editor", username: "fixture-editor", role: "editor" },
    ],
    userSessions: [
      {
        name: "admin-browser",
        user: "admin",
        artifacts: [
          { kind: "browser-storage-state", path: "files/browser-storage-state/storage-state.json", redactionRequired: true },
        ],
      },
    ],
  },
  workflow: { steps: [{ command: "wordpress.rest-request", args: ["path=/wp/v2/users/me", "session=admin-browser"] }] },
}

assert.equal(validateWorkspaceRecipeJsonSchema(recipe).valid, true)

const runtimeSpec = { metadata: { recipe } } as RuntimeCreateSpec
const resolvedSession = wordpressUserSessionFromCommandArgs(["session=admin-browser"], runtimeSpec)
assert.equal(resolvedSession?.source, "session")
assert.equal(resolvedSession?.metadata.user.username, "fixture-admin")
assert.equal(resolvedSession?.metadata.user.role, "administrator")
assert.equal(resolvedSession?.metadata.redactionRequired, true)
assert.deepEqual(resolvedSession?.metadata.artifacts, [{ kind: "browser-storage-state", path: "files/browser-storage-state/storage-state.json", redactionRequired: true }])
assert.doesNotMatch(JSON.stringify(resolvedSession?.metadata), /super-secret-password/)

const resolvedUser = wordpressUserSessionFromCommandArgs(["user=editor"], runtimeSpec)
assert.equal(resolvedUser?.source, "user")
assert.equal(resolvedUser?.metadata.user.username, "fixture-editor")
assert.equal(resolvedUser?.metadata.user.role, "editor")
assert.equal(resolvedUser?.metadata.redactionRequired, false)

assert.throws(() => wordpressUserSessionFromCommandArgs(["session=missing"], runtimeSpec), /Unknown WordPress recipe user session/)
assert.throws(() => wordpressUserSessionFromCommandArgs(["user=missing"], runtimeSpec), /Unknown WordPress recipe fixture user/)

const fixtureUserPhp = wordpressFixtureUserPhpCode({ role: "administrator" })
assert.match(fixtureUserPhp, /sandbox_fixture_user/)
assert.doesNotMatch(fixtureUserPhp, /wp_codebox|WP_CODEBOX|wp-codebox-fixture/)

const generated = restRequestPhpCode({
  method: "GET",
  path: "/wp/v2/users/me",
  headers: {},
  params: {},
  body: "",
  userSession: resolvedSession,
})

assert.match(generated, /wp_set_current_user/)
assert.match(generated, /wp-codebox\/wordpress-user-session\/v1/)
assert.match(generated, /'userSession' => is_array/)

const ambientAbilityPhp = abilityPhpCode({ name: "example/ability", input: {} })
assert.doesNotMatch(ambientAbilityPhp, /wp_set_current_user\(\s*1\s*\)/)
assert.match(ambientAbilityPhp, /'source' => is_array\( \$wp_codebox_ability_user_session \) \? \(string\)/)

const sessionAbilityPhp = abilityPhpCode({ name: "example/ability", input: {}, userSession: resolvedSession })
assert.match(sessionAbilityPhp, /wp_set_current_user\( \$sandbox_user_id \)/)
assert.match(sessionAbilityPhp, /wp-codebox\/wordpress-user-session\/v1/)
assert.match(sessionAbilityPhp, /'principal' => \$wp_codebox_ability_principal/)

const principal = abilityPrincipalFromArgs(["principal={\"userId\":7,\"source\":\"runtime\",\"token\":\"secret\"}"])
assert.deepEqual(principal, { userId: 7, metadata: { userId: 7, source: "runtime" } })
const principalAbilityPhp = abilityPhpCode({ name: "example/ability", input: {}, principal })
assert.match(principalAbilityPhp, /wp_set_current_user\( 7 \)/)
assert.doesNotMatch(principalAbilityPhp, /secret/)

const restCommand = commandRegistry.find((definition) => definition.id === "wordpress.rest-request")
assert.ok(restCommand?.acceptedArgs.some((arg) => arg.name === "user"), "rest-request accepts user")
assert.ok(restCommand?.acceptedArgs.some((arg) => arg.name === "session"), "rest-request accepts session")

const abilityCommand = commandRegistry.find((definition) => definition.id === "wordpress.ability")
assert.ok(abilityCommand?.acceptedArgs.some((arg) => arg.name === "user"), "ability accepts user")
assert.ok(abilityCommand?.acceptedArgs.some((arg) => arg.name === "session"), "ability accepts session")
assert.ok(abilityCommand?.acceptedArgs.some((arg) => arg.name === "principal"), "ability accepts principal")
assert.ok(abilityCommand?.acceptedArgs.some((arg) => arg.name === "principal-json"), "ability accepts principal-json")

console.log("recipe user session primitive ok")
