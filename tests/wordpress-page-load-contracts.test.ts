import assert from "node:assert/strict"
import {
  WORDPRESS_PAGE_LOAD_RESULT_SCHEMA,
  wordpressPageLoadResult,
} from "../packages/runtime-core/src/index.js"
import { getCommandDefinition } from "../packages/runtime-core/src/contracts.js"

const result = wordpressPageLoadResult({
  mode: "simulated",
  command: "wordpress.frontend-page-load",
  status: "ok",
  target: { kind: "frontend", path: "/hello-world/", method: "GET" },
  identity: { path: "/hello-world/", queriedObjectId: 7, postType: "post" },
  performance: {
    schema: "wp-codebox/performance-observation/v1",
    command: "wordpress.frontend-page-load",
    target: "/hello-world/",
    database: { queryCount: 3, totalTimeMs: 1.25, fingerprints: [], repeatedQueries: [] },
    hooks: { timings: [] },
  },
  artifactRefs: [{ path: "files/commands/page-load.json", kind: "wordpress-page-load-result", contentType: "application/json" }],
})

assert.equal(result.schema, WORDPRESS_PAGE_LOAD_RESULT_SCHEMA)
assert.equal(result.mode, "simulated")
assert.equal(result.command, "wordpress.frontend-page-load")
assert.equal(result.status, "ok")
assert.equal(result.performance?.database?.queryCount, 3)
assert.equal(result.artifactRefs?.[0]?.kind, "wordpress-page-load-result")

const adminDefinition = getCommandDefinition("wordpress.admin-page-load")
assert.equal(adminDefinition?.outputSchema?.id, WORDPRESS_PAGE_LOAD_RESULT_SCHEMA)
assert.equal(adminDefinition?.handler.kind, "playground")
assert.equal(adminDefinition?.handler.kind === "playground" ? adminDefinition.handler.method : undefined, "runAdminPageLoad")
assert.equal(adminDefinition?.acceptedArgs.some((arg) => arg.name === "capture-diagnostics"), true)

const frontendDefinition = getCommandDefinition("wordpress.frontend-page-load")
assert.equal(frontendDefinition?.outputSchema?.id, WORDPRESS_PAGE_LOAD_RESULT_SCHEMA)
assert.equal(frontendDefinition?.handler.kind, "playground")
assert.equal(frontendDefinition?.handler.kind === "playground" ? frontendDefinition.handler.method : undefined, "runFrontendPageLoad")

const serverDefinition = getCommandDefinition("wordpress.server-page-load")
assert.equal(serverDefinition?.outputSchema?.id, WORDPRESS_PAGE_LOAD_RESULT_SCHEMA)
assert.match(serverDefinition?.outputShape ?? "", /mode=server-http/)

const browserDefinition = getCommandDefinition("wordpress.browser-page-load")
assert.equal(browserDefinition?.outputSchema?.id, WORDPRESS_PAGE_LOAD_RESULT_SCHEMA)
assert.match(browserDefinition?.outputShape ?? "", /mode=browser/)

console.log("wordpress page-load contracts passed")
