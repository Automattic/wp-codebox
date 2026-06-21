import assert from "node:assert/strict"

import {
  SECRET_ENV_PROJECTIONS_ENV,
  defaultRecipeSecretEnvProviders,
  parseSecretEnvProjections,
  resolveRecipeSecretEnv,
  type RecipeSecretEnvProvider,
} from "../packages/cli/src/recipe-secret-env.js"
import { planWorkspaceRecipe } from "../packages/cli/src/recipe-dry-run.js"

const source = {
  DIRECT_SECRET: "direct-value-123",
  RUNNER_PROJECTED_SECRET: "projected-value-456",
  [SECRET_ENV_PROJECTIONS_ENV]: JSON.stringify({ PROJECTED_SECRET: "RUNNER_PROJECTED_SECRET" }),
}

const resolved = resolveRecipeSecretEnv(["DIRECT_SECRET", "PROJECTED_SECRET", "MISSING_SECRET"], { source })

assert.deepEqual(resolved.values, {
  DIRECT_SECRET: "direct-value-123",
  PROJECTED_SECRET: "projected-value-456",
})
assert.deepEqual(resolved.summary, [
  { name: "DIRECT_SECRET", status: "available", source: "process-env" },
  { name: "PROJECTED_SECRET", status: "available", source: "env-projection" },
  { name: "MISSING_SECRET", status: "missing" },
])
assert.doesNotMatch(JSON.stringify(resolved.summary), /direct-value-123|projected-value-456/)

const customProvider: RecipeSecretEnvProvider = (name) => name === "DERIVED_SECRET"
  ? { value: `derived:${name.toLowerCase()}`, source: "test-provider" }
  : undefined
const customResolved = resolveRecipeSecretEnv(["DERIVED_SECRET"], { source: {}, providers: [customProvider] })
assert.deepEqual(customResolved.values, { DERIVED_SECRET: "derived:derived_secret" })
assert.deepEqual(customResolved.summary, [{ name: "DERIVED_SECRET", status: "available", source: "test-provider" }])

assert.deepEqual([...parseSecretEnvProjections(JSON.stringify([
  { name: "ARRAY_PROJECTED_SECRET", from: "RUNNER_PROJECTED_SECRET" },
]))], [["ARRAY_PROJECTED_SECRET", "RUNNER_PROJECTED_SECRET"]])

assert.equal(defaultRecipeSecretEnvProviders(source).length, 2)
assert.throws(() => parseSecretEnvProjections(JSON.stringify({ bad: "RUNNER_PROJECTED_SECRET" })), /WP_CODEBOX_SECRET_ENV_PROJECTIONS/)

const previousProjection = process.env[SECRET_ENV_PROJECTIONS_ENV]
const previousRunnerSecret = process.env.RUNNER_DRY_RUN_SECRET
try {
  process.env[SECRET_ENV_PROJECTIONS_ENV] = JSON.stringify({ DRY_RUN_SECRET: "RUNNER_DRY_RUN_SECRET" })
  process.env.RUNNER_DRY_RUN_SECRET = "dry-run-secret-value-789"
  const plan = await planWorkspaceRecipe({
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: { secretEnv: ["DRY_RUN_SECRET"] },
    workflow: { steps: [{ command: "wordpress.run-php", args: ["code=<?php echo 'ok';"] }] },
  }, process.cwd(), { recipePath: "recipe.json" }, {
    defaultWordPressVersion: "latest",
    resolveExecutionSpec: async (step) => ({ command: step.command, args: step.args ?? [] }),
  })

  assert.deepEqual(plan.secretEnv, [{ name: "DRY_RUN_SECRET", available: true, status: "available", source: "env-projection" }])
  assert.doesNotMatch(JSON.stringify(plan.secretEnv), /dry-run-secret-value-789/)
} finally {
  if (previousProjection === undefined) {
    delete process.env[SECRET_ENV_PROJECTIONS_ENV]
  } else {
    process.env[SECRET_ENV_PROJECTIONS_ENV] = previousProjection
  }
  if (previousRunnerSecret === undefined) {
    delete process.env.RUNNER_DRY_RUN_SECRET
  } else {
    process.env.RUNNER_DRY_RUN_SECRET = previousRunnerSecret
  }
}
