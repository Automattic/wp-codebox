import assert from "node:assert/strict"

import { validateWorkspaceRecipeJsonSchema, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { planWorkspaceRecipe } from "../packages/cli/src/recipe-dry-run.js"
import { recipeExternalServiceBoundarySummaries, correlateObservedHostsToExternalServiceBoundaries } from "../packages/cli/src/recipe-external-services.js"
import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    secretEnv: ["GLOBAL_SERVICE_TOKEN"],
    externalServices: [
      {
        id: "checkout-staging",
        label: "Checkout staging API",
        environment: "staging",
        allowedHosts: ["API.EXAMPLE.test:443"],
        blockedHosts: ["prod.example.test"],
        writes: "record-only",
        secretEnv: ["CHECKOUT_API_TOKEN"],
        redaction: { policy: "redact-fields", fields: ["authorization", "set-cookie"] },
        metadata: { owner: "payments" },
      },
    ],
  },
  workflow: { steps: [{ command: "wordpress.run-php", args: ["code=<?php echo 'ok';"] }] },
}

assert.equal(validateWorkspaceRecipeJsonSchema(recipe).valid, true)
assert.deepEqual(await validateWorkspaceRecipeSemantics(recipe, "recipe.json"), [])

const summaries = recipeExternalServiceBoundarySummaries(recipe)
assert.deepEqual(summaries, [
  {
    schema: "wp-codebox/external-service-boundary-summary/v1",
    id: "checkout-staging",
    label: "Checkout staging API",
    environment: "staging",
    allowedHosts: ["api.example.test"],
    blockedHosts: ["prod.example.test"],
    writes: "record-only",
    secretEnv: ["CHECKOUT_API_TOKEN"],
    redaction: { policy: "redact-fields", fields: ["authorization", "set-cookie"] },
  },
])
assert.doesNotMatch(JSON.stringify(summaries), /secret-value|GLOBAL_SERVICE_TOKEN=.*|CHECKOUT_API_TOKEN=.*/)

const plan = await planWorkspaceRecipe(recipe, process.cwd(), { recipePath: "recipe.json" }, {
  defaultWordPressVersion: "latest",
  resolveExecutionSpec: async (step) => ({ command: step.command, args: step.args ?? [] }),
})
assert.deepEqual(plan.externalServices, summaries)

const correlation = correlateObservedHostsToExternalServiceBoundaries({
  "api.example.test": { requests: 2, external: true, blocked: 0, routed: 0 },
  "cdn.example.test": { requests: 1, external: true, blocked: 0, routed: 0 },
}, summaries)
assert.deepEqual(correlation, {
  schema: "wp-codebox/external-service-boundary-host-correlation/v1",
  observedHosts: [
    { host: "api.example.test", boundaryIds: ["checkout-staging"], requests: 2, external: true, blocked: 0, routed: 0 },
    { host: "cdn.example.test", boundaryIds: [], requests: 1, external: true, blocked: 0, routed: 0 },
  ],
  unmatchedHosts: ["cdn.example.test"],
})

const invalidRecipe: WorkspaceRecipe = {
  ...recipe,
  inputs: {
    externalServices: [
      { id: "service", environment: "external", writes: "forbidden", allowedHosts: ["https://bad.example.test/path"], secretEnv: ["bad-secret"] },
      { id: "service", environment: "external", writes: "forbidden" },
    ],
  },
}
const invalidIssues = await validateWorkspaceRecipeSemantics(invalidRecipe, "recipe.json")
assert.deepEqual(invalidIssues.map((issue) => issue.code), ["invalid-external-service-host", "invalid-external-service-secret-env", "duplicate-external-service-id"])

console.log("recipe external service boundaries ok")
