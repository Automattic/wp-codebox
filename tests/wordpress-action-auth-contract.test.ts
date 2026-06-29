import assert from "node:assert/strict"
import { commandRegistry } from "../packages/runtime-core/src/command-registry.js"
import { runtimeDiscoveryPhpCode, runtimeDiscoverySurfacesFromArgs } from "../packages/runtime-playground/src/runtime-discovery-command-handlers.js"
import { wordpressActionAuthNoncePhpCode, wordpressUserSessionFromCommandArgs } from "../packages/runtime-playground/src/wordpress-user-sessions.js"
import type { RuntimeCreateSpec } from "../packages/runtime-core/src/runtime-contracts.js"

const authCommands = ["wordpress.session", "wordpress.nonce", "wordpress.action-auth"]

for (const commandId of authCommands) {
  const command = commandRegistry.find((definition) => definition.id === commandId)
  assert.ok(command, `${commandId} is registered`)
  assert.equal(command?.recipe, true, `${commandId} is recipe-visible`)
  assert.equal(command?.handler.kind, "playground", `${commandId} has a Playground handler`)
  assert.ok(command?.acceptedArgs.some((arg) => arg.name === "user"), `${commandId} accepts explicit fixture user selectors`)
  assert.ok(command?.acceptedArgs.some((arg) => arg.name === "session"), `${commandId} accepts explicit session selectors`)
  assert.ok(command?.acceptedArgs.some((arg) => arg.name === "role"), `${commandId} accepts explicit role selectors`)
  assert.match(command?.outputShape ?? "", /redact|artifact refs|redaction/i, `${commandId} documents redacted output`)
}

const sessionCommand = commandRegistry.find((definition) => definition.id === "wordpress.session")
assert.equal(sessionCommand?.outputSchema?.id, "wp-codebox/wordpress-session/v1")
assert.ok(sessionCommand?.outputSchema?.jsonSchema)

const nonceCommand = commandRegistry.find((definition) => definition.id === "wordpress.nonce")
assert.equal(nonceCommand?.outputSchema?.id, "wp-codebox/wordpress-nonce/v1")
assert.ok(nonceCommand?.acceptedArgs.some((arg) => arg.name === "action"), "nonce command accepts explicit action")

const actionAuthCommand = commandRegistry.find((definition) => definition.id === "wordpress.action-auth")
assert.equal(actionAuthCommand?.outputSchema?.id, "wp-codebox/wordpress-action-auth/v1")
assert.ok(actionAuthCommand?.acceptedArgs.some((arg) => arg.name === "browser-urls"), "action-auth can materialize browser auth for explicit URLs")

assert.deepEqual(runtimeDiscoverySurfacesFromArgs(["surface=auth"]), ["auth"])
const discoveryPhp = runtimeDiscoveryPhpCode(["auth"])
assert.match(discoveryPhp, /wp-codebox\/wordpress-auth-discovery\/v1/)
assert.match(discoveryPhp, /wordpress\.session/)
assert.match(discoveryPhp, /wordpress\.nonce/)
assert.match(discoveryPhp, /wordpress\.action-auth/)
assert.match(discoveryPhp, /browserStorageStateArtifacts/)
assert.match(discoveryPhp, /artifact-ref-only/)
assert.match(discoveryPhp, /redacted-in-summary/)

const runtimeSpec = {
  metadata: {
    recipe: {
      schema: "wp-codebox/workspace-recipe/v1",
      inputs: {
        fixtureUsers: [{ name: "admin", username: "fixture-admin", role: "administrator", password: "secret-password" }],
        userSessions: [{ name: "admin-session", user: "admin", artifacts: [{ kind: "browser-storage-state", path: "files/auth/storage-state.json" }] }],
      },
    },
  },
} as RuntimeCreateSpec

const session = wordpressUserSessionFromCommandArgs(["session=admin-session"], runtimeSpec)
assert.ok(session, "named sessions resolve through the public selector")
assert.equal(session?.metadata.user.role, "administrator")
assert.equal(session?.metadata.redactionRequired, true)
assert.doesNotMatch(JSON.stringify(session?.metadata), /secret-password/)

const noncePhp = wordpressActionAuthNoncePhpCode("wordpress.action-auth", "delete_post_123", session)
assert.match(noncePhp, /wp_set_current_user\( \$sandbox_user_id \)/)
assert.match(noncePhp, /wp_create_nonce\( \$wp_codebox_action_auth_action \)/)
assert.match(noncePhp, /wp_create_nonce\( 'wp_rest' \)/)
assert.match(noncePhp, /wp-codebox\/wordpress-action-auth-secret\/v1/)
assert.doesNotMatch(noncePhp, /secret-password/)

console.log("wordpress action auth public contract ok")
