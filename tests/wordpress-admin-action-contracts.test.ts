import assert from "node:assert/strict"
import test from "node:test"
import { getCommandDefinition } from "../packages/runtime-core/src/command-registry.js"
import {
  normalizeWordPressAdminActionContract,
  WORDPRESS_ADMIN_ACTION_FAMILY_DESCRIPTORS,
  WORDPRESS_ADMIN_ACTION_RESULT_SCHEMA,
} from "../packages/runtime-core/src/wordpress-admin-action-contracts.js"
import { adminActionInputFromArgs, adminActionPhpCode } from "../packages/runtime-playground/src/admin-action-command-handlers.js"

const destructiveBoundary = {
  disposableRuntime: true,
  destructive: true,
  artifactPolicy: "capture",
  teardown: "discard-runtime",
} as const

test("wordpress.admin-action descriptor exposes destructive boundary and family support", () => {
  const definition = getCommandDefinition("wordpress.admin-action")

  assert.equal(definition?.outputSchema?.id, WORDPRESS_ADMIN_ACTION_RESULT_SCHEMA)
  assert.equal(definition?.handler.kind, "playground")
  assert.equal(definition?.handler.kind === "playground" ? definition.handler.method : undefined, "runAdminAction")
  assert.match(definition?.policyRequirement ?? "", /disposable destructive boundary/)
  assert.deepEqual(WORDPRESS_ADMIN_ACTION_FAMILY_DESCRIPTORS.map((descriptor) => [descriptor.family, descriptor.status]), [
    ["admin-hook", "supported"],
    ["ajax", "supported"],
    ["admin-post", "supported"],
    ["editor", "unsupported"],
    ["browser-random-walk", "unsupported"],
  ])
})

test("wordpress.admin-action requires explicit disposable destructive boundary", () => {
  assert.throws(() => normalizeWordPressAdminActionContract({ family: "admin-hook", hook: "admin_init" }), /destructiveBoundary/)

  const contract = normalizeWordPressAdminActionContract({ family: "ajax", action: "save-widget", destructiveBoundary })
  assert.equal(contract.schema, "wp-codebox/wordpress-admin-action/v1")
  assert.equal(contract.family, "ajax")
  assert.equal(contract.method, "POST")
  assert.deepEqual(contract.destructiveBoundary, destructiveBoundary)
})

test("playground admin action handler emits executable generic hook families", () => {
  const actionJson = JSON.stringify({ family: "admin-post", action: "wp_codebox_contract_probe", body: { value: "1" }, destructiveBoundary })
  const input = adminActionInputFromArgs([`action-json=${actionJson}`])
  const php = adminActionPhpCode(input)

  assert.equal(input.family, "admin-post")
  assert.match(php, /do_action\('admin_post_' \. \$wp_codebox_admin_action_name\)/)
  assert.match(php, /do_action\('wp_ajax_' \. \$wp_codebox_admin_action_name\)/)
  assert.match(php, /do_action\(\$wp_codebox_admin_action_hook\)/)
  assert.match(php, /wp-codebox\/wordpress-admin-action-result\/v1/)
})
