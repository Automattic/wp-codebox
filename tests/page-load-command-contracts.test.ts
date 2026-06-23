import assert from "node:assert/strict"
import { getCommandDefinition } from "../packages/runtime-core/src/contracts.js"
import { httpRequestInputFromArgs } from "../packages/runtime-playground/src/commands.js"
import { pageLoadInputFromArgs } from "../packages/runtime-playground/src/page-load-command-handlers.js"
import { wordpressBrowserPageLoadAction, wordpressServerPageLoadAction, wordpressSimulatedAdminPageLoadAction, wordpressSimulatedFrontendPageLoadAction } from "../packages/runtime-playground/src/public.js"

const adminAlias = getCommandDefinition("wordpress.admin-page-load")
const simulatedAdmin = getCommandDefinition("wordpress.simulated-admin-page-load")
const frontendAlias = getCommandDefinition("wordpress.frontend-page-load")
const simulatedFrontend = getCommandDefinition("wordpress.simulated-frontend-page-load")
const serverPageLoad = getCommandDefinition("wordpress.server-page-load")
const browserPageLoad = getCommandDefinition("wordpress.browser-page-load")

assert.equal(adminAlias?.handler.kind, "playground")
assert.equal(adminAlias?.handler.method, "runAdminPageLoad")
assert.match(adminAlias?.description ?? "", /Backward-compatible alias/)
assert.equal(simulatedAdmin?.handler.kind, "playground")
assert.equal(simulatedAdmin?.handler.method, "runAdminPageLoad")

assert.equal(frontendAlias?.handler.kind, "playground")
assert.equal(frontendAlias?.handler.method, "runFrontendPageLoad")
assert.match(frontendAlias?.description ?? "", /Backward-compatible alias/)
assert.equal(simulatedFrontend?.handler.kind, "playground")
assert.equal(simulatedFrontend?.handler.method, "runFrontendPageLoad")

assert.equal(serverPageLoad?.handler.kind, "playground")
assert.equal(serverPageLoad?.handler.method, "runServerPageLoad")
assert.match(serverPageLoad?.outputShape ?? "", /mode=server-http/)

assert.equal(browserPageLoad?.handler.kind, "playground")
assert.equal(browserPageLoad?.handler.method, "runBrowserPageLoad")
assert.equal(browserPageLoad?.outputSchema?.id, "wp-codebox/wordpress-page-load-result/v1")
assert.equal(browserPageLoad?.validation, undefined)

assert.equal(pageLoadInputFromArgs([], "admin").command, "wordpress.simulated-admin-page-load")
assert.equal(pageLoadInputFromArgs([], "frontend").command, "wordpress.simulated-frontend-page-load")
assert.equal(pageLoadInputFromArgs([], "admin", "wordpress.admin-page-load").command, "wordpress.admin-page-load")

const httpInput = httpRequestInputFromArgs(["url=/", "expect-status=200"])
assert.equal(httpInput.command, "wordpress.http-request")

assert.deepEqual(wordpressSimulatedAdminPageLoadAction({ path: "index.php" }), { command: "wordpress.simulated-admin-page-load", args: ["path=index.php"] })
assert.deepEqual(wordpressSimulatedFrontendPageLoadAction({ path: "/shop" }), { command: "wordpress.simulated-frontend-page-load", args: ["path=/shop"] })
assert.deepEqual(wordpressServerPageLoadAction({ surface: "admin", path: "edit.php" }), { command: "wordpress.server-page-load", args: ["path=edit.php", "surface=admin"] })
assert.deepEqual(wordpressBrowserPageLoadAction({ surface: "frontend", path: "/" }), { command: "wordpress.browser-page-load", args: ["path=/", "surface=frontend"] })

console.log("page-load command contracts ok")
