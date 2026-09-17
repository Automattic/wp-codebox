import assert from "node:assert/strict"

import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"

/*
 * Playground's enableMultisite step leaves site_admins as an empty string
 * instead of array( $admin_login ). Because the option exists, core's
 * get_site_option( 'site_admins', array( 'admin' ) ) default never applies, and
 * the empty string reaches in_array() — fatalling is_super_admin(),
 * grant_super_admin() and every manage_network_* check inside core.
 *
 * A multisite recipe must therefore carry a repair step, ordered after
 * enableMultisite.
 */
const recipe = buildWordPressPhpunitRecipe({
  pluginSlug: "example-plugin",
  multisite: true,
  mounts: [],
} as never) as { runtime?: { blueprint?: { steps?: Array<{ step?: string; code?: string }> } } }

const steps = recipe.runtime?.blueprint?.steps ?? []
const names = steps.map((step) => step.step)

assert.ok(names.includes("enableMultisite"), `expected enableMultisite, got ${JSON.stringify(names)}`)

const repairIndex = steps.findIndex(
  (step) => step.step === "runPHP" && typeof step.code === "string" && step.code.includes("site_admins"),
)
assert.ok(repairIndex >= 0, `expected a runPHP site_admins repair step, got ${JSON.stringify(names)}`)
assert.ok(
  names.indexOf("enableMultisite") < repairIndex,
  "site_admins repair must run after enableMultisite",
)

const repairCode = steps[repairIndex]?.code ?? ""
assert.ok(repairCode.includes("is_array"), "repair must only write when the value is not already a valid array")
assert.ok(repairCode.includes("admin_user_id"), "repair should derive the login from admin_user_id, not assume 'admin'")

// Single-site recipes must not carry multisite steps at all.
const single = buildWordPressPhpunitRecipe({ pluginSlug: "example-plugin", multisite: false, mounts: [] } as never) as {
  runtime?: { blueprint?: { steps?: Array<{ step?: string }> } }
}
const singleNames = (single.runtime?.blueprint?.steps ?? []).map((step) => step.step)
assert.ok(!singleNames.includes("enableMultisite"), "single-site recipe must not enable multisite")

console.log("multisite site_admins repair step present, ordered, and single-site unaffected")
